/**
 * What has to happen to a wiki page *after* one of its several sources is
 * removed.
 *
 * Deleting a source already rewrites the `sources:` frontmatter of every
 * page that cited it (see `deleteSourceFiles`), but a page built from A
 * and B keeps B's prose in its body — only the provenance list changes.
 * Rewriting that body is a judgement call about meaning, so this module
 * does not attempt it: it turns each affected page into a review item and
 * lets the human drive the existing decision workflow.
 *
 * Pure on purpose. The delete path supplies the facts; nothing here reads
 * the filesystem or a store.
 */

import type { ReviewItem } from "@/stores/review-store"

/** A page that survived a source removal with its sources list rewritten. */
export interface RewrittenPage {
  /** Project-relative page path, e.g. `wiki/concepts/rope.md`. */
  relativePath: string
  /** Frontmatter title, or the slug when the page has no title. */
  title: string
  /** Source entries that were just dropped from this page. */
  removed: string[]
  /** Source entries still backing this page (never empty — an empty list
   *  means the page itself was deleted, so it never reaches here). */
  survivors: string[]
}

/** A review item ready for `useReviewStore.addItems`. */
export type NewReviewItem = Omit<ReviewItem, "id" | "resolved" | "createdAt">

function quoteList(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(", ")
}

/**
 * The review item for one page that outlived a source removal.
 *
 * The title carries the removed source names so that losing a second
 * source later produces a *separate* item rather than colliding with this
 * one under `reviewIdFor` (type + normalized title).
 *
 * The description is what the decision prompt sends to the model as
 * "Details", so it states the actual editing task — drop what only the
 * removed source supported, keep what the survivors still support — and
 * not merely that something changed.
 */
export function buildSourceRemovalReview(page: RewrittenPage): NewReviewItem {
  const removed = quoteList(page.removed)
  const survivors = quoteList(page.survivors)
  return {
    type: "confirm",
    title: `Re-check "${page.title}" after removing source ${removed}`,
    description: [
      `The source ${removed} was deleted from this project.`,
      `"${page.relativePath}" was built from it together with ${survivors}, so its`,
      `sources list no longer mentions the deleted source — but the page body was`,
      `left untouched and may still assert things only that source supported.`,
      `Remove or rewrite the statements that rested on the deleted source alone.`,
      `Keep everything still supported by ${survivors}, and do not add new claims.`,
    ].join(" "),
    // Deliberately no `sourcePath`: it would name the file that was just
    // deleted, which is exactly what `staleSourceReviewIds` prunes — this
    // item would delete itself. The removed source is named in the title
    // and description instead.
    affectedPages: [page.relativePath],
    options: [{ label: "Keep as is", action: "Keep as is" }],
  }
}

/**
 * Ids of review items that point at a source which no longer exists.
 *
 * Only unresolved items are returned: a resolved item is a record of a
 * decision already taken, and deleting that record would lose history.
 *
 * `isRemovedSource` is injected rather than imported so this stays pure —
 * the delete path owns the identity/basename matching rules and passes
 * them in.
 */
export function staleSourceReviewIds(
  items: readonly ReviewItem[],
  isRemovedSource: (sourcePath: string) => boolean,
): string[] {
  return items
    .filter((item) => !item.resolved)
    .filter((item) => {
      const path = item.sourcePath?.trim()
      return !!path && isRemovedSource(path)
    })
    .map((item) => item.id)
}
