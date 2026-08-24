/**
 * The chat wire format, shared by the Chat page and the builder's assistant.
 *
 * Lifted out of ChatPage when a second surface needed it. The types were local
 * to that file and the SSE reader was welded into its `send()`; a copy of either
 * would have been a copy that drifts.
 */

export interface ToolEvent {
  /**
   * The provider's tool-call id, echoed by the server.
   *
   * Load-bearing rather than decorative: it is the only thing that pairs a
   * result with its call when the model makes two parallel calls to the same
   * tool, and it is what `tool_call_id` must be on the way back.
   */
  id: string
  /** Which round of the server's tool loop made this call. */
  round: number
  name: string
  arguments?: Record<string, unknown>
  /** Undefined until the server sends the matching `tool_result`. */
  result?: unknown
}

/**
 * A message as the transcript is *drawn*: one bubble per turn, whatever the
 * model did inside it.
 *
 * Deliberately not the wire shape. Adding `role: 'tool'` rows here would shift
 * every array index, and the builder dock keys its applied/dismissed proposals
 * off those indices -- an applied proposal would silently re-key onto a
 * different one. Both render loops would also draw a 12 KB JSON result as an
 * assistant bubble. `toWire` does the translation instead, in one place, at the
 * moment of sending.
 */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  tools?: ToolEvent[]
}

/** A message in OpenRouter's shape. Produced only by `toWire`. */
export interface WireMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
  tool_call_id?: string
}

/** Stands in for a result that never arrived. See `toWire`. */
const INTERRUPTED = { error: 'No result: the request was interrupted.' }

/**
 * Expand the drawn transcript into the strict sequence the model expects:
 * `assistant(tool_calls) -> tool... -> assistant(tool_calls) -> tool... -> assistant(prose)`.
 *
 * Without this the previous turn's tool calls and their errors never reach the
 * model, so a proposal that failed validation is re-proposed unchanged, forever.
 *
 * Two rules that look wrong and are not:
 *
 * **All prose goes on one trailing message.** The model speaks before and after
 * a tool call and both arrive as tokens on one bubble; the `\n\n` that separates
 * them is inserted by the reader, and model prose can itself contain `\n\n`, so
 * the split is not recoverable from the string. Guessing it would put round-two
 * commentary inside the round-one message -- a lie about causality inside the
 * transcript the model reasons over. Every word is still present, in order, and
 * attributed to the assistant; only the interleaving is lost.
 *
 * **A call with no result still emits its `tool` row.** Stopping mid-tool leaves
 * an assistant message bearing `tool_calls` with nothing answering them, and
 * OpenAI-compatible APIs reject that outright. A stand-in body is a far better
 * answer than a 400 on the user's next message.
 */
export function toWire(messages: ChatMessage[]): WireMessage[] {
  const out: WireMessage[] = []

  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content })
      continue
    }

    const tools = message.tools ?? []
    if (tools.length) {
      const rounds = [...new Set(tools.map((t) => t.round))].sort((a, b) => a - b)
      for (const round of rounds) {
        const batch = tools.filter((t) => t.round === round)
        out.push({
          role: 'assistant',
          // Present and null, never absent -- see the server's own transcript.
          content: null,
          tool_calls: batch.map((t) => ({
            id: t.id,
            type: 'function' as const,
            function: {
              name: t.name,
              arguments: JSON.stringify(t.arguments ?? {}),
            },
          })),
        })
        for (const tool of batch) {
          out.push({
            role: 'tool',
            tool_call_id: tool.id,
            content: JSON.stringify(tool.result ?? INTERRUPTED),
          })
        }
      }
    }

    if (message.content) out.push({ role: 'assistant', content: message.content })
  }

  return out
}

export type ChatProfile = 'general' | 'builder' | 'keycard-builder'

export interface ChatConfig {
  configured: boolean
  model: string
  profile: ChatProfile
  tools: string[]
}

/** What the Strategy Builder has on screen. Only sent by the builder profile. */
export interface BuilderContext {
  spec?: unknown
  strategy_id?: string | null
  saved?: boolean
  mode?: 'form' | 'canvas'
  expression?: string | null
  /** Every column on the canvas, finished or not. */
  features?: { name: string; expression: string; complete: boolean }[] | null
  feature_mode?: 'extend' | 'replace' | null
  /** Rows from the last applied proposal that are still true of `spec`. */
  assumed?: { path: string; value: unknown; why: string }[] | null
  /** User's plain-language objective for the AI assistant. */
  context?: string
}

/** What the Keycard Builder has on screen. Only sent by the keycard-builder profile. */
export interface KeycardContext {
  spec?: unknown
  keycard_id?: string | null
  saved?: boolean
  /** Rows from the last applied proposal that are still true of `spec`. */
  assumed?: { path: string; value: unknown; why: string }[] | null
  /** User's plain-language objective for the AI assistant. */
  context?: string
}

/** A `propose_strategy` result, as the panel renders it. */
export interface Proposal {
  spec: Record<string, unknown>
  assumed: { path: string; value: unknown; why: string }[]
  inherited: { path: string; value: unknown; source: string }[]
  warnings: string[]
  source: string
}

export interface ProposalError {
  errors: { code: string; message: string; path?: string }[]
}

export const isProposal = (result: unknown): result is Proposal =>
  typeof result === 'object' && result !== null && 'spec' in result && 'assumed' in result

export const isProposalError = (result: unknown): result is ProposalError =>
  typeof result === 'object' && result !== null && 'errors' in result
