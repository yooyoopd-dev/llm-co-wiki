import type { AzureModelFamily, CustomLlmPreset } from "@/stores/wiki-store"

/**
 * Curated LLM provider presets.
 *
 * Selecting a preset pre-fills the underlying LlmConfig fields so users
 * don't have to remember endpoint URLs / API mode per vendor. The
 * dispatch code in `src/lib/llm-providers.ts` still branches on the
 * lower-level `provider` field — presets just populate the config.
 */
export type CustomApiMode = "chat_completions" | "anthropic_messages"

export type Provider =
  | "openai"
  | "anthropic"
  | "google"
  | "azure"
  | "ollama"
  | "custom"
  | "minimax"
  | "claude-code"
  | "codex-cli"
  | "gemini-cli"

export interface LlmPreset {
  /** Stable id used as the dropdown value. */
  id: string
  /** Display label in the dropdown. */
  label: string
  /** Short subtitle shown under the label. */
  hint?: string
  /** Underlying provider dispatch key (see llm-providers.ts). */
  provider: Provider
  /** Suggested base URL. `customEndpoint` for custom, `ollamaUrl` for ollama, ignored for built-ins. */
  baseUrl?: string
  /**
   * For vendors that serve the same model catalog over both an OpenAI-
   * compatible and an Anthropic-compatible endpoint at different URLs
   * (e.g. Alibaba Bailian Coding Plan), list the URL per wire mode.
   * The settings UI auto-swaps `baseUrl` when the user flips the API
   * mode toggle — so one preset covers both protocols instead of two.
   */
  baseUrlByMode?: Partial<Record<CustomApiMode, string>>
  /** Suggested default model; user can override. */
  defaultModel?: string
  /** Azure OpenAI api-version query parameter. Azure deployments vary by resource. */
  azureApiVersion?: string
  /** Azure deployment names are arbitrary, so users can declare GPT-5/o-series behavior explicitly. */
  azureModelFamily?: AzureModelFamily
  /**
   * Curated list of model ids the UI shows as clickable chips above the
   * Model input. The user can still type a custom value — the input stays
   * free-form. An empty/missing list means "no suggestions, type freely"
   * (e.g. Ollama Local where the model set is whatever the user pulled).
   */
  suggestedModels?: string[]
  /** Custom providers only: which wire protocol to speak. */
  apiMode?: CustomApiMode
  /** Suggested context window; user can override. */
  suggestedContextSize?: number
}

export const LLM_PRESETS: LlmPreset[] = [
  {
    id: "claude-code-cli",
    label: "Claude Code CLI (local)",
    hint: "Uses the local `claude` binary — no API key needed",
    provider: "claude-code",
    defaultModel: "claude-sonnet-4-6",
    // Mirrors anthropic preset; the CLI forwards to the same Anthropic
    // backend, so model ids are identical. Users with a subscription
    // can pick Opus/Sonnet/Haiku here without paying an API key bill.
    suggestedModels: [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
    ],
    suggestedContextSize: 200000,
  },
  {
    id: "codex-cli",
    label: "Codex CLI (local)",
    hint: "Uses the local `codex` binary — no API key needed",
    provider: "codex-cli",
    defaultModel: "gpt-5.4-mini",
    suggestedModels: [
      "gpt-5.4-mini",
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2",
    ],
    suggestedContextSize: 200000,
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI (local)",
    hint: "Uses the local `gemini` binary — no API key needed",
    provider: "gemini-cli",
    defaultModel: "gemini-2.5-pro",
    suggestedModels: [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
    ],
    suggestedContextSize: 1000000,
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    hint: "Official Claude API",
    provider: "anthropic",
    defaultModel: "claude-sonnet-4-5-20250929",
    // Cross-referenced with hermes-agent/hermes_cli/models.py:233-242.
    // Both shortened and dated aliases work on api.anthropic.com.
    suggestedModels: [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-20250514",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
    ],
    suggestedContextSize: 200000,
  },
  {
    id: "openai",
    label: "OpenAI (GPT)",
    hint: "Official OpenAI API",
    provider: "openai",
    defaultModel: "gpt-4o",
    // Current public GPT models on api.openai.com. Reasoning models and
    // the 4.1 family are both exposed under the chat/completions route.
    suggestedModels: [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "o3",
      "o3-mini",
      "o1",
      "o1-mini",
      "gpt-4-turbo",
    ],
    suggestedContextSize: 128000,
  },
  {
    id: "google",
    label: "Google (Gemini)",
    hint: "Generative Language API",
    provider: "google",
    defaultModel: "gemini-2.5-flash",
    // 2.5 generation is the current stable; 2.0 kept as fallback.
    suggestedModels: [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
    ],
    suggestedContextSize: 1000000,
  },
  {
    id: "ollama-local",
    label: "Ollama (Local)",
    hint: "Self-hosted llama.cpp / Ollama",
    provider: "ollama",
    baseUrl: "http://localhost:11434",
    // Intentionally no suggestedModels: local set depends on what the
    // user has actually pulled / loaded. Kept as free-text input.
    suggestedContextSize: 32768,
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    hint: "ollama.com",
    provider: "custom",
    baseUrl: "https://ollama.com/v1",
    apiMode: "chat_completions",
    // Ollama Cloud catalog rotates frequently — keep short common picks.
    suggestedModels: [
      "gpt-oss:120b",
      "gpt-oss:20b",
      "qwen3-coder:480b",
      "kimi-k2:1t",
      "deepseek-v3.1:671b",
    ],
    suggestedContextSize: 128000,
  },
]

export function availableLlmPresets(customPresets: CustomLlmPreset[] = []): LlmPreset[] {
  return [
    ...LLM_PRESETS,
    ...customPresets.map((preset) => ({
      id: preset.id,
      label: preset.label,
      hint: "Custom OpenAI- or Anthropic-compatible endpoint",
      provider: "custom" as const,
      apiMode: "chat_completions" as const,
    })),
  ]
}

export function findLlmPreset(id: string, customPresets: CustomLlmPreset[] = []): LlmPreset | undefined {
  return availableLlmPresets(customPresets).find((preset) => preset.id === id)
}

/**
 * Best-effort reverse lookup: given the current LlmConfig fields, which
 * preset does it most likely correspond to? Used so the dropdown can
 * show the user what they're effectively on.
 */
export function matchPreset(params: {
  provider: Provider
  customEndpoint: string
  ollamaUrl: string
  apiMode?: CustomApiMode
}): LlmPreset | null {
  const norm = (u: string) => u.replace(/\/+$/, "").toLowerCase()
  const { provider, customEndpoint, ollamaUrl, apiMode } = params

  for (const preset of LLM_PRESETS) {
    if (preset.provider !== provider) continue
    if (provider === "custom") {
      if (!preset.baseUrl) continue // skip the generic Custom catch-alls
      if (norm(preset.baseUrl) !== norm(customEndpoint)) continue
      if ((preset.apiMode ?? "chat_completions") !== (apiMode ?? "chat_completions"))
        continue
      return preset
    }
    if (provider === "ollama") {
      if (preset.baseUrl && norm(preset.baseUrl) !== norm(ollamaUrl)) continue
      return preset
    }
    return preset
  }
  return null
}
