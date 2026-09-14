/**
 * I/O half of the Review-tab decision workflow: read the target pages, ask
 * the model for rewrites, and — after the human has seen the diff — write
 * them.
 *
 * All decision logic lives in `review-decision.ts`; this module only moves
 * bytes and calls the LLM, so the rules stay testable without a filesystem.
 */
import { readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { withProjectLock } from "@/lib/project-mutex"
import { streamChat } from "@/lib/llm-client"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { getTaskLlmConfig } from "@/lib/llm-task-routing"
import { parseFileBlocks, currentWikiDate } from "@/lib/ingest"
import {
  buildReviewDecisionPrompt,
  normalizeTargetPath,
  staleProposalPaths,
  validateReviewEdits,
  type ReviewProposal,
  type ReviewTargetPage,
} from "@/lib/review-decision"
import { deleteProposal, saveProposal } from "@/lib/review-proposals"
import type { ReviewDecision, ReviewItem } from "@/stores/review-store"

/** Raised when the wiki changed under a proposal; the caller must regenerate. */
export class StaleProposalError extends Error {
  readonly paths: string[]
  constructor(paths: string[]) {
    super(`Pages changed since the proposal was generated: ${paths.join(", ")}`)
    this.name = "StaleProposalError"
    this.paths = paths
  }
}

async function readWikiPage(projectPath: string, wikiRelativePath: string): Promise<string> {
  try {
    return await readFile(`${normalizePath(projectPath)}/${wikiRelativePath}`)
  } catch {
    return ""
  }
}

export interface ProposeResult {
  proposal: ReviewProposal
  /** Blocks the model emitted that were refused, with the reason. */
  rejected: string[]
}

/**
 * Generate — but do not apply — the page rewrites for one decision.
 * The proposal is written to disk so it survives a restart; the caller
 * shows the diff and decides whether to apply it.
 */
export async function proposeReviewEdits(input: {
  projectPath: string
  item: ReviewItem
  decision: ReviewDecision
  signal?: AbortSignal
  onToken?: (token: string) => void
}): Promise<ProposeResult> {
  const { projectPath, item, decision, signal, onToken } = input
  const llmConfig = getTaskLlmConfig("ingest")
  if (!hasUsableLlm(llmConfig)) {
    throw new Error("No usable LLM is configured for wiki generation")
  }

  const targets = decision.targets.map((target) => normalizeTargetPath(target, projectPath))
  const pages: ReviewTargetPage[] = []
  const existing = new Map<string, string>()
  for (const target of targets) {
    const content = await readWikiPage(projectPath, target)
    existing.set(target, content)
    if (content) pages.push({ path: target, content })
  }

  const prompt = buildReviewDecisionPrompt({ item, decision, pages })

  let raw = ""
  let failure: Error | null = null
  await streamChat(
    llmConfig,
    [{ role: "user", content: prompt }],
    {
      onToken: (token) => {
        raw += token
        onToken?.(token)
      },
      onDone: () => {},
      onError: (err) => {
        failure = err
      },
    },
    signal,
    { temperature: 0.2 },
  )
  if (failure) throw failure

  const parsed = parseFileBlocks(raw)
  const { edits, rejected } = validateReviewEdits({
    blocks: parsed.blocks,
    decision,
    existing,
    projectPath,
  })

  const proposal: ReviewProposal = {
    reviewId: item.id,
    createdAt: Date.now(),
    model: llmConfig.model,
    instruction: decision.instruction,
    edits,
  }
  if (edits.length > 0) await saveProposal(projectPath, proposal)

  return { proposal, rejected: [...parsed.warnings, ...rejected] }
}

export interface ApplyResult {
  /** Wiki-relative paths actually written. */
  applied: string[]
}

/**
 * Write an approved proposal.
 *
 * Runs under the project lock so it cannot interleave with an ingest, and
 * re-reads every page first: a proposal built against content that has since
 * changed is refused outright rather than silently overwriting the change.
 */
export async function applyReviewProposal(input: {
  projectPath: string
  proposal: ReviewProposal
}): Promise<ApplyResult> {
  const pp = normalizePath(input.projectPath)
  return withProjectLock(pp, async () => {
    const { proposal } = input
    if (proposal.edits.length === 0) return { applied: [] }

    const current = new Map<string, string>()
    for (const edit of proposal.edits) {
      current.set(edit.path, await readWikiPage(pp, edit.path))
    }
    const stale = staleProposalPaths(proposal, current)
    if (stale.length > 0) throw new StaleProposalError(stale)

    const applied: string[] = []
    for (const edit of proposal.edits) {
      await writeFile(`${pp}/${edit.path}`, edit.after)
      applied.push(edit.path)
    }

    const created = proposal.edits.filter((edit) => edit.op === "create").map((e) => e.path)
    if (created.length > 0) await addPagesToIndex(pp, created)
    await appendReviewLog(pp, applied)

    await deleteProposal(pp, proposal.reviewId)
    return { applied }
  })
}

/** Link freshly created pages from `wiki/index.md`, matching the ingest layout. */
async function addPagesToIndex(projectPath: string, wikiPaths: string[]): Promise<void> {
  const indexPath = `${projectPath}/wiki/index.md`
  let index = ""
  try {
    index = await readFile(indexPath)
  } catch {
    index = "# Wiki Index\n"
  }
  for (const wikiPath of wikiPaths) {
    const relative = wikiPath.replace(/^wiki\//, "").replace(/\.md$/, "")
    const dir = relative.includes("/") ? relative.split("/")[0] : "queries"
    const heading = `## ${dir.charAt(0).toUpperCase()}${dir.slice(1)}`
    const entry = `- [[${relative}]]`
    if (index.includes(entry)) continue
    index = index.includes(heading)
      ? index.replace(heading, `${heading}\n${entry}`)
      : `${index.trimEnd()}\n\n${heading}\n${entry}\n`
  }
  await writeFile(indexPath, index)
}

async function appendReviewLog(projectPath: string, applied: string[]): Promise<void> {
  const logPath = `${projectPath}/wiki/log.md`
  let log = ""
  try {
    log = await readFile(logPath)
  } catch {
    log = "# Wiki Log\n"
  }
  const names = applied.map((path) => `\`${path}\``).join(", ")
  await writeFile(
    logPath,
    `${log.trimEnd()}\n- ${currentWikiDate()}: Applied review decision to ${names}\n`,
  )
}
