import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

const embedPageMock = vi.fn(async () => true)
vi.mock("@/lib/embedding", () => ({
  embedPage: (...args: unknown[]) => embedPageMock(...(args as [])),
  removePageEmbedding: vi.fn(async () => undefined),
}))

import { deleteSourceFiles } from "./source-lifecycle"
import { useReviewStore, reviewIdFor } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"

describe("source lifecycle source deletion", () => {
  let tmp: { path: string; cleanup: () => Promise<void> } | undefined

  beforeEach(async () => {
    tmp = await createTempProject("source-lifecycle-delete")
    await writeFileRaw(`${tmp.path}/raw/sources/project-a/config.yaml`, "name: alpha\n")
    await writeFileRaw(`${tmp.path}/raw/sources/project-b/config.yaml`, "name: beta\n")
    await writeFileRaw(`${tmp.path}/wiki/log.md`, "# Wiki Log\n")
    await writeFileRaw(
      `${tmp.path}/wiki/concepts/shared.md`,
      [
        "---",
        'sources: ["project-a/config.yaml", "project-b/config.yaml"]',
        "---",
        "# Shared",
      ].join("\n"),
    )
    await writeFileRaw(
      `${tmp.path}/wiki/concepts/project-b-only.md`,
      [
        "---",
        'sources: ["project-b/config.yaml"]',
        "---",
        "# Project B",
      ].join("\n"),
    )
  })

  afterEach(async () => {
    await tmp?.cleanup()
    tmp = undefined
    useReviewStore.setState({ items: [] })
    // Leaving embedding on would make a later test re-index unexpectedly.
    useWikiStore.setState({
      embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "" },
    })
  })

  it("does not remove path-aware source references that only share a basename", async () => {
    if (!tmp) throw new Error("missing temp project")

    const result = await deleteSourceFiles(
      tmp.path,
      [`${tmp.path}/raw/sources/project-a/config.yaml`],
      { fileAlreadyDeleted: true },
    )

    await expect(readFileRaw(`${tmp.path}/wiki/concepts/shared.md`)).resolves.toContain(
      'sources: ["project-b/config.yaml"]',
    )
    await expect(readFileRaw(`${tmp.path}/wiki/concepts/project-b-only.md`)).resolves.toContain(
      'sources: ["project-b/config.yaml"]',
    )
    expect(result.deletedWikiPaths).toEqual([])
    expect(result.rewrittenSourcePages).toBe(1)
  })
  it("raises a review item for the page that kept a source but not its body", async () => {
    if (!tmp) throw new Error("missing temp project")
    useReviewStore.setState({ items: [] })

    await deleteSourceFiles(tmp.path, [`${tmp.path}/raw/sources/project-a/config.yaml`], {
      fileAlreadyDeleted: true,
    })

    const items = useReviewStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe("confirm")
    expect(items[0].resolved).toBe(false)
    expect(items[0].affectedPages).toEqual(["wiki/concepts/shared.md"])
    // Names the source that went away, so the decision prompt can act.
    expect(items[0].description).toContain("project-a/config.yaml")
    // And the one still backing the page, so the model keeps that content.
    expect(items[0].description).toContain("project-b/config.yaml")
  })

  it("raises NOTHING for a page that was deleted outright", async () => {
    if (!tmp) throw new Error("missing temp project")
    useReviewStore.setState({ items: [] })

    // project-b is the sole source of project-b-only.md, so that page is
    // deleted rather than rewritten — there is no surviving body to review.
    await deleteSourceFiles(tmp.path, [`${tmp.path}/raw/sources/project-b/config.yaml`], {
      fileAlreadyDeleted: true,
    })

    const titles = useReviewStore.getState().items.map((i) => i.affectedPages?.[0])
    expect(titles).not.toContain("wiki/concepts/project-b-only.md")
    // shared.md survives on project-a, so it IS raised.
    expect(titles).toEqual(["wiki/concepts/shared.md"])
  })

  it("drops an unresolved review item that pointed at the deleted source", async () => {
    if (!tmp) throw new Error("missing temp project")
    const stale = {
      type: "suggestion" as const,
      title: "Expand the alpha config notes",
      description: "",
      sourcePath: "project-a/config.yaml",
      options: [],
    }
    const keep = {
      type: "suggestion" as const,
      title: "Expand the beta config notes",
      description: "",
      sourcePath: "project-b/config.yaml",
      options: [],
    }
    useReviewStore.setState({
      items: [stale, keep].map((item) => ({
        ...item,
        id: reviewIdFor(item),
        resolved: false,
        createdAt: 0,
      })),
    })

    await deleteSourceFiles(tmp.path, [`${tmp.path}/raw/sources/project-a/config.yaml`], {
      fileAlreadyDeleted: true,
    })

    const titles = useReviewStore.getState().items.map((i) => i.title)
    expect(titles).not.toContain("Expand the alpha config notes")
    expect(titles).toContain("Expand the beta config notes")
  })

  it("keeps a RESOLVED review item whose source was deleted", async () => {
    if (!tmp) throw new Error("missing temp project")
    const done = {
      type: "suggestion" as const,
      title: "Already handled alpha note",
      description: "",
      sourcePath: "project-a/config.yaml",
      options: [],
    }
    useReviewStore.setState({
      items: [{ ...done, id: reviewIdFor(done), resolved: true, createdAt: 0 }],
    })

    await deleteSourceFiles(tmp.path, [`${tmp.path}/raw/sources/project-a/config.yaml`], {
      fileAlreadyDeleted: true,
    })

    expect(useReviewStore.getState().items.map((i) => i.title)).toContain(
      "Already handled alpha note",
    )
  })

  it("does not stack duplicate review items when the same delete replays", async () => {
    if (!tmp) throw new Error("missing temp project")
    useReviewStore.setState({ items: [] })
    const source = `${tmp.path}/raw/sources/project-a/config.yaml`

    await deleteSourceFiles(tmp.path, [source], { fileAlreadyDeleted: true })
    const afterFirst = useReviewStore.getState().items.length
    await deleteSourceFiles(tmp.path, [source], { fileAlreadyDeleted: true })

    expect(afterFirst).toBe(1)
    expect(useReviewStore.getState().items).toHaveLength(1)
  })
  it("re-indexes a page whose sources list shrank, so stale chunks do not linger", async () => {
    if (!tmp) throw new Error("missing temp project")
    embedPageMock.mockClear()
    useWikiStore.setState({
      embeddingConfig: { enabled: true, endpoint: "http://x", apiKey: "", model: "m" },
    })

    await deleteSourceFiles(tmp.path, [`${tmp.path}/raw/sources/project-a/config.yaml`], {
      fileAlreadyDeleted: true,
    })

    expect(embedPageMock).toHaveBeenCalledTimes(1)
    const [projectPath, slug, , content] = embedPageMock.mock.calls[0] as unknown as [
      string, string, string, string,
    ]
    expect(projectPath).toBe(tmp.path)
    expect(slug).toBe("shared")
    // Re-indexed from the file as it now stands, not the pre-delete text.
    expect(content).toContain('sources: ["project-b/config.yaml"]')
    expect(content).not.toContain("project-a/config.yaml")
  })

  it("does not touch the index when embedding is disabled", async () => {
    if (!tmp) throw new Error("missing temp project")
    embedPageMock.mockClear()
    useWikiStore.setState({
      embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "" },
    })

    await deleteSourceFiles(tmp.path, [`${tmp.path}/raw/sources/project-a/config.yaml`], {
      fileAlreadyDeleted: true,
    })

    expect(embedPageMock).not.toHaveBeenCalled()
  })
})
