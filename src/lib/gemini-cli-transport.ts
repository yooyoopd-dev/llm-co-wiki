/**
 * Gemini CLI subprocess transport.
 *
 * Rust-side counterpart: src-tauri/src/commands/gemini_cli.rs. The Rust
 * command spawns `gemini --skip-trust --approval-mode plan -o json`, sends a
 * single reconstructed prompt over stdin, and emits one
 * `gemini-cli:{streamId}:done` event carrying the whole stdout/stderr.
 *
 * There is no token stream to subscribe to: with `-o json` the CLI prints a
 * single envelope after the turn finishes, so the answer is delivered as one
 * `onToken` call. Callers that need incremental rendering will see the whole
 * message appear at once — same end state, no partial paint.
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
  let unlistenDone: UnlistenFn | undefined
  let finished = false
  let aborted = signal?.aborted ?? false
  let resolveCompletion: () => void = () => {}
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })

  const cleanup = () => {
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
    unlistenDone = await listen<{ code: number | null; stderr: string; stdout?: string }>(
      `gemini-cli:${streamId}:done`,
      (event) => {
        const code = event.payload?.code
        const stderr = event.payload?.stderr?.trim() ?? ""
        const stdout = event.payload?.stdout ?? ""
        const parsed = parseGeminiCliOutput(stdout, stderr)

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
