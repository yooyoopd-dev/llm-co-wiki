import { useCallback, useEffect, useMemo, useState } from "react"
import { Loader2, Play, Check, RotateCcw, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { useReviewStore, type ReviewDecision, type ReviewDecisionKind, type ReviewItem } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"
import { buildWordDiff } from "@/lib/selection-edit"
import { parseFrontmatter } from "@/lib/frontmatter"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { describeError } from "@/lib/error-detail"
import {
  condenseDiff,
  decisionBlocker,
  defaultDecision,
  defaultTargets,
  summarizeApplied,
  type ReviewPageEdit,
  type ReviewProposal,
} from "@/lib/review-decision"
import { applyReviewProposal, proposeReviewEdits, StaleProposalError } from "@/lib/review-apply"
import { deleteProposal, loadProposal } from "@/lib/review-proposals"

const KINDS: ReviewDecisionKind[] = ["keep", "apply-suggestion", "custom"]

/**
 * Per-item decision panel: the human says what should happen, the model
 * drafts the page rewrites, and nothing reaches the wiki until the diff has
 * been accepted.
 */
export function ReviewDecisionPanel({ item, projectPath }: { item: ReviewItem; projectPath: string }) {
  const { t } = useTranslation()
  const setStoredDecision = useReviewStore((s) => s.setDecision)
  const resolveItem = useReviewStore((s) => s.resolveItem)

  const [decision, setDecision] = useState<ReviewDecision>(
    () => item.decision ?? defaultDecision("apply-suggestion", item, projectPath),
  )
  const [proposal, setProposal] = useState<ReviewProposal | null>(null)
  const [running, setRunning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [streamed, setStreamed] = useState("")
  const [notes, setNotes] = useState<string[]>([])
  const [error, setError] = useState("")

  // A proposal generated in an earlier session lives on disk, not in the
  // store, so it has to be fetched before the diff can be shown again.
  useEffect(() => {
    if (!item.decision?.hasProposal) return
    let cancelled = false
    void loadProposal(projectPath, item.id).then((loaded) => {
      if (!cancelled && loaded) setProposal(loaded)
    })
    return () => { cancelled = true }
  }, [item.decision?.hasProposal, item.id, projectPath])

  const persist = useCallback(
    (next: ReviewDecision) => {
      setDecision(next)
      setStoredDecision(item.id, next)
    },
    [item.id, setStoredDecision],
  )

  const availableTargets = useMemo(() => {
    const fromItem = defaultTargets(item, projectPath)
    const fromDecision = decision.targets
    return [...new Set([...fromItem, ...fromDecision])]
  }, [decision.targets, item, projectPath])

  const chooseKind = useCallback(
    (kind: ReviewDecisionKind) => {
      const fresh = defaultDecision(kind, item, projectPath)
      // Keep whatever the user already typed or selected; only the parts
      // that are still at their default follow the new kind.
      persist({
        ...fresh,
        instruction: decision.instruction.trim() && decision.kind === "custom"
          ? decision.instruction
          : fresh.instruction,
        targets: decision.targets.length > 0 ? decision.targets : fresh.targets,
        allowCreate: decision.allowCreate || fresh.allowCreate,
      })
      setError("")
    },
    [decision, item, persist, projectPath],
  )

  const toggleTarget = useCallback(
    (path: string, selected: boolean) => {
      const targets = selected
        ? [...new Set([...decision.targets, path])]
        : decision.targets.filter((target) => target !== path)
      persist({ ...decision, targets })
    },
    [decision, persist],
  )

  const handleKeep = useCallback(() => {
    persist({ ...decision, kind: "keep", status: "applied", appliedAt: Date.now() })
    resolveItem(item.id, t("review.decision.keptAsIs"))
  }, [decision, item.id, persist, resolveItem, t])

  const handlePropose = useCallback(async () => {
    setRunning(true)
    setError("")
    setNotes([])
    setStreamed("")
    try {
      const result = await proposeReviewEdits({
        projectPath,
        item,
        decision,
        onToken: (token) => setStreamed((current) => (current + token).slice(-2000)),
      })
      setNotes(result.rejected)
      if (result.proposal.edits.length === 0) {
        setProposal(null)
        persist({ ...decision, status: "draft", hasProposal: false })
        setError(t("review.decision.noChanges"))
        return
      }
      setProposal(result.proposal)
      persist({ ...decision, status: "proposed", hasProposal: true, error: undefined })
    } catch (err) {
      persist({ ...decision, status: "failed", error: describeError(err).message })
      setError(describeError(err).message)
    } finally {
      setRunning(false)
      setStreamed("")
    }
  }, [decision, item, persist, projectPath, t])

  const handleApply = useCallback(async () => {
    if (!proposal) return
    setApplying(true)
    setError("")
    try {
      const { applied } = await applyReviewProposal({ projectPath, proposal })
      persist({
        ...decision,
        status: "applied",
        hasProposal: false,
        appliedPaths: applied,
        appliedAt: Date.now(),
        error: undefined,
      })
      setProposal(null)
      resolveItem(item.id, summarizeApplied(applied))
      await refreshProjectFileTree(projectPath, { bumpDataVersion: true })
      const first = applied[0]
      if (first) {
        const fullPath = `${projectPath.replace(/\/+$/, "")}/${first}`
        const written = proposal.edits.find((edit) => edit.path === first)
        if (written) useWikiStore.getState().openFileInPreview(fullPath, written.after)
      }
    } catch (err) {
      const message = err instanceof StaleProposalError
        ? t("review.decision.stale", { pages: err.paths.join(", ") })
        : describeError(err).message
      persist({ ...decision, status: "failed", error: message })
      setError(message)
    } finally {
      setApplying(false)
    }
  }, [decision, item.id, persist, projectPath, proposal, resolveItem, t])

  const handleDiscard = useCallback(async () => {
    setProposal(null)
    setNotes([])
    setError("")
    persist({ ...decision, status: "draft", hasProposal: false, error: undefined })
    await deleteProposal(projectPath, item.id)
  }, [decision, item.id, persist, projectPath])

  const blocker = decisionBlocker(decision)
  const busy = running || applying

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{t("review.decision.label")}</span>
        {KINDS.map((kind) => (
          <Button
            key={kind}
            variant={decision.kind === kind ? "default" : "outline"}
            size="sm"
            className="h-7 text-xs"
            disabled={busy}
            onClick={() => chooseKind(kind)}
          >
            {t(`review.decision.kind.${kind}`)}
          </Button>
        ))}
      </div>

      {decision.kind === "keep" ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{t("review.decision.keepHint")}</p>
          <Button size="sm" className="h-7 text-xs" onClick={handleKeep}>
            <Check className="mr-1 h-3 w-3" />
            {t("review.decision.confirmKeep")}
          </Button>
        </div>
      ) : (
        <>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">{t("review.decision.targets")}</div>
            {availableTargets.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("review.decision.noTargets")}</p>
            ) : (
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {availableTargets.map((path) => (
                  <label key={path} className="flex cursor-pointer items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5"
                      checked={decision.targets.includes(path)}
                      disabled={busy}
                      onChange={(event) => toggleTarget(path, event.target.checked)}
                    />
                    <span className="font-mono">{path}</span>
                  </label>
                ))}
              </div>
            )}
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="h-3.5 w-3.5"
                checked={decision.allowCreate}
                disabled={busy}
                onChange={(event) => persist({ ...decision, allowCreate: event.target.checked })}
              />
              {t("review.decision.allowCreate")}
            </label>
          </div>

          <textarea
            value={decision.instruction}
            onChange={(event) => persist({ ...decision, instruction: event.target.value })}
            placeholder={t("review.decision.instructionPlaceholder")}
            rows={3}
            disabled={busy}
            className="w-full resize-y rounded-md border border-input bg-background p-2 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={busy || blocker !== null}
              onClick={() => void handlePropose()}
            >
              {running ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Play className="mr-1 h-3 w-3" />}
              {proposal ? t("review.decision.regenerate") : t("review.decision.propose")}
            </Button>
            {blocker && (
              <span className="text-xs text-muted-foreground">
                {t(`review.decision.blocked.${blocker}`)}
              </span>
            )}
          </div>

          {running && streamed && (
            <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-2 font-mono text-[10px] leading-4 text-muted-foreground">
              {streamed}
            </pre>
          )}

          {notes.length > 0 && (
            <ul className="space-y-0.5 text-xs text-amber-600">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}

          {error && (
            <div className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              {error}
            </div>
          )}

          {proposal && proposal.edits.length > 0 && (
            <div className="space-y-2">
              {proposal.edits.map((edit) => (
                <ProposedEditDiff key={edit.path} edit={edit} />
              ))}
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" className="h-7 text-xs" disabled={busy} onClick={() => void handleApply()}>
                  {applying ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}
                  {t("review.decision.apply")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={busy}
                  onClick={() => void handlePropose()}
                >
                  <RotateCcw className="mr-1 h-3 w-3" />
                  {t("review.decision.regenerate")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={() => void handleDiscard()}
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  {t("review.decision.discard")}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** One page's before/after, rendered as a word diff with long runs collapsed. */
function ProposedEditDiff({ edit }: { edit: ReviewPageEdit }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(true)
  const parts = useMemo(
    () => condenseDiff(buildWordDiff(parseFrontmatter(edit.before).body, parseFrontmatter(edit.after).body)),
    [edit.after, edit.before],
  )

  return (
    <div className="rounded border border-border bg-background">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/40"
      >
        <span className="truncate font-mono">{edit.path}</span>
        <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
          {edit.op === "create" ? t("review.decision.opCreate") : t("review.decision.opUpdate")}
        </span>
      </button>
      {open && (
        <div className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-border p-2 font-mono text-[11px] leading-5">
          {parts.map((part, index) => (
            <span
              key={`${index}:${part.type}`}
              className={
                part.type === "delete"
                  ? "bg-destructive/10 text-destructive line-through"
                  : part.type === "insert"
                    ? "bg-primary/10 text-primary"
                    : part.type === "gap"
                      ? "text-muted-foreground/60"
                      : "text-foreground/80"
              }
            >
              {part.value}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
