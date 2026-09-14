/**
 * Pure logic for the Review-tab decision workflow: turning a human's
 * decision about one review item into an LLM prompt, and vetting what the
 * model sends back before anything touches disk.
 *
 * Deliberately free of I/O and of LLM calls — `review-apply.ts` supplies
 * both — so every rule here is unit-testable, the same split `page-merge.ts`
 * already uses.
 */
import { parseFrontmatter } from "./frontmatter"
import { isSafeIngestPath } from "./ingest"
import { BODY_SHRINK_THRESHOLD, LOCKED_FIELDS, setFrontmatterScalar } from "./page-merge"
import { buildLanguageDirective } from "./output-language"
import type { ReviewDecision, ReviewDecisionKind, ReviewItem } from "@/stores/review-store"

/** A page the model may read and rewrite. */
export interface ReviewTargetPage {
  /** Wiki-relative path, e.g. `wiki/concepts/attention.md`. */
  path: string
  content: string
}

/** One accepted page rewrite inside a proposal. */
export interface ReviewPageEdit {
  path: string
  op: "update" | "create"
  /** Content as it was when the proposal was generated ("" for `create`). */
  before: string
  after: string
}

export interface ReviewProposal {
  reviewId: string
  createdAt: number
  /** Model identifier the proposal was generated with, for display only. */
  model: string
  instruction: string
  edits: ReviewPageEdit[]
}

export interface ValidatedEdits {
  edits: ReviewPageEdit[]
  /** Human-readable reasons for blocks that were refused. */
  rejected: string[]
}

/**
 * Normalize a page reference to the `wiki/...` form the FILE-block format
 * and `isSafeIngestPath` both expect. Review items name affected pages
 * inconsistently — `concepts/a`, `wiki/concepts/a.md`, or an absolute path
 * left over from an older ingest — and all three mean the same page.
 */
export function normalizeTargetPath(raw: string, projectPath = ""): string {
  let path = raw.trim().replace(/\\/g, "/")
  if (!path) return ""
  const project = projectPath.trim().replace(/\\/g, "/").replace(/\/+$/, "")
  if (project && path.startsWith(`${project}/`)) path = path.slice(project.length + 1)
  path = path.replace(/^\/+/, "")
  if (!path.startsWith("wiki/")) path = `wiki/${path}`
  if (!path.endsWith(".md")) path = `${path}.md`
  return path
}

/** Default target list for an item: its affected pages, deduped. */
export function defaultTargets(item: ReviewItem, projectPath = ""): string[] {
  const seen = new Set<string>()
  for (const page of item.affectedPages ?? []) {
    const normalized = normalizeTargetPath(page, projectPath)
    if (normalized) seen.add(normalized)
  }
  return [...seen]
}

/**
 * Instruction text pre-filled when the human picks a decision kind. It is
 * a starting point, not a constraint — the panel lets them edit it.
 */
export function defaultInstruction(kind: ReviewDecisionKind, item: ReviewItem): string {
  switch (kind) {
    case "keep":
      return ""
    case "apply-suggestion":
      return `Apply this review item to the target pages: ${item.title}`
    case "custom":
      return ""
  }
}

export function defaultDecision(
  kind: ReviewDecisionKind,
  item: ReviewItem,
  projectPath = "",
): ReviewDecision {
  return {
    kind,
    instruction: defaultInstruction(kind, item),
    targets: defaultTargets(item, projectPath),
    allowCreate: kind !== "keep" && defaultTargets(item, projectPath).length === 0,
    status: "draft",
  }
}

/** A decision that cannot produce a proposal yet, and why. */
export function decisionBlocker(decision: ReviewDecision): string | null {
  if (decision.kind === "keep") return null
  if (!decision.instruction.trim()) return "instruction"
  if (decision.targets.length === 0 && !decision.allowCreate) return "targets"
  return null
}

/**
 * Build the single prompt that turns a decision into page rewrites.
 *
 * One call, not a two-stage analyze/generate split like ingest: a review
 * decision touches a handful of known pages, so there is nothing for a
 * separate analysis pass to discover.
 */
