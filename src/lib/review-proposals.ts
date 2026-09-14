/**
 * Disk storage for pending review proposals.
 *
 * Proposals hold the full before/after text of every page they touch, so
 * they are kept out of `review.json`: that file is rewritten in full on
 * every store change (`auto-save.ts`), and folding page bodies into it
 * would make each keystroke cost kilobytes per review item.
 *
 * One file per review item, deleted as soon as the proposal is applied or
 * discarded, so the directory tracks pending work rather than growing.
 */
import { createDirectory, deleteFile, readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { ReviewProposal } from "@/lib/review-decision"

function proposalDir(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/review-proposals`
}

/**
 * Review ids are `review-<8 hex>` by construction (`reviewIdFor`), but this
 * value reaches a filesystem path, so anything else is refused rather than
 * escaped.
 */
function proposalFileName(reviewId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(reviewId)) {
    throw new Error(`Invalid review id for a proposal file: ${reviewId}`)
  }
  return `${reviewId}.json`
}

export function proposalPath(projectPath: string, reviewId: string): string {
  return `${proposalDir(projectPath)}/${proposalFileName(reviewId)}`
}

export async function saveProposal(
  projectPath: string,
  proposal: ReviewProposal,
): Promise<void> {
  await createDirectory(proposalDir(projectPath))
  await writeFile(
    proposalPath(projectPath, proposal.reviewId),
    JSON.stringify(proposal, null, 2),
  )
}

/** Returns null when there is no proposal, or the stored one is unreadable. */
export async function loadProposal(
  projectPath: string,
  reviewId: string,
): Promise<ReviewProposal | null> {
  try {
    const raw = await readFile(proposalPath(projectPath, reviewId))
    const parsed = JSON.parse(raw) as ReviewProposal
    if (!parsed || !Array.isArray(parsed.edits)) return null
    return parsed
  } catch {
    return null
  }
}

export async function deleteProposal(projectPath: string, reviewId: string): Promise<void> {
  try {
    await deleteFile(proposalPath(projectPath, reviewId))
  } catch {
    // Already gone — the caller only cares that it is not there now.
  }
}
