import { describe, it, expect } from "vitest"
import { formatChatTurnTiming } from "./chat-turn-timing"

describe("formatChatTurnTiming", () => {
  it("reports the three phases in the order they happen", () => {
    expect(
      formatChatTurnTiming("claude-code", "sonnet", {
        retrievalMs: 1240,
        firstTokenMs: 8310,
        totalMs: 15420,
      }),
    ).toBe(
      "[Chat] claude-code/sonnet turn: retrieval 1240ms → first token 8310ms → total 15420ms",
    )
  })

  it("says retrieval was skipped, and why, instead of printing 0ms", () => {
    const line = formatChatTurnTiming("claude-code", "sonnet", {
      retrievalSkipped: "greeting",
      firstTokenMs: 900,
      totalMs: 1100,
    })
    expect(line).toContain("retrieval skipped (greeting)")
    expect(line).not.toContain("retrieval 0ms")
  })

  it("prefers the skip reason over a stray retrieval measurement", () => {
    const line = formatChatTurnTiming("claude-code", "sonnet", {
      retrievalSkipped: "greeting",
      retrievalMs: 5,
    })
    expect(line).toContain("retrieval skipped (greeting)")
    expect(line).not.toContain("retrieval 5ms")
  })

  it("states plainly when the provider never streamed a first token", () => {
    // Gemini CLI under `-o json`: the whole answer lands at once, so
    // there is no earlier first token. Saying so is the point — a
    // missing phase must not read as a fast one.
    const line = formatChatTurnTiming("gemini-cli", "gemini-2.5-pro", {
      retrievalMs: 1200,
      totalMs: 14000,
    })
    expect(line).toContain("no streamed first token")
    expect(line).toContain("total 14000ms")
  })

  it("rounds fractional milliseconds", () => {
    expect(
      formatChatTurnTiming("codex-cli", "gpt-5", { retrievalMs: 12.4, totalMs: 99.6 }),
    ).toContain("retrieval 12ms")
    expect(
      formatChatTurnTiming("codex-cli", "gpt-5", { retrievalMs: 12.4, totalMs: 99.6 }),
    ).toContain("total 100ms")
  })

  it("drops the slash when no model is configured", () => {
    expect(formatChatTurnTiming("gemini-cli", "", { totalMs: 10 })).toContain(
      "[Chat] gemini-cli turn:",
    )
  })

  it("still produces a line when every phase is missing", () => {
    expect(formatChatTurnTiming("claude-code", "sonnet", {})).toBe(
      "[Chat] claude-code/sonnet turn: no streamed first token",
    )
  })
})
