import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * Tauri merges a platform config over the base one with `json_patch::merge`,
 * which is RFC 7386 JSON Merge Patch. Under that rule **arrays are replaced
 * wholesale, not merged element by element**, so a platform file that declares
 * `app.windows` discards every field the base entry had and did not repeat.
 *
 * That is not a theoretical hazard: `tauri.windows.conf.json` used to override
 * `app.windows` with only `label`, `hiddenTitle` and `titleBarStyle`, which
 * silently dropped `title`, `width` and `height` on Windows. The window then
 * fell back to Tauri's own defaults — `default_title()` in tauri-utils returns
 * the literal string "Tauri App", and the default size is 800x600 rather than
 * the 1200x800 the base config asks for.
 *
 * So: any platform file that overrides the window must repeat every key the
 * base window declares.
 */

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<string, unknown>
}

type WindowConfig = Record<string, unknown>

function windowEntries(config: Record<string, unknown>): WindowConfig[] | undefined {
  const app = config.app as Record<string, unknown> | undefined
  return app?.windows as WindowConfig[] | undefined
}

const PLATFORM_CONFIGS = [
  "../../src-tauri/tauri.windows.conf.json",
  "../../src-tauri/tauri.macos.conf.json",
  "../../src-tauri/tauri.linux.conf.json",
] as const

describe("tauri platform window config", () => {
  const base = readJson("../../src-tauri/tauri.conf.json")
  const baseWindows = windowEntries(base)

  it("the base config declares a window with an explicit title", () => {
    expect(baseWindows).toBeDefined()
    expect(baseWindows?.[0]?.title).toBe("LLM-CO-WIKI")
  })

  for (const path of PLATFORM_CONFIGS) {
    const name = path.split("/").pop()

    it(`${name} does not silently drop base window fields`, () => {
      const platformWindows = windowEntries(readJson(path))
      // Not overriding the array at all is fine — the base entry survives.
      if (!platformWindows) return

      expect(platformWindows.length).toBe(baseWindows?.length)
      platformWindows.forEach((platformWindow, index) => {
        const baseWindow = baseWindows?.[index] ?? {}
        const missing = Object.keys(baseWindow).filter(
          (key) => !Object.prototype.hasOwnProperty.call(platformWindow, key),
        )
        expect(
          missing,
          `${name} replaces app.windows[${index}] wholesale, so these base fields are lost and fall back to Tauri's defaults (title would become "Tauri App"): ${missing.join(", ")}`,
        ).toEqual([])
      })
    })
  }

  it("every platform that overrides the window keeps the product name as the title", () => {
    for (const path of PLATFORM_CONFIGS) {
      const platformWindow = windowEntries(readJson(path))?.[0]
      if (!platformWindow) continue
      expect(platformWindow.title, `${path} must not fall back to Tauri's default title`).toBe(
        "LLM-CO-WIKI",
      )
    }
  })
})
