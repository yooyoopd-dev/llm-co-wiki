import { invoke } from "@tauri-apps/api/core"

/**
 * OpenDataLoader PDF → Markdown.
 *
 * The heavy lifting is in Rust (`src-tauri/src/commands/opendataloader.rs`):
 * OpenDataLoader is a Java tool, so it is shelled out to rather than linked,
 * and the CLI writes files rather than printing to stdout. This wrapper only
 * exists so callers do not repeat the command name.
 */
export async function parsePdfWithOpenDataLoader(
  pdfPath: string,
  cliPath?: string,
): Promise<string> {
  return invoke<string>("opendataloader_parse_pdf", {
    path: pdfPath,
    // An empty setting means "look on PATH"; the Rust side treats null and
    // blank identically, but sending null keeps that explicit.
    cliPath: cliPath?.trim() || null,
  })
}

export interface OpenDataLoaderDetectResult {
  installed: boolean
  version: string | null
  path: string | null
  error: string | null
  /** Transcribable step-by-step report; see the Rust command. */
  report: string
}

export async function detectOpenDataLoader(cliPath?: string): Promise<OpenDataLoaderDetectResult> {
  return invoke<OpenDataLoaderDetectResult>("opendataloader_detect", {
    cliPath: cliPath?.trim() || null,
  })
}