export function buildReviewDecisionPrompt(input: {
  item: ReviewItem
  decision: ReviewDecision
  pages: ReviewTargetPage[]
}): string {
  const { item, decision, pages } = input
  const languageDirective = buildLanguageDirective(
    `${item.title}\n${item.description}\n${pages[0]?.content ?? ""}`,
  )

  const pageSections = pages.length > 0
    ? pages
        .map((page) => `---PAGE: ${page.path}---\n${page.content}\n---END PAGE---`)
        .join("\n\n")
    : "(no existing pages selected)"

  return [
    "You are updating a personal wiki after a human reviewed one flagged item.",
    "",
    languageDirective,
    "",
    "## Review item",
    `Type: ${item.type}`,
    `Title: ${item.title}`,
    item.description ? `Details: ${item.description}` : "",
    "",
    "## The human's decision — this outranks the review item's own wording",
    decision.instruction.trim(),
    "",
    "## Current pages",
    pageSections,
    "",
    "## Output format",
    "For every page you change, emit exactly one block:",
    "",
    "---FILE: wiki/<dir>/<name>.md---",
    "<the complete new file, frontmatter included>",
    "---END FILE---",
    "",
    "## Rules",
    "- Emit a block ONLY for pages you actually change. If nothing needs changing, output nothing at all.",
    "- Output the COMPLETE file, not a diff or a fragment. A partial file destroys the page.",
    "- Preserve existing wording. Change what the decision asks for and leave the rest byte-for-byte.",
    "- Never change the frontmatter fields type, title, or created.",
    "- Keep [[wikilink]] targets working. Never delete a page: if content moves elsewhere, leave the emptied page as a short redirect stub that links to its new home.",
    decision.allowCreate
      ? "- You may create a new page under wiki/ when the decision calls for one."
      : `- Write ONLY these pages: ${decision.targets.join(", ") || "(none)"}. Do not invent new files.`,
    "- No commentary before or after the blocks.",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

/**
 * Vet the model's parsed FILE blocks against the decision.
 *
 * Rejections are surfaced, never silently dropped: a refused edit means the
 * user's decision was not carried out, and they need to know that.
 */
export function validateReviewEdits(input: {
  blocks: { path: string; content: string }[]
  decision: ReviewDecision
  existing: Map<string, string>
  projectPath?: string
}): ValidatedEdits {
  const { blocks, decision, existing } = input
  const projectPath = input.projectPath ?? ""
  const allowed = new Set(decision.targets.map((target) => normalizeTargetPath(target, projectPath)))
  const edits: ReviewPageEdit[] = []
  const rejected: string[] = []
  const seen = new Set<string>()

  for (const block of blocks) {
    const path = normalizeTargetPath(block.path, projectPath)

    if (!isSafeIngestPath(path)) {
      rejected.push(`${block.path}: unsafe path`)
      continue
    }
    if (seen.has(path)) {
      rejected.push(`${path}: duplicate block`)
      continue
    }
    const before = existing.get(path) ?? ""
    const isCreate = before === ""
    if (!allowed.has(path) && !(decision.allowCreate && isCreate)) {
      rejected.push(`${path}: not a selected target`)
      continue
    }

    const parsed = parseFrontmatter(block.content)
    if (parsed.frontmatter === null) {
      rejected.push(`${path}: output has no frontmatter`)
      continue
    }

    if (!isCreate) {
      const beforeParsed = parseFrontmatter(before)
      const threshold = beforeParsed.body.length * BODY_SHRINK_THRESHOLD
      if (parsed.body.length < threshold) {
        rejected.push(
          `${path}: body shrank to ${parsed.body.length} chars, below ${Math.round(threshold)}`,
        )
        continue
      }
    }

    const after = isCreate ? block.content : restoreLockedFields(before, block.content)
    if (after === before) {
      rejected.push(`${path}: no change`)
      continue
    }

    seen.add(path)
    edits.push({ path, op: isCreate ? "create" : "update", before, after })
  }

  return { edits, rejected }
}

/**
 * Force type / title / created back to the values already on disk. Same
 * fields `page-merge` locks, for the same reason: they key wikilinks and
 * the on-disk layout, so a model rewriting them silently breaks the wiki.
 */
export function restoreLockedFields(before: string, after: string): string {
  const beforeFm = parseFrontmatter(before).frontmatter
  if (!beforeFm) return after
  let result = after
  for (const field of LOCKED_FIELDS) {
    const value = beforeFm[field]
    if (typeof value === "string" && value !== "") {
      result = setFrontmatterScalar(result, field, value)
    }
  }
  return result
}

/**
 * A proposal is stale when any page it was built from has changed since.
 * Applying a stale proposal would overwrite whatever changed in between,
 * so the UI must force a regenerate instead.
 */
export function staleProposalPaths(
  proposal: ReviewProposal,
  current: Map<string, string>,
): string[] {
  return proposal.edits
    .filter((edit) => (current.get(edit.path) ?? "") !== edit.before)
    .map((edit) => edit.path)
}

/**
 * Collapse long unchanged runs in a word diff so a whole-page rewrite stays
 * readable: only `context` characters survive on each side of a change.
 */
export function condenseDiff<T extends { type: "equal" | "insert" | "delete"; value: string }>(
  parts: T[],
  context = 120,
): (T | { type: "gap"; value: string })[] {
  return parts.flatMap((part, index) => {
    if (part.type !== "equal" || part.value.length <= context * 2) return [part]
    const isFirst = index === 0
    const isLast = index === parts.length - 1
    const head = isFirst ? "" : part.value.slice(0, context)
    const tail = isLast ? "" : part.value.slice(-context)
    const hidden = part.value.length - head.length - tail.length
    return [
      ...(head ? [{ ...part, value: head }] : []),
      { type: "gap" as const, value: `\n… ${hidden} unchanged characters …\n` },
      ...(tail ? [{ ...part, value: tail }] : []),
    ]
  })
}

/** Short summary stored in `resolvedAction` once an edit is applied. */
export function summarizeApplied(paths: string[]): string {
  if (paths.length === 0) return "No change"
  if (paths.length === 1) return `Updated: ${paths[0]}`
  return `Updated ${paths.length} pages: ${paths.join(", ")}`
}
