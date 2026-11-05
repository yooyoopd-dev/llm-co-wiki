/**
 * Gemini CLI subprocess transport.
 *
 * Rust-side counterpart: src-tauri/src/commands/gemini_cli.rs. The Rust
 * command spawns `gemini --skip-trust --approval-mode plan -o stream-json`,
 * sends a single reconstructed prompt over stdin, emits every stdout line as
 * a `gemini-cli:{streamId}` event, and finishes with one
 * `gemini-cli:{streamId}:done` event carrying the whole stdout/stderr.
 *
 * Assistant text arrives as JSONL `message` deltas, so it streams token by
 * token. The done event is still parsed as a single `-o json` envelope when
 * no delta was seen — that is where the error envelope lives, and it keeps a
 * CLI that ignored the flag working rather than reporting an empty answer.
 */

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { ChatMessage, ContentBlock, RequestOverrides } from "./llm-providers"
import type { StreamCallbacks } from "./llm-client"

interface GeminiEnvelope {
  session_id?: string
  response?: string
  error?: { message?: string; code?: number }
}

export interface ParsedGeminiOutput {
  text: string
  error: string | null
}

/**
 * The CLI keeps its auth in its own settings file and this app never touches
 * it, so the only useful thing to do with "no auth method" is to say where
 * the key belongs. The wording of the failure is what
 * `validateNonInteractiveAuth` emits in Gemini CLI 0.58.0.
 */
export function geminiAuthHint(error: string): string | null {
  if (!/set an Auth method/i.test(error)) return null
  return (
    "No auth method is configured in the Gemini CLI's own settings (~/.gemini/settings.json): " +
    "`security.auth.selectedType` must sit under the same `security` object as " +
    "`security.folderTrust`. Run `gemini` once in a terminal and pick an auth method — " +
    "the CLI rewrites the file itself."
  )
}

/**
 * Recognizing the envelope by "is it JSON?" is wrong: a model asked for JSON
 * answers with a JSON object of its own, and reading that as an envelope
 * yields an absent `response` — i.e. a silently empty answer. Look for keys
 * only the envelope has.
 */
function isEnvelope(value: unknown): value is GeminiEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  return ["response", "error", "stats", "session_id"].some((key) => key in value)
}

/**
 * Open the `-o json` envelope.
 *
 * The error envelope arrives on *stderr* with exit code 41, not on stdout, so
 * both streams are tried before giving up. When neither parses, the output is
 * treated as plain text — that keeps older CLI versions (and any future
 * change to the envelope) working instead of reporting an empty answer.
 */
export function parseGeminiCliOutput(stdout: string, stderr = ""): ParsedGeminiOutput {
  let envelope: GeminiEnvelope | null = null
  for (const raw of [stdout, stderr]) {
    if (envelope !== null) break
    if (!raw.trim()) continue
    try {
      const parsed: unknown = JSON.parse(raw.trim())
      if (isEnvelope(parsed)) envelope = parsed
    } catch {
      // Not this one; try the next stream.
    }
  }

  if (envelope === null) return { text: stdout.trim(), error: null }

  if (envelope.error) {
    const message = envelope.error.message ?? "unknown error"
    const code = envelope.error.code
    return { text: "", error: code === undefined ? message : `${message} (code=${code})` }
  }
  return { text: (envelope.response ?? "").trim(), error: null }
}

/**
 * One parsed JSONL event from `-o stream-json`, reduced to what this
 * transport uses.
 *
 * Shapes are taken from Gemini CLI 0.67.0's own emitter
 * (`packages/core/src/output/stream-json-formatter.ts` and its call sites):
 *
 *   {"type":"message","role":"assistant","content":"...","delta":true}
 *   {"type":"message","role":"user","content":"..."}        ← the prompt echo
 *   {"type":"tool_use","tool_name":"...","tool_id":"...","parameters":{}}
 *   {"type":"result","status":"success","stats":{...}}
 *   {"type":"result","status":"error","error":{"type":"...","message":"..."}}
 *
 * The success `result` carries only stats, never the answer text, so
 * accumulating the deltas cannot double-count.
 */
interface GeminiStreamEvent {
  type?: unknown
  role?: unknown
  content?: unknown
  delta?: unknown
  status?: unknown
  error?: { type?: unknown; message?: unknown }
}

/**
 * Assistant text carried by one stream-json line, or null for every other
 * event.
 *
 * The `role === "assistant"` test is what keeps the CLI's own echo of the
 * prompt out of the answer: that echo is also a `message` event, just with
 * `role: "user"` and no `delta`. Without the check, every turn would open by
 * replaying the entire prompt — wiki context included — into the chat bubble.
 */
