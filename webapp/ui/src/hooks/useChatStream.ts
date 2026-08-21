/**
 * One conversation over the server's SSE tool loop.
 *
 * `POST /api/chat` streams `token` / `tool_call` / `tool_result` / `error`
 * frames while the server runs tools on the model's behalf, so this reads the
 * body manually — `EventSource` cannot POST, and the conversation is the body.
 *
 * Extracted from ChatPage when the builder needed the same stream with a
 * different profile. The parsing is the fiddly part and it should exist once.
 */
import { useCallback, useRef, useState } from 'react'

import { authHeaders } from '@/lib/authFetch'
import { toWire, type BuilderContext, type ChatMessage, type ChatProfile, type KeycardContext } from '@/lib/chat'

interface Options {
  profile?: ChatProfile
  /** Rebuilt on every send, so the model never sees a stale spec. */
  context?: () => BuilderContext | KeycardContext | undefined
  onToolResult?: (name: string, result: unknown) => void
}

export function useChatStream({ profile = 'general', context, onToolResult }: Options = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  const reset = useCallback(() => {
    abort.current?.abort()
    setMessages([])
    setError(null)
    setStreaming(false)
  }, [])

  const stop = useCallback(() => abort.current?.abort(), [])

  const send = useCallback(async (text: string, opts?: { model?: string }) => {
    const question = text.trim()
    if (!question) return

    const history: ChatMessage[] = [...messages, { role: 'user', content: question }]
    setMessages([...history, { role: 'assistant', content: '', tools: [] }])
    setStreaming(true)
    setError(null)

    const controller = new AbortController()
    abort.current = controller

    const patch = (fn: (m: ChatMessage) => ChatMessage) =>
      setMessages((prev) => {
        const next = [...prev]
        next[next.length - 1] = fn(next[next.length - 1])
        return next
      })

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        signal: controller.signal,
        body: JSON.stringify({
          profile,
          model: opts?.model,
          context: context?.(),
          // Expanded rather than projected. `history.map(m => ({role, content}))`
          // threw away every tool call the assistant made, so the model never
          // saw the errors its own last proposal came back with.
          messages: toWire(history),
        }),
      })
      if (!resp.ok || !resp.body) throw new Error(`Chat failed (${resp.status})`)

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let currentEvent = 'message'

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        // sse-starlette terminates lines with CRLF, so frames are separated by
        // \r\n\r\n. Normalising first is what makes the split work at all —
        // splitting on \n\n alone matches nothing and the buffer grows forever.
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')

        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''

        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) currentEvent = line.slice(7).trim()
            if (!line.startsWith('data: ')) continue

            const payload = JSON.parse(line.slice(6))
            if (currentEvent === 'token') {
              patch((m) => ({ ...m, content: m.content + payload.text }))
            } else if (currentEvent === 'tool_call') {
              patch((m) => ({
                ...m,
                // The model speaks before and after a tool call, and both
                // arrive as tokens on one message. Without a break the two
                // paragraphs run together mid-sentence.
                content: m.content && !m.content.endsWith('\n\n')
                  ? `${m.content}\n\n` : m.content,
                tools: [...(m.tools ?? []), {
                  id: payload.id,
                  round: payload.round ?? 0,
                  name: payload.name,
                  arguments: payload.arguments,
                }],
              }))
            } else if (currentEvent === 'tool_result') {
              patch((m) => {
                // Matched on id, not name. The previous backwards name-scan
                // attached both results to the first of two parallel calls to
                // the same tool and left the second pending forever.
                const tools = (m.tools ?? []).map((t) =>
                  t.id === payload.id ? { ...t, result: payload.result } : t)
                return { ...m, tools }
              })
              onToolResult?.(payload.name, payload.result)
            } else if (currentEvent === 'error') {
              setError(payload.message)
            }
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError(e instanceof Error ? e.message : 'Chat failed')
      }
    } finally {
      setStreaming(false)
      abort.current = null
    }
  }, [messages, profile, context, onToolResult])

  return { messages, streaming, error, send, reset, stop, setError }
}
