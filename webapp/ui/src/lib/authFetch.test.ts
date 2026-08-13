/**
 * The SSE reader, against the bytes the server actually sends.
 *
 * These exist because of a bug that produced no error at all. sse-starlette
 * terminates its lines with CRLF, so a frame boundary on the wire is
 * "\r\n\r\n" — which contains no "\r\n\r\n"-free "\n\n" substring. A reader
 * splitting on "\n\n" matched nothing, buffered forever, and delivered silence:
 * the run page showed a report (fetched over other endpoints) with a log that
 * never arrived, and nothing anywhere said why.
 *
 * So the fixtures below are byte-exact rather than tidy.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'

import { streamSSE } from '@/lib/authFetch'

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}))

/** A Response whose body streams `chunks` verbatim. */
function respondWith(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

function collect() {
  const seen: Array<[string, string]> = []
  return { seen, onEvent: (e: string, d: string) => { seen.push([e, d]) } }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('streamSSE', () => {
  it('reads frames terminated with CRLF, as the server sends them', async () => {
    vi.stubGlobal('fetch', async () => respondWith([
      'event: log\r\ndata: {"lines":["a"],"offset":1}\r\n\r\n',
      'event: done\r\ndata: {"status":"succeeded"}\r\n\r\n',
    ]))

    const { seen, onEvent } = collect()
    await streamSSE('/runs/x/events', { onEvent })

    expect(seen).toEqual([
      ['log', '{"lines":["a"],"offset":1}'],
      ['done', '{"status":"succeeded"}'],
    ])
  })

  it('reads plain LF frames too', async () => {
    vi.stubGlobal('fetch', async () => respondWith([
      'event: status\ndata: {"phase":"Training model"}\n\n',
    ]))

    const { seen, onEvent } = collect()
    await streamSSE('/runs/x/events', { onEvent })

    expect(seen).toEqual([['status', '{"phase":"Training model"}']])
  })

  it('holds a frame split across chunks until it is whole', async () => {
    // A chunk boundary lands mid-frame routinely. Emitting the half that has
    // arrived would hand JSON.parse a truncated object.
    vi.stubGlobal('fetch', async () => respondWith([
      'event: log\r\ndata: {"lines":["first h',
      'alf","second half"],"offset":2}\r\n\r\n',
    ]))

    const { seen, onEvent } = collect()
    await streamSSE('/runs/x/events', { onEvent })

    expect(seen).toHaveLength(1)
    expect(JSON.parse(seen[0][1]).lines).toEqual(['first half', 'second half'])
  })

  it('defaults the event name when the server omits it', async () => {
    vi.stubGlobal('fetch', async () => respondWith(['data: bare\r\n\r\n']))

    const { seen, onEvent } = collect()
    await streamSSE('/runs/x/events', { onEvent })

    expect(seen).toEqual([['message', 'bare']])
  })

  it('joins a multi-line payload with newlines, per the spec', async () => {
    vi.stubGlobal('fetch', async () => respondWith([
      'event: log\r\ndata: one\r\ndata: two\r\n\r\n',
    ]))

    const { seen, onEvent } = collect()
    await streamSSE('/runs/x/events', { onEvent })

    expect(seen).toEqual([['log', 'one\ntwo']])
  })

  it('throws on a refusal rather than reporting an empty stream', async () => {
    // A 401 that resolved quietly would look exactly like a run making no
    // progress, which is the confusion this whole file exists to prevent.
    vi.stubGlobal('fetch', async () => new Response('', { status: 401 }))

    const { onEvent } = collect()
    await expect(streamSSE('/runs/x/events', { onEvent })).rejects.toThrow(/401/)
  })
})
