/**
 * Flatten a thrown value into a short headline plus everything else worth
 * showing. UI surfaces print the headline and keep `detail` behind a toggle so
 * a failure is never reduced to a single truncated line.
 */
export function describeError(err: unknown): { message: string; detail?: string } {
  if (err instanceof Error) {
    const parts: string[] = []
    if (err.name && err.name !== "Error") parts.push(`${err.name}: ${err.message}`)
    if (err.stack) parts.push(err.stack)
    let cause: unknown = (err as { cause?: unknown }).cause
    let depth = 0
    while (cause !== undefined && cause !== null && depth < 5) {
      const described = describeError(cause)
      parts.push(`caused by: ${described.detail ?? described.message}`)
      cause = cause instanceof Error ? (cause as { cause?: unknown }).cause : undefined
      depth += 1
    }
    const detail = parts.join("\n\n").trim()
    return { message: err.message || String(err), detail: detail || undefined }
  }
  if (typeof err === "string") return { message: err }
  try {
    const serialized = JSON.stringify(err, null, 2)
    if (serialized && serialized !== "{}") {
      return { message: String(err), detail: serialized }
    }
  } catch {
    // Circular or non-serializable — the headline is all we have.
  }
  return { message: String(err) }
}