export function parseGeminiStreamLine(rawLine: string): string | null {
  const line = rawLine.trim()
  if (!line) return null

  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return null
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) return null

  const obj = event as GeminiStreamEvent
  if (obj.type !== "message") return null
  if (obj.role !== "assistant") return null
  return typeof obj.content === "string" && obj.content.length > 0 ? obj.content : null
}

/**
 * The error message from a stream-json `result` line, or null.
 *
 * A failed turn reports itself here rather than through the stdout envelope,
 * so without this a stream-json error would surface only as a bare exit code.
 */
export function parseGeminiStreamError(rawLine: string): string | null {
  const line = rawLine.trim()
  if (!line) return null

  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return null
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) return null

  const obj = event as GeminiStreamEvent
  if (obj.type !== "result" || obj.status !== "error") return null
  const message = obj.error?.message
  const kind = obj.error?.type
  if (typeof message !== "string" || !message.trim()) {
    return typeof kind === "string" && kind.trim() ? kind.trim() : "unknown error"
  }
  return typeof kind === "string" && kind.trim() ? `${kind}: ${message}` : message
}

const STREAM_EVENT_TYPES = new Set([
  "init",
  "message",
  "tool_use",
  "tool_result",
  "error",
  "result",
])

/**
 * True when stdout is the JSONL stream rather than a single `-o json`
 * envelope.
 *
 * This guards the envelope fallback. `parseGeminiCliOutput` treats anything
 * it cannot parse as plain text, which is right for a CLI that printed prose
 * — but applied to a multi-line JSONL buffer it would paste raw JSON events
 * into the chat as if they were the answer.
 */
export function isStreamJsonOutput(stdout: string): boolean {
  return stdout
    .split("\n")
    .some((line) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith("{")) return false
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false
        const type = (parsed as { type?: unknown }).type
        return typeof type === "string" && STREAM_EVENT_TYPES.has(type)
      } catch {
        return false
      }
    })
}

function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return content
    .map((block) => {
      if (block.type === "text") return block.text
      return `[Image omitted: ${block.mediaType}]`
    })
    .join("\n")
}

function escapePromptContent(text: string): string {
  return text.replace(/<\/?[A-Z_][A-Z0-9_]*>/gi, (tag) =>
    tag.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  )
}

export function buildPrompt(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const role = message.role.toUpperCase()
      return `<${role}>\n${escapePromptContent(contentToText(message.content))}\n</${role}>`
    })
    .join("\n\n")
}

type SpawnPayload = Record<string, unknown> & {
  streamId: string
  model: string
  prompt: string
  workingDirectory?: string
}

