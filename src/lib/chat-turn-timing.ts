/**
 * Per-phase timing for one chat turn on a CLI-transport provider.
 *
 * A CLI turn is two serial round trips — a backend retrieval call, then a
 * freshly spawned CLI process — and a single "it felt slow" report cannot
 * tell them apart. Nor can reading the code: which phase dominates depends
 * on the user's embedding endpoint, their `~/.claude` config, and whether
 * the CLI can stream at all. So the turn reports its own split.
 *
 * Pure formatter; the caller takes the `performance.now()` marks.
 */

export interface ChatTurnTiming {
  /** Milliseconds inside the backend retrieval call. Absent when skipped. */
  retrievalMs?: number
  /** Milliseconds from the end of retrieval to the first streamed token.
   *  Absent when the provider never streamed one (Gemini CLI returns the
   *  whole answer at once, so there is no earlier first token to report). */
  firstTokenMs?: number
  /** Milliseconds for the whole turn, retrieval included. */
  totalMs?: number
  /** Why retrieval was skipped, when it was — e.g. `"greeting"`. */
  retrievalSkipped?: string
}

function ms(value: number): string {
  return `${Math.round(value)}ms`
}

/**
 * One log line, phases in the order they happen.
 *
 * `firstTokenMs` is deliberately reported as "first token" measured from
 * the end of retrieval, because that is the CLI's own cost: process spawn,
 * config and MCP load, then generation. Adding retrieval into it would
 * hide which of the two is the problem.
 */
export function formatChatTurnTiming(
  provider: string,
  model: string,
  timing: ChatTurnTiming,
): string {
  const parts: string[] = []

  if (timing.retrievalSkipped) {
    parts.push(`retrieval skipped (${timing.retrievalSkipped})`)
  } else if (timing.retrievalMs !== undefined) {
    parts.push(`retrieval ${ms(timing.retrievalMs)}`)
  }

  if (timing.firstTokenMs !== undefined) {
    parts.push(`first token ${ms(timing.firstTokenMs)}`)
  } else {
    parts.push("no streamed first token")
  }

  if (timing.totalMs !== undefined) {
    parts.push(`total ${ms(timing.totalMs)}`)
  }

  const label = model ? `${provider}/${model}` : provider
  return `[Chat] ${label} turn: ${parts.join(" → ")}`
}
