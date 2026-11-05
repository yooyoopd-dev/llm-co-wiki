/**
 * Suite for the two pure helpers that run after a source is removed from
 * a page that has other sources left.
 *
 * The behaviour worth protecting:
 *
 *   1. The generated review item must NOT carry a `sourcePath`. It names
 *      a file that was just deleted, so `staleSourceReviewIds` would
 *      prune the very item that was created to flag the problem. The
 *      round-trip test below is the regression guard.
 *   2. Losing a second source later must produce a SECOND item, not
 *      collide with the first under `reviewIdFor` (type + title).
 *   3. Resolved items are never pruned — they record a decision already
 *      taken, and that history outlives the file.
 */
import { describe, it, expect } from "vitest"
import {
  buildSourceRemovalReview,
  staleSourceReviewIds,
  type RewrittenPage,
} from "./source-removal-followup"
import { reviewIdFor, type ReviewItem } from "@/stores/review-store"

const page: RewrittenPage = {
  relativePath: "wiki/concepts/rope.md",
  title: "Rotary Position Embedding",
  removed: ["b.pdf"],
  survivors: ["a.pdf", "c.pdf"],
}

function item(overrides: Partial<ReviewItem> = {}): ReviewItem {
  const base: ReviewItem = {
    id: "review-00000000",
    type: "confirm",
    title: "something",
    description: "",
    options: [],
    resolved: false,
    createdAt: 0,
  }
  return { ...base, ...overrides }
}

describe("buildSourceRemovalReview", () => {
  it("names the removed source and the page in the title", () => {
    const review = buildSourceRemovalReview(page)
    expect(review.title).toContain("Rotary Position Embedding")
    expect(review.title).toContain("b.pdf")
  })

  it("targets exactly the rewritten page", () => {
    expect(buildSourceRemovalReview(page).affectedPages).toEqual([
      "wiki/concepts/rope.md",
    ])
  })

  it("is a confirm item with a way to dismiss it untouched", () => {
    const review = buildSourceRemovalReview(page)
    expect(review.type).toBe("confirm")
    expect(review.options).toEqual([{ label: "Keep as is", action: "Keep as is" }])
  })

  it("does NOT set sourcePath — it would name the deleted file", () => {
    expect(buildSourceRemovalReview(page).sourcePath).toBeUndefined()
  })

  it("states the editing task, naming both the removed and surviving sources", () => {
    const { description } = buildSourceRemovalReview(page)
    expect(description).toContain("b.pdf")
    expect(description).toContain("a.pdf")
    expect(description).toContain("c.pdf")
    expect(description).toContain("wiki/concepts/rope.md")
    // The model has to be told to drop unsupported claims, not merely
    // that the sources list changed.
    expect(description.toLowerCase()).toContain("remove or rewrite")
  })

  it("collapses to single spaces so the prompt has no ragged whitespace", () => {
    const { description } = buildSourceRemovalReview(page)
    expect(description).not.toMatch(/\s{2,}/)
    expect(description).not.toMatch(/^\s|\s$/)
  })


  it("gives a DIFFERENT id when a second source is removed later", () => {
    const first = buildSourceRemovalReview(page)
    const second = buildSourceRemovalReview({
      ...page,
      removed: ["c.pdf"],
      survivors: ["a.pdf"],
    })
    expect(reviewIdFor(second)).not.toBe(reviewIdFor(first))
  })

  it("gives the SAME id for the same page losing the same source twice", () => {
    // Idempotence: a repeated delete (external watcher replay) must not
    // stack duplicate review items.
    expect(reviewIdFor(buildSourceRemovalReview(page))).toBe(
      reviewIdFor(buildSourceRemovalReview({ ...page })),
    )
  })

  it("handles several sources removed at once", () => {
    const review = buildSourceRemovalReview({
      ...page,
      removed: ["b.pdf", "d.pdf"],
      survivors: ["a.pdf"],
    })
    expect(review.title).toContain("b.pdf")
    expect(review.title).toContain("d.pdf")
  })
})

describe("staleSourceReviewIds", () => {
  const isRemoved = (p: string) => p === "b.pdf"

  it("returns an unresolved item whose source is gone", () => {
    const stale = item({ id: "review-aaaa0001", sourcePath: "b.pdf" })
    expect(staleSourceReviewIds([stale], isRemoved)).toEqual(["review-aaaa0001"])
  })

  it("keeps an item whose source still exists", () => {
    const live = item({ id: "review-aaaa0002", sourcePath: "a.pdf" })
    expect(staleSourceReviewIds([live], isRemoved)).toEqual([])
  })

  it("keeps a RESOLVED item even when its source is gone", () => {
    const done = item({ id: "review-aaaa0003", sourcePath: "b.pdf", resolved: true })
    expect(staleSourceReviewIds([done], isRemoved)).toEqual([])
  })

  it("keeps items with no sourcePath at all", () => {
    expect(staleSourceReviewIds([item({ id: "review-aaaa0004" })], isRemoved)).toEqual([])
  })

  it("treats a whitespace-only sourcePath as absent", () => {
    const blank = item({ id: "review-aaaa0005", sourcePath: "   " })
    expect(staleSourceReviewIds([blank], isRemoved)).toEqual([])
  })

  it("trims before matching, so ' b.pdf ' is still recognised", () => {
    const padded = item({ id: "review-aaaa0006", sourcePath: " b.pdf " })
    expect(staleSourceReviewIds([padded], isRemoved)).toEqual(["review-aaaa0006"])
  })

  it("returns an empty list for an empty store", () => {
    expect(staleSourceReviewIds([], isRemoved)).toEqual([])
  })

  it("picks out only the stale ones from a mixed store", () => {
    const items = [
      item({ id: "review-aaaa0010", sourcePath: "b.pdf" }),
      item({ id: "review-aaaa0011", sourcePath: "a.pdf" }),
      item({ id: "review-aaaa0012", sourcePath: "b.pdf", resolved: true }),
      item({ id: "review-aaaa0013" }),
    ]
    expect(staleSourceReviewIds(items, isRemoved)).toEqual(["review-aaaa0010"])
  })

  it("does not prune the follow-up item it just created (round trip)", () => {
    // The regression this file exists for. The follow-up item is about a
    // deleted source; if it carried that path, it would be swept away by
    // the same delete that created it.
    const created = buildSourceRemovalReview(page)
    const stored: ReviewItem = {
      ...created,
      id: reviewIdFor(created),
      resolved: false,
      createdAt: 0,
    }
    expect(staleSourceReviewIds([stored], (p) => p === "b.pdf")).toEqual([])
  })
})