export async function streamGeminiCli(
  config: LlmConfig,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  overrides?: RequestOverrides,
): Promise<void> {
  const { onToken, onDone, onError } = callbacks

  if (import.meta.env?.DEV && overrides) {
    for (const key of ["temperature", "top_p", "top_k", "max_tokens", "stop"] as const) {
      if (overrides[key] !== undefined) {
        // eslint-disable-next-line no-console
        console.warn(`[gemini-cli] ignoring unsupported override "${key}": CLI has no equivalent flag`)
      }
    }
  }

  const streamId = crypto.randomUUID()
  let unlistenData: UnlistenFn | undefined
  let unlistenDone: UnlistenFn | undefined
  let finished = false
  let aborted = signal?.aborted ?? false
  // Whether any assistant delta streamed. Decides between finishing on the
  // deltas and falling back to parsing the whole stdout as a `-o json`
  // envelope — the path a failed or non-streaming run takes.
  let streamedText = false
  // Error reported by a stream-json `result` line. Kept rather than raised
  // immediately so the done handler reports it alongside the exit code.
  let streamError: string | null = null
  let resolveCompletion: () => void = () => {}
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })

  const cleanup = () => {
    unlistenData?.()
    unlistenDone?.()
  }

  const finishWith = (cb: () => void) => {
    if (finished) return
    finished = true
    cleanup()
    cb()
    resolveCompletion()
  }

  const abortListener = () => {
    aborted = true
    void invoke("gemini_cli_kill", { streamId }).catch(() => {})
    finishWith(onDone)
  }
  if (aborted) {
    finishWith(onDone)
    return
  }
  signal?.addEventListener("abort", abortListener)

  try {
    // Listen before spawning so the first event on a fast turn is not missed.
    unlistenData = await listen<string>(`gemini-cli:${streamId}`, (event) => {
      const token = parseGeminiStreamLine(event.payload)
      if (token !== null) {
        streamedText = true
        onToken(token)
        return
      }
      streamError ??= parseGeminiStreamError(event.payload)
    })
    if (aborted || finished) {
      cleanup()
      return
    }

    unlistenDone = await listen<{ code: number | null; stderr: string; stdout?: string }>(
      `gemini-cli:${streamId}:done`,
      (event) => {
        const code = event.payload?.code
        const stderr = event.payload?.stderr?.trim() ?? ""
        const stdout = event.payload?.stdout ?? ""

        // A stream-json `result` error is the most specific diagnosis there
        // is, and it arrives even when text streamed first — so check it
        // before treating a streamed turn as a success.
        if (streamError) {
          const hint = geminiAuthHint(streamError)
          const message = streamError
          finishWith(() =>
            onError(new Error(
              `Gemini CLI rejected the request: ${message}${hint ? `\n${hint}` : ""}`,
            )),
          )
          return
        }

        // Text already streamed as deltas: the answer is in the chat, and the
        // stdout buffer holds the same text split across JSONL lines. Parsing
        // it again would append the whole answer a second time.
        if (streamedText) {
          if (code !== null && code !== undefined && code !== 0) {
            const details = stderr || stdout.trim()
            finishWith(() =>
              onError(new Error(
                details
                  ? `Gemini CLI exited with code ${code} after streaming a partial answer:\n${details}`
                  : `Gemini CLI exited with code ${code} after streaming a partial answer.`,
              )),
            )
            return
          }
          finishWith(onDone)
          return
        }

        // No delta reached the live listener. Re-read the buffered stdout as
        // a stream first — an event could have been missed — and only then
        // as the single `-o json` envelope.
        const bufferedStreamText = stdout
          .split("\n")
          .map(parseGeminiStreamLine)
          .filter((token): token is string => token !== null)
          .join("")
        if (bufferedStreamText) {
          onToken(bufferedStreamText)
          finishWith(onDone)
          return
        }
        for (const line of stdout.split("\n")) {
          const bufferedError = parseGeminiStreamError(line)
          if (bufferedError) {
            const hint = geminiAuthHint(bufferedError)
            finishWith(() =>
              onError(new Error(
                `Gemini CLI rejected the request: ${bufferedError}${hint ? `\n${hint}` : ""}`,
              )),
            )
            return
          }
        }

        // A JSONL buffer with no assistant text is an empty answer, not prose.
        // Reporting it through the envelope path would paste raw events into
        // the chat, since anything unparseable is treated as plain text.
        const parsed = isStreamJsonOutput(stdout)
          ? { text: "", error: null }
          : parseGeminiCliOutput(stdout, stderr)

        // The envelope's own error message is more specific than the exit
        // code, so it wins when both are present.
        if (parsed.error) {
          const hint = geminiAuthHint(parsed.error)
          finishWith(() =>
            onError(new Error(
              `Gemini CLI rejected the request: ${parsed.error}${hint ? `\n${hint}` : ""}`,
            )),
          )
          return
        }
        if (code !== null && code !== undefined && code !== 0) {
          const details = stderr || stdout.trim()
          finishWith(() =>
            onError(new Error(
              details
                ? `Gemini CLI exited with code ${code}:\n${details}`
                : `Gemini CLI exited with code ${code}. Run \`gemini\` in a terminal to inspect the problem.`,
            )),
          )
          return
        }
        if (!parsed.text) {
          const details = stderr || stdout.trim()
          finishWith(() =>
            onError(new Error(
              details
                ? `Gemini CLI completed without an answer. Raw output:\n${details}`
                : "Gemini CLI completed without an answer. Run `gemini -o json` in a terminal to inspect the provider output.",
            )),
          )
          return
        }

        onToken(parsed.text)
        finishWith(onDone)
      },
    )
    if (aborted || finished) {
      cleanup()
      return
    }

    const workingDirectory = useWikiStore.getState().project?.path
    if (!workingDirectory) {
      throw new Error("Gemini CLI requires an active project working directory")
    }

    const payload: SpawnPayload = {
      streamId,
      model: config.model,
      prompt: buildPrompt(messages),
      workingDirectory,
    }
    await invoke("gemini_cli_spawn", payload)
    if (aborted || signal?.aborted) {
      aborted = true
      await invoke("gemini_cli_kill", { streamId }).catch(() => {})
      finishWith(onDone)
      return
    }
    await completion
  } catch (err) {
    finishWith(() => {
      const message = err instanceof Error ? err.message : String(err)
      if (/not found|No such file|executable file not found/i.test(message)) {
        onError(new Error(
          "Gemini CLI not found. Install `gemini` with `npm install -g @google/gemini-cli` or pick a different provider.",
        ))
      } else {
        onError(err instanceof Error ? err : new Error(message))
      }
    })
  } finally {
    signal?.removeEventListener("abort", abortListener)
  }
}
