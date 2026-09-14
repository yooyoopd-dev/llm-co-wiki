import { describe, it, expect, beforeEach } from "vitest"
import {
  buildReviewDecisionPrompt,
  condenseDiff,
  decisionBlocker,
  defaultDecision,
  defaultTargets,
  normalizeTargetPath,
  restoreLockedFields,
  staleProposalPaths,
  summarizeApplied,
  validateReviewEdits,
  type ReviewProposal,
} from "./review-decision"
import { useWikiStore } from "@/stores/wiki-store"
import type { ReviewDecision, ReviewItem } from "@/stores/review-store"

function makeItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "review-0000abcd",
    type: "suggestion",
    title: "Attention needs the 2024 numbers",
    description: "The benchmark table stops at 2023.",
    options: [],
    resolved: false,
    createdAt: 0,
    ...overrides,
  }
}

function makeDecision(overrides: Partial<ReviewDecision> = {}): ReviewDecision {
  return {
    kind: "custom",
    instruction: "add the 2024 numbers",
    targets: ["wiki/concepts/attention.md"],
    allowCreate: false,
    status: "draft",
    ...overrides,
  }
}

const PAGE = `---
type: concept
title: Attention
created: 2024-01-01
---

# Attention

A reasonably long body so the shrink threshold has something to measure against.
It keeps going for a while to make the 70% rule meaningful in these tests.
`

beforeEach(() => {
  useWikiStore.getState().setOutputLanguage("auto")
})

describe("normalizeTargetPath", () => {
  it("accepts the shapes review items actually use", () => {
    expect(normalizeTargetPath("concepts/a")).toBe("wiki/concepts/a.md")
    expect(normalizeTargetPath("wiki/concepts/a.md")).toBe("wiki/concepts/a.md")
    expect(normalizeTargetPath("wiki\\concepts\\a.md")).toBe("wiki/concepts/a.md")
  })

  it("strips a project prefix left over from an absolute path", () => {
    expect(normalizeTargetPath("/home/u/proj/wiki/concepts/a.md", "/home/u/proj"))
      .toBe("wiki/concepts/a.md")
  })

  it("returns an empty string for empty input", () => {
    expect(normalizeTargetPath("   ")).toBe("")
  })
})

describe("defaults", () => {
  it("derives targets from affectedPages, deduped", () => {
    const item = makeItem({ affectedPages: ["concepts/a", "wiki/concepts/a.md", "entities/b"] })
    expect(defaultTargets(item)).toEqual(["wiki/concepts/a.md", "wiki/entities/b.md"])
  })

  it("allows page creation only when the item names no page", () => {
    expect(defaultDecision("custom", makeItem()).allowCreate).toBe(true)
    expect(defaultDecision("custom", makeItem({ affectedPages: ["concepts/a"] })).allowCreate).toBe(false)
  })

  it("keep needs no instruction", () => {
    expect(decisionBlocker(defaultDecision("keep", makeItem()))).toBeNull()
  })
})

describe("decisionBlocker", () => {
  it("blocks an empty instruction", () => {
    expect(decisionBlocker(makeDecision({ instruction: "  " }))).toBe("instruction")
  })

  it("blocks when there is nowhere to write", () => {
    expect(decisionBlocker(makeDecision({ targets: [], allowCreate: false }))).toBe("targets")
    expect(decisionBlocker(makeDecision({ targets: [], allowCreate: true }))).toBeNull()
  })
})

describe("buildReviewDecisionPrompt", () => {
  it("puts the human instruction above the item's own wording", () => {
    const prompt = buildReviewDecisionPrompt({
      item: makeItem(),
      decision: makeDecision({ instruction: "only fix the table" }),
      pages: [{ path: "wiki/concepts/attention.md", content: PAGE }],
    })
    expect(prompt).toContain("only fix the table")
    expect(prompt.indexOf("outranks")).toBeLessThan(prompt.indexOf("## Current pages"))
    expect(prompt).toContain("---PAGE: wiki/concepts/attention.md---")
  })

  it("names the writable pages when creation is not allowed", () => {
    const prompt = buildReviewDecisionPrompt({
      item: makeItem(),
      decision: makeDecision(),
      pages: [],
    })
    expect(prompt).toContain("Write ONLY these pages: wiki/concepts/attention.md")
    expect(prompt).toContain("Never delete a page")
  })

  it("carries the output language directive", () => {
    useWikiStore.getState().setOutputLanguage("Korean")
    const prompt = buildReviewDecisionPrompt({
      item: makeItem(),
      decision: makeDecision(),
      pages: [],
    })
    expect(prompt).toContain("Korean")
  })
})

