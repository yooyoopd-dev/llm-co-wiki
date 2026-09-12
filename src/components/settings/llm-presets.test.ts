import { describe, expect, it } from "vitest"
import { LLM_PRESETS } from "./llm-presets"

describe("LLM_PRESETS", () => {
  it("offers only the curated providers, with the CLI ones first", () => {
    // The dropdown order is the list order. Local CLI providers lead because
    // they need no API key; Anthropic follows them.
    expect(LLM_PRESETS.map((preset) => preset.id)).toEqual([
      "claude-code-cli",
      "codex-cli",
      "gemini-cli",
      "anthropic",
      "openai",
      "google",
      "ollama-local",
      "ollama-cloud",
    ])
  })
})
