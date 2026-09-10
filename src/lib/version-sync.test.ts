import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

function readJson(path: URL): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
}

describe("release metadata", () => {
  it("keeps app manifests aligned on a single version", () => {
    const packageJson = readJson(new URL("../../package.json", import.meta.url))
    const tauriConfig = readJson(new URL("../../src-tauri/tauri.conf.json", import.meta.url))
    const cargoToml = readFileSync(
      new URL("../../src-tauri/Cargo.toml", import.meta.url),
      "utf8",
    )
    const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1]

    expect(tauriConfig.version).toBe(packageJson.version)
    expect(cargoVersion).toBe(packageJson.version)
  })
})
