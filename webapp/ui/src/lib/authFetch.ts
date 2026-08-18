/**
 * The `/api` transport's credentials, in one place.
 *
 * Every call to the qlib API now carries the Supabase access token the browser
 * already holds for the RAG half of the platform. Before this, `/api` was
 * unauthenticated: the login screen gated the SPA but not the server, so a
 * request straight to the port bypassed it entirely and everyone shared one
 * pile of strategies, runs and portfolios.
 *
 * `X-Aion-Org` names which organisation the caller is acting in. The backend
 * validates it against membership and falls back to their default, so a
 * tampered header is a 403 rather than a way into someone else's workspace.
 */
import { supabase } from '@/lib/supabase'

/** Where the org switcher parks the current choice. Read here so that every
 * request picks it up without threading it through a hundred call sites. */
const ORG_KEY = 'aion.org.current'

export function getCurrentOrgId(): string | null {
  try {
    return localStorage.getItem(ORG_KEY)
  } catch {
    return null
  }
}

export function setCurrentOrgId(orgId: string | null) {
  try {
    if (orgId) localStorage.setItem(ORG_KEY, orgId)
    else localStorage.removeItem(ORG_KEY)
  } catch {
    /* private browsing — the backend default is a fine fallback */
  }
}

/**
 * Authorization and org headers for the current session.
 *
 * Returns an empty object when signed out rather than throwing. The request
 * then gets a 401, which `request` turns into a message; that is a better
 * failure than a thrown exception inside a render.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return {}
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.access_token}`,
  }
  const org = getCurrentOrgId()
  if (org) headers['X-Aion-Org'] = org
  return headers
}

/**
 * Read a Server-Sent Events stream over `fetch`.
 *
 * `EventSource` cannot send an `Authorization` header, so the moment `/api`
 * required a token every EventSource-based stream in the app would have failed
 * — silently, as a connection that opens and never delivers. This is the same
 * approach `useChatStream` already used (there because EventSource cannot POST).
 *
 * Calls `onEvent` per frame with the SSE `event:` name (defaulting to
 * `message`) and its raw `data:` payload.
 */
export async function streamSSE(
  path: string,
  {
    signal,
    onEvent,
    method = 'GET',
    body,
  }: {
    signal?: AbortSignal
    onEvent: (event: string, data: string) => void
    method?: string
    body?: unknown
  },
): Promise<void> {
  const resp = await fetch(`/api${path}`, {
    method,
    signal,
    headers: {
      Accept: 'text/event-stream',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(await authHeaders()),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  if (!resp.ok || !resp.body) {
    throw new Error(`${resp.status} ${resp.statusText}`)
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    // Normalise line endings before anything looks for a frame boundary.
    // sse-starlette terminates lines with CRLF, so the separator on the wire is
    // "\r\n\r\n" — which contains no "\n\n" at all. Splitting on the raw bytes
    // matched nothing, the buffer grew forever, and the stream delivered
    // silence: no error, no frames, a log that simply never appeared.
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')

    // Frames are separated by a blank line. Keep the trailing partial frame in
    // the buffer — a chunk boundary lands mid-frame often enough that parsing
    // what has arrived so far would drop log lines.
    let split: number
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)

      let event = 'message'
      const data: string[] = []
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        // A multi-line payload arrives as repeated `data:` lines, per the spec.
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (data.length) onEvent(event, data.join('\n'))
    }
  }
}
