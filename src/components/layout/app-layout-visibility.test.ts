import { describe, expect, it } from "vitest"
import { getAppLayoutVisibility } from "./app-layout-visibility"

describe("getAppLayoutVisibility", () => {
  it("keeps chat standalone without project side panels", () => {
    // Chat owns its conversation list and reference preview area. It must not
    // also inherit the project knowledge/file panel used by workspace views.
    expect(getAppLayoutVisibility("chat")).toEqual({ showLeftPanel: false })
  })

  it("keeps settings a standalone view", () => {
    expect(getAppLayoutVisibility("settings")).toEqual({ showLeftPanel: false })
  })

  it("keeps skills as a standalone management view", () => {
    expect(getAppLayoutVisibility("skills")).toEqual({ showLeftPanel: false })
  })

  it("shows the project side panel in workspace views", () => {
    expect(getAppLayoutVisibility("wiki")).toEqual({ showLeftPanel: true })
    expect(getAppLayoutVisibility("search")).toEqual({ showLeftPanel: true })
  })
})
