import { beforeEach, describe, expect, it, vi } from "vitest"

const files = new Map<string, string>()

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  createDirectory: vi.fn(),
}))
const llmMocks = vi.hoisted(() => ({ streamChat: vi.fn() }))
const routingMocks = vi.hoisted(() => ({
  getTaskLlmConfig: vi.fn(() => ({ provider: "ollama", model: "test-model", endpoint: "http://x" })),
}))
const usableMocks = vi.hoisted(() => ({ hasUsableLlm: vi.fn(() => true) }))

vi.mock("@/commands/fs", () => fsMocks)
vi.mock("@/lib/llm-client", () => llmMocks)
vi.mock("@/lib/llm-task-routing", () => routingMocks)
vi.mock("@/lib/has-usable-llm", () => usableMocks)

import { applyReviewProposal, proposeReviewEdits, StaleProposalError } from "./review-apply"
import type { ReviewProposal } from "./review-decision"
import type { ReviewDecision, ReviewItem } from "@/stores/review-store"

const PROJECT = "/tmp/proj"

const PAGE = `---
type: concept
title: Attention
created: 2024-01-01
---

# Attention

A body long enough that a rewrite has to keep most of it to pass the
shrink threshold, which is what makes this fixture useful at all.
`

const item: ReviewItem = {
  id: "review-0000abcd",
  type: "suggestion",
  title: "Add 2024 numbers",
  description: "The table stops at 2023.",
  affectedPages: ["concepts/attention"],
  options: [],
  resolved: false,
  createdAt: 0,
}

const decision: ReviewDecision = {
  kind: "custom",
  instruction: "add the 2024 numbers",
  targets: ["wiki/concepts/attention.md"],
  allowCreate: false,
  status: "draft",
}

/** Drive the streamChat mock to emit one canned response. */
function respondWith(text: string) {
  llmMocks.streamChat.mockImplementation(async (_config, _messages, callbacks) => {
    callbacks.onToken(text)
    callbacks.onDone()
  })
}

beforeEach(() => {
  files.clear()
  files.set(`${PROJECT}/wiki/concepts/attention.md`, PAGE)
  for (const mock of [fsMocks.readFile, fsMocks.writeFile, fsMocks.deleteFile, fsMocks.createDirectory]) {
    mock.mockReset()
  }
  llmMocks.streamChat.mockReset()
  usableMocks.hasUsableLlm.mockReturnValue(true)
  fsMocks.readFile.mockImplementation(async (path: string) => {
    const content = files.get(path)
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  })
  fsMocks.writeFile.mockImplementation(async (path: string, content: string) => {
    files.set(path, content)
  })
  fsMocks.deleteFile.mockImplementation(async (path: string) => {
    files.delete(path)
  })
  fsMocks.createDirectory.mockResolvedValue(undefined)
})

const EDITED = `${PAGE}\n2024 numbers: 71.4 on the new benchmark.\n`

describe("proposeReviewEdits", () => {
  it("turns a FILE block into a saved proposal without touching the page", async () => {
    respondWith(`---FILE: wiki/concepts/attention.md---\n${EDITED}---END FILE---`)

    const { proposal, rejected } = await proposeReviewEdits({ projectPath: PROJECT, item, decision })

    expect(rejected).toEqual([])
    expect(proposal.edits).toHaveLength(1)
    expect(proposal.edits[0].path).toBe("wiki/concepts/attention.md")
    expect(proposal.model).toBe("test-model")
    // The page itself is untouched; only the proposal file was written.
    expect(files.get(`${PROJECT}/wiki/concepts/attention.md`)).toBe(PAGE)
    expect(files.has(`${PROJECT}/.llm-wiki/review-proposals/review-0000abcd.json`)).toBe(true)
  })

  it("reports an empty proposal instead of inventing an edit", async () => {
    respondWith("Nothing needs changing.")
    const { proposal } = await proposeReviewEdits({ projectPath: PROJECT, item, decision })
    expect(proposal.edits).toEqual([])
    expect(files.has(`${PROJECT}/.llm-wiki/review-proposals/review-0000abcd.json`)).toBe(false)
  })

  it("surfaces a page the model tried to write outside the selected targets", async () => {
    respondWith(`---FILE: wiki/concepts/other.md---\n${EDITED}---END FILE---`)
    const { proposal, rejected } = await proposeReviewEdits({ projectPath: PROJECT, item, decision })
    expect(proposal.edits).toEqual([])
    expect(rejected.join(" ")).toContain("not a selected target")
  })

  it("propagates a streaming error rather than proposing nothing silently", async () => {
    llmMocks.streamChat.mockImplementation(async (_c, _m, callbacks) => {
      callbacks.onError(new Error("model exploded"))
    })
    await expect(proposeReviewEdits({ projectPath: PROJECT, item, decision }))
      .rejects.toThrow("model exploded")
  })

  it("refuses to run without a usable LLM", async () => {
    usableMocks.hasUsableLlm.mockReturnValue(false)
    await expect(proposeReviewEdits({ projectPath: PROJECT, item, decision }))
      .rejects.toThrow("No usable LLM")
  })
})

describe("applyReviewProposal", () => {
  function proposalFor(before: string): ReviewProposal {
    return {
      reviewId: item.id,
      createdAt: Date.now(),
      model: "test-model",
      instruction: decision.instruction,
      edits: [{ path: "wiki/concepts/attention.md", op: "update", before, after: EDITED }],
    }
  }

  it("writes the page, logs it, and removes the proposal file", async () => {
    files.set(`${PROJECT}/.llm-wiki/review-proposals/review-0000abcd.json`, "{}")

    const { applied } = await applyReviewProposal({ projectPath: PROJECT, proposal: proposalFor(PAGE) })

    expect(applied).toEqual(["wiki/concepts/attention.md"])
    expect(files.get(`${PROJECT}/wiki/concepts/attention.md`)).toBe(EDITED)
    expect(files.get(`${PROJECT}/wiki/log.md`)).toContain("Applied review decision")
    expect(files.has(`${PROJECT}/.llm-wiki/review-proposals/review-0000abcd.json`)).toBe(false)
  })

  it("refuses a proposal whose page changed underneath it", async () => {
    files.set(`${PROJECT}/wiki/concepts/attention.md`, `${PAGE}\nedited elsewhere\n`)

    await expect(applyReviewProposal({ projectPath: PROJECT, proposal: proposalFor(PAGE) }))
      .rejects.toBeInstanceOf(StaleProposalError)
    // The other edit must survive untouched.
    expect(files.get(`${PROJECT}/wiki/concepts/attention.md`)).toContain("edited elsewhere")
  })

  it("links a newly created page from the index", async () => {
    files.set(`${PROJECT}/wiki/index.md`, "# Wiki Index\n\n## Concepts\n- [[concepts/attention]]\n")
    const proposal: ReviewProposal = {
      reviewId: item.id,
      createdAt: Date.now(),
      model: "test-model",
      instruction: decision.instruction,
      edits: [{ path: "wiki/concepts/scaling.md", op: "create", before: "", after: PAGE }],
    }

    await applyReviewProposal({ projectPath: PROJECT, proposal })

    expect(files.get(`${PROJECT}/wiki/index.md`)).toContain("- [[concepts/scaling]]")
    expect(files.get(`${PROJECT}/wiki/concepts/scaling.md`)).toBe(PAGE)
  })

  it("does nothing for an empty proposal", async () => {
    const { applied } = await applyReviewProposal({
      projectPath: PROJECT,
      proposal: { reviewId: item.id, createdAt: 0, model: "m", instruction: "i", edits: [] },
    })
    expect(applied).toEqual([])
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })
})
