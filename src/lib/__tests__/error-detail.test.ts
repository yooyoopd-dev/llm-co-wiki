import { describe, it, expect } from "vitest"
import { describeError } from "@/lib/error-detail"

describe("describeError", () => {
  it("keeps the headline short and puts the stack in detail", () => {
    const err = new Error("boom")
    const described = describeError(err)
    expect(described.message).toBe("boom")
    expect(described.detail).toContain("boom")
  })

  it("walks the cause chain", () => {
    const err = Object.assign(new Error("outer"), { cause: new Error("inner") })
    expect(describeError(err).detail).toContain("inner")
  })

  it("passes plain strings through without a detail block", () => {
    expect(describeError("plain failure")).toEqual({ message: "plain failure" })
  })

  it("serializes non-Error objects", () => {
    const described = describeError({ code: 42 })
    expect(described.detail).toContain("42")
  })
})