describe("validateReviewEdits", () => {
  const existing = new Map([["wiki/concepts/attention.md", PAGE]])

  it("accepts an edit to a selected target", () => {
    const after = `${PAGE}\nThe 2024 numbers land here.\n`
    const result = validateReviewEdits({
      blocks: [{ path: "wiki/concepts/attention.md", content: after }],
      decision: makeDecision(),
      existing,
    })
    expect(result.rejected).toEqual([])
    expect(result.edits).toHaveLength(1)
    expect(result.edits[0].op).toBe("update")
    expect(result.edits[0].before).toBe(PAGE)
  })

  it("refuses a page that was not selected", () => {
    const result = validateReviewEdits({
      blocks: [{ path: "wiki/concepts/other.md", content: PAGE }],
      decision: makeDecision(),
      existing,
    })
    expect(result.edits).toEqual([])
    expect(result.rejected[0]).toContain("not a selected target")
  })

  it("refuses a path that escapes the wiki", () => {
    const result = validateReviewEdits({
      blocks: [{ path: "wiki/../../etc/passwd", content: PAGE }],
      decision: makeDecision({ targets: ["wiki/../../etc/passwd"] }),
      existing,
    })
    expect(result.edits).toEqual([])
    expect(result.rejected[0]).toContain("unsafe path")
  })

  it("refuses output with no frontmatter", () => {
    const result = validateReviewEdits({
      blocks: [{ path: "wiki/concepts/attention.md", content: "# Attention\n\njust a body" }],
      decision: makeDecision(),
      existing,
    })
    expect(result.edits).toEqual([])
    expect(result.rejected[0]).toContain("no frontmatter")
  })

  it("refuses a body that shrank past the threshold", () => {
    const truncated = `---
type: concept
title: Attention
created: 2024-01-01
---

# Attention
`
    const result = validateReviewEdits({
      blocks: [{ path: "wiki/concepts/attention.md", content: truncated }],
      decision: makeDecision(),
      existing,
    })
    expect(result.edits).toEqual([])
    expect(result.rejected[0]).toContain("body shrank")
  })

  it("restores type / title / created when the model rewrites them", () => {
    const tampered = PAGE
      .replace("type: concept", "type: entity")
      .replace("title: Attention", "title: Self-Attention")
      .replace("created: 2024-01-01", "created: 2026-09-14")
      .replace("70% rule", "70% rule, updated for 2024,")
    const result = validateReviewEdits({
      blocks: [{ path: "wiki/concepts/attention.md", content: tampered }],
      decision: makeDecision(),
      existing,
    })
    expect(result.edits).toHaveLength(1)
    expect(result.edits[0].after).toContain("type: concept")
    expect(result.edits[0].after).toContain("title: Attention")
    expect(result.edits[0].after).toContain("created: 2024-01-01")
  })

  it("drops a block that changes nothing", () => {
    const result = validateReviewEdits({
      blocks: [{ path: "wiki/concepts/attention.md", content: PAGE }],
      decision: makeDecision(),
      existing,
    })
    expect(result.edits).toEqual([])
    expect(result.rejected[0]).toContain("no change")
  })

  it("allows a new page only when creation was allowed", () => {
    const blocks = [{ path: "wiki/concepts/new.md", content: PAGE }]
    const blocked = validateReviewEdits({ blocks, decision: makeDecision(), existing })
    expect(blocked.edits).toEqual([])

    const allowed = validateReviewEdits({
      blocks,
      decision: makeDecision({ allowCreate: true }),
      existing,
    })
    expect(allowed.edits).toHaveLength(1)
    expect(allowed.edits[0].op).toBe("create")
  })

  it("keeps only the first of two blocks for the same page", () => {
    const first = `${PAGE}\nfirst variant\n`
    const second = `${PAGE}\nsecond variant\n`
    const result = validateReviewEdits({
      blocks: [
        { path: "wiki/concepts/attention.md", content: first },
        { path: "wiki/concepts/attention.md", content: second },
      ],
      decision: makeDecision(),
      existing,
    })
    expect(result.edits).toHaveLength(1)
    expect(result.edits[0].after).toBe(first)
    expect(result.rejected[0]).toContain("duplicate block")
  })
})

describe("restoreLockedFields", () => {
  it("is a no-op when the page has no frontmatter to restore from", () => {
    expect(restoreLockedFields("no frontmatter", "after")).toBe("after")
  })
})

describe("staleProposalPaths", () => {
  const proposal: ReviewProposal = {
    reviewId: "review-0000abcd",
    createdAt: 0,
    model: "m",
    instruction: "i",
    edits: [
      { path: "wiki/a.md", op: "update", before: "A", after: "A2" },
      { path: "wiki/b.md", op: "update", before: "B", after: "B2" },
    ],
  }

  it("is empty while the wiki still matches the snapshot", () => {
    expect(staleProposalPaths(proposal, new Map([["wiki/a.md", "A"], ["wiki/b.md", "B"]]))).toEqual([])
  })

  it("names every page that changed underneath", () => {
    expect(staleProposalPaths(proposal, new Map([["wiki/a.md", "A"], ["wiki/b.md", "edited"]])))
      .toEqual(["wiki/b.md"])
  })

  it("treats a deleted page as changed", () => {
    expect(staleProposalPaths(proposal, new Map([["wiki/a.md", "A"]]))).toEqual(["wiki/b.md"])
  })
})

describe("condenseDiff", () => {
  it("collapses a long unchanged run between two edits", () => {
    const parts = [
      { type: "insert" as const, value: "new" },
      { type: "equal" as const, value: "x".repeat(1000) },
      { type: "delete" as const, value: "old" },
    ]
    const condensed = condenseDiff(parts, 100)
    expect(condensed.some((part) => part.type === "gap")).toBe(true)
    const kept = condensed
      .filter((part) => part.type === "equal")
      .reduce((sum, part) => sum + part.value.length, 0)
    expect(kept).toBe(200)
  })

  it("leaves short runs alone", () => {
    const parts = [{ type: "equal" as const, value: "short" }]
    expect(condenseDiff(parts, 100)).toEqual(parts)
  })
})

describe("summarizeApplied", () => {
  it("reads naturally for zero, one and many pages", () => {
    expect(summarizeApplied([])).toBe("No change")
    expect(summarizeApplied(["wiki/a.md"])).toBe("Updated: wiki/a.md")
    expect(summarizeApplied(["wiki/a.md", "wiki/b.md"])).toContain("2 pages")
  })
})
