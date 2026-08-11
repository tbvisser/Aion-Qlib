/**
 * `toWire` -- the translation from what the transcript draws to what the model reads.
 *
 * This exists because the projection it replaces (`{role, content}`) silently
 * dropped every tool call, so a proposal that came back with per-field errors
 * was re-proposed unchanged on the next turn. The model could not see its own
 * mistake.
 *
 * The rule the whole thing rests on is a protocol invariant rather than a
 * preference: an assistant message bearing `tool_calls` MUST be followed by one
 * `tool` message per call, and every `tool` message must answer a call that came
 * before it. OpenAI-compatible APIs reject anything else outright. So the
 * load-bearing test here is the invariant, asserted over every fixture, not the
 * per-case shape checks.
 */
import { describe, expect, it } from 'vitest'

import { toWire, type ChatMessage, type WireMessage } from './chat'

const user = (content: string): ChatMessage => ({ role: 'user', content })

const tool = (id: string, round: number, name: string, result?: unknown) => ({
  id, round, name, arguments: { q: 1 }, result,
})

/** The protocol invariant, as a reusable assertion. */
function assertWellFormed(wire: WireMessage[]) {
  const answered = new Set<string>()
  for (let i = 0; i < wire.length; i++) {
    const message = wire[i]
    if (message.role === 'assistant' && message.tool_calls) {
      // Every call is answered, in order, immediately.
      message.tool_calls.forEach((call, j) => {
        const reply = wire[i + 1 + j]
        expect(reply, `call ${call.id} has no reply`).toBeDefined()
        expect(reply.role).toBe('tool')
        expect(reply.tool_call_id).toBe(call.id)
        answered.add(call.id)
      })
    }
    if (message.role === 'tool') {
      expect(answered.has(message.tool_call_id!),
             `tool ${message.tool_call_id} answers no preceding call`).toBe(true)
    }
  }
}

describe('toWire', () => {
  it('leaves a plain conversation alone', () => {
    const wire = toWire([user('hi'), { role: 'assistant', content: 'hello' }])
    expect(wire).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
    assertWellFormed(wire)
  })

  it('expands one round into call, result, prose', () => {
    const wire = toWire([
      user('how is the data?'),
      { role: 'assistant', content: 'Looks fine.',
        tools: [tool('c1', 0, 'get_data_status', { ready: true })] },
    ])

    expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(wire[1].content).toBeNull()
    expect(wire[1].tool_calls).toEqual([{
      id: 'c1', type: 'function',
      function: { name: 'get_data_status', arguments: '{"q":1}' },
    }])
    expect(wire[2]).toEqual({
      role: 'tool', tool_call_id: 'c1', content: '{"ready":true}',
    })
    expect(wire[3]).toEqual({ role: 'assistant', content: 'Looks fine.' })
    assertWellFormed(wire)
  })

  it('keeps parallel calls in one assistant message', () => {
    // Two calls to the SAME tool in one round. This is the case the old
    // name-based result matching could not represent at all.
    const wire = toWire([
      user('compare two'),
      { role: 'assistant', content: '',
        tools: [tool('c1', 0, 'evaluate_factor', { ic: 0.01 }),
                tool('c2', 0, 'evaluate_factor', { ic: 0.02 })] },
    ])

    expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool'])
    expect(wire[1].tool_calls).toHaveLength(2)
    expect(wire[2].content).toBe('{"ic":0.01}')
    expect(wire[3].content).toBe('{"ic":0.02}')
    assertWellFormed(wire)
  })

  it('splits rounds into separate assistant messages', () => {
    const wire = toWire([
      user('propose something'),
      { role: 'assistant', content: 'Here it is.',
        tools: [tool('c1', 0, 'get_data_status', { ready: true }),
                tool('c2', 1, 'propose_strategy', { spec: {} })] },
    ])

    expect(wire.map((m) => m.role)).toEqual(
      ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])
    expect(wire[1].tool_calls?.[0].id).toBe('c1')
    expect(wire[3].tool_calls?.[0].id).toBe('c2')
    assertWellFormed(wire)
  })

  it('orders rounds even when the tools arrive out of order', () => {
    const wire = toWire([
      user('x'),
      { role: 'assistant', content: '',
        tools: [tool('c2', 1, 'b', {}), tool('c1', 0, 'a', {})] },
    ])
    expect(wire[1].tool_calls?.[0].id).toBe('c1')
    expect(wire[3].tool_calls?.[0].id).toBe('c2')
    assertWellFormed(wire)
  })

  it('still answers a call whose result never arrived', () => {
    // Stopping mid-tool. An assistant message with `tool_calls` and nothing
    // answering them is rejected outright by OpenAI-compatible APIs, so this is
    // the most likely 400 in the whole feature.
    const wire = toWire([
      user('x'),
      { role: 'assistant', content: '', tools: [tool('c1', 0, 'evaluate_factor')] },
    ])

    expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(JSON.parse(wire[2].content!)).toHaveProperty('error')
    assertWellFormed(wire)
  })

  it('carries all the prose, even when it was said around a tool call', () => {
    // The reader inserts \n\n when a tool call interrupts, and model prose can
    // contain \n\n itself -- so the split is unrecoverable and we do not guess.
    // Nothing may be lost, though.
    const said = 'Let me check.\n\nThe data looks fine.'
    const wire = toWire([
      user('x'),
      { role: 'assistant', content: said, tools: [tool('c1', 0, 'get_data_status', {})] },
    ])
    expect(wire.filter((m) => m.role === 'assistant' && m.content).map((m) => m.content))
      .toEqual([said])
    assertWellFormed(wire)
  })

  it('omits an assistant message that said nothing at all', () => {
    const wire = toWire([
      user('x'),
      { role: 'assistant', content: '', tools: [tool('c1', 0, 'a', {})] },
    ])
    expect(wire.filter((m) => m.role === 'assistant' && m.content !== null)).toHaveLength(0)
  })

  it('stays well formed across a long multi-turn conversation', () => {
    const wire = toWire([
      user('one'),
      { role: 'assistant', content: 'a', tools: [tool('c1', 0, 'get_data_status', {})] },
      user('two'),
      { role: 'assistant', content: 'b' },
      user('three'),
      { role: 'assistant', content: 'c',
        tools: [tool('c2', 0, 'list_templates', {}),
                tool('c3', 0, 'evaluate_factor'),
                tool('c4', 1, 'propose_strategy', { errors: [] })] },
    ])
    assertWellFormed(wire)
    expect(wire.filter((m) => m.role === 'tool')).toHaveLength(4)
    expect(wire.filter((m) => m.role === 'user')).toHaveLength(3)
  })

  it('serialises missing arguments as an empty object, not undefined', () => {
    const wire = toWire([
      user('x'),
      { role: 'assistant', content: '',
        tools: [{ id: 'c1', round: 0, name: 'get_data_status', result: {} }] },
    ])
    expect(wire[1].tool_calls?.[0].function.arguments).toBe('{}')
  })
})
