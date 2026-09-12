import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import type { MineruLocalBackend, MineruModelVersion, MineruParseMethod } from "@/stores/wiki-store"
import { testMineruConnection } from "@/lib/mineru"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

type TestState = "idle" | "running" | "success" | "failed"

export function MineruSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const [testState, setTestState] = useState<TestState>("idle")
  const [testError, setTestError] = useState("")

  const handleTest = async () => {
    if (draft.mineruBackend === "cloud" && !draft.mineruToken.trim()) return
    setTestState("running")
    setTestError("")
    try {
      await testMineruConnection(draft.mineruToken.trim(), {
        backend: draft.mineruBackend,
        localEndpoint: draft.mineruLocalEndpoint,
        localToken: draft.mineruLocalToken.trim(),
      })
      setTestState("success")
    } catch (err) {
      setTestState("failed")
      setTestError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2 rounded-md border p-3">
        <h2 className="text-xl font-semibold">
          {t("settings.sections.pdfParser.title", { defaultValue: "PDF Parser" })}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("settings.sections.pdfParser.description", {
            defaultValue:
              "Which engine turns a PDF into text. MinerU below, when enabled, still takes precedence over this choice.",
          })}
        </p>
        <select
          value={draft.pdfParser}
          onChange={(e) => setDraft("pdfParser", e.target.value as SettingsDraft["pdfParser"])}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          <option value="preload">
            {t("settings.sections.pdfParser.preload", { defaultValue: "preload — built-in (pdfium)" })}
          </option>
          <option value="opendataloader">
            {t("settings.sections.pdfParser.opendataloader", {
              defaultValue: "opendataloader — layout-aware Markdown",
            })}
          </option>
        </select>
        <p className="text-xs text-muted-foreground">
          {draft.pdfParser === "opendataloader"
            ? t("settings.sections.pdfParser.opendataloaderHint", {
                defaultValue:
                  "Runs the OpenDataLoader PDF CLI locally: headings, tables and reading order survive into Markdown. Requires the CLI (`npm i -g @opendataloader/pdf` or `pip install opendataloader-pdf`) and a JRE 11+ on PATH. Nothing is uploaded.",
              })
            : t("settings.sections.pdfParser.preloadHint", {
                defaultValue:
                  "Built-in pdfium text extraction. Fast, no external dependency, but layout and tables are flattened to plain text.",
              })}
        </p>
        {draft.pdfParser === "opendataloader" && (
          <div className="space-y-1.5">
            <Label>
              {t("settings.sections.pdfParser.cliPath", { defaultValue: "CLI path (optional)" })}
            </Label>
            <Input
              value={draft.opendataloaderPath}
              onChange={(e) => setDraft("opendataloaderPath", e.target.value)}
              placeholder="D:\\Tools\\Parser\\opendataloader-pdf-cli"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.pdfParser.cliPathHint", {
                defaultValue:
                  "Point at the downloaded opendataloader-pdf-cli-<version>.jar, or the folder holding it — the jar runs through java. Leave empty to use an `opendataloader-pdf` command on PATH (npm install).",
              })}
            </p>
            <OpenDataLoaderStatus cliPath={draft.opendataloaderPath} />
          </div>
        )}
      </div>

      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.mineru.title", { defaultValue: "MinerU PDF Parser" })}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t("settings.sections.mineru.description", {
            defaultValue:
              "Use MinerU cloud or a self-hosted local service for higher quality PDF parsing (tables, formulas, complex layouts).",
          })}
        </p>
        {draft.mineruBackend === "cloud" && (
          <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            {t("settings.sections.mineru.privacyNotice", {
              defaultValue:
                "When enabled, PDF contents are uploaded to MinerU cloud for parsing. Do not enable this for sensitive documents unless you accept that.",
            })}
          </p>
        )}
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.mineruEnabled}
          onChange={(e) => setDraft("mineruEnabled", e.target.checked)}
          className="h-4 w-4"
        />
        <span className="text-sm">
          {t("settings.sections.mineru.enabled", { defaultValue: "Enable MinerU" })}
        </span>
      </label>

      {draft.mineruEnabled && (
        <div className="space-y-4 pl-1">
          <div className="space-y-2">
            <Label>{t("settings.sections.mineru.backend", { defaultValue: "Backend" })}</Label>
            <div className="space-y-1 pl-1">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={draft.mineruBackend === "cloud"}
                  onChange={() => {
                    setDraft("mineruBackend", "cloud")
                    setTestState("idle")
                  }}
                  className="h-4 w-4"
                />
                <span className="text-sm">
                  {t("settings.sections.mineru.cloudBackend", {
                    defaultValue: "Cloud (mineru.net) - requires token, higher quality",
                  })}
                </span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={draft.mineruBackend === "local"}
                  onChange={() => {
                    setDraft("mineruBackend", "local")
                    setTestState("idle")
                  }}
                  className="h-4 w-4"
                />
                <span className="text-sm">
                  {t("settings.sections.mineru.localBackend", {
                    defaultValue: "Official self-hosted mineru-api - private, offline",
                  })}
                </span>
              </label>
            </div>
          </div>

          {draft.mineruBackend === "cloud" && (
            <div className="space-y-2">
              <Label htmlFor="mineru-token">
                {t("settings.sections.mineru.token", { defaultValue: "API Token" })}
              </Label>
              <Input
                id="mineru-token"
                type="password"
                value={draft.mineruToken}
                onChange={(e) => {
                  setDraft("mineruToken", e.target.value)
                  setTestState("idle")
                }}
                placeholder={t("settings.sections.mineru.tokenHint", {
                  defaultValue: "Get your token from mineru.net",
                })}
              />
            </div>
          )}

          {draft.mineruBackend === "local" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="mineru-local-endpoint">
                  {t("settings.sections.mineru.localEndpoint", {
                    defaultValue: "Local service endpoint",
                  })}
                </Label>
                <Input
                  id="mineru-local-endpoint"
                  type="url"
                  value={draft.mineruLocalEndpoint}
                  onChange={(e) => {
                    setDraft("mineruLocalEndpoint", e.target.value)
                    setTestState("idle")
                  }}
                  placeholder="http://127.0.0.1:8000"
                />
                <p className="text-xs text-muted-foreground">
                  {t("settings.sections.mineru.localInfo", {
                    defaultValue:
                      "Base URL of an official mineru-api or mineru-router service.",
                  })}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="mineru-local-token">
                  {t("settings.sections.mineru.localToken", {
                    defaultValue: "Local API key (optional)",
                  })}
                </Label>
                <Input
                  id="mineru-local-token"
                  type="password"
                  value={draft.mineruLocalToken}
                  onChange={(e) => {
                    setDraft("mineruLocalToken", e.target.value)
                    setTestState("idle")
                  }}
                  placeholder={t("settings.sections.mineru.localTokenHint", {
                    defaultValue: "Sent as an Authorization: Bearer header",
                  })}
                />
              </div>
            </div>
          )}

          {draft.mineruBackend === "cloud" && <div className="space-y-2">
            <Label htmlFor="mineru-model">
              {t("settings.sections.mineru.model", { defaultValue: "Model Version" })}
            </Label>
            <select
              id="mineru-model"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={draft.mineruModelVersion}
              onChange={(e) =>
                setDraft("mineruModelVersion", e.target.value as MineruModelVersion)
              }
            >
              <option value="vlm">
                {t("settings.sections.mineru.modelVlm", {
                  defaultValue: "VLM (Recommended, best for complex layouts)",
                })}
              </option>
              <option value="pipeline">
                {t("settings.sections.mineru.modelPipeline", {
                  defaultValue: "Pipeline (Faster)",
                })}
              </option>
            </select>
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.mineru.modelHint", {
                defaultValue: "PDF parsing supports pipeline and vlm. MinerU-HTML is for HTML files and is not used here.",
              })}
            </p>
          </div>}

          {draft.mineruBackend === "local" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="mineru-local-backend">{t("settings.sections.mineru.parsingBackend")}</Label>
                <select
                  id="mineru-local-backend"
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={draft.mineruLocalBackend}
                  onChange={(e) => setDraft("mineruLocalBackend", e.target.value as MineruLocalBackend)}
                >
                  <option value="hybrid-engine">{t("settings.sections.mineru.backendHybrid")}</option>
                  <option value="pipeline">{t("settings.sections.mineru.backendPipeline")}</option>
                  <option value="vlm-engine">{t("settings.sections.mineru.backendVlm")}</option>
                  <option value="hybrid-http-client">{t("settings.sections.mineru.backendHybridHttp")}</option>
                  <option value="vlm-http-client">{t("settings.sections.mineru.backendVlmHttp")}</option>
                </select>
              </div>

              {draft.mineruLocalBackend.startsWith("hybrid-") && (
                <div className="space-y-2">
                  <Label htmlFor="mineru-effort">{t("settings.sections.mineru.effort")}</Label>
                  <select id="mineru-effort" className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={draft.mineruLocalEffort} onChange={(e) => setDraft("mineruLocalEffort", e.target.value as "medium" | "high")}>
                    <option value="medium">{t("settings.sections.mineru.effortMedium")}</option>
                    <option value="high">{t("settings.sections.mineru.effortHigh")}</option>
                  </select>
                </div>
              )}

              {(draft.mineruLocalBackend === "pipeline" || draft.mineruLocalBackend.startsWith("hybrid-")) && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="mineru-language">{t("settings.sections.mineru.ocrLanguage")}</Label>
                    <Input id="mineru-language" value={draft.mineruLocalLanguage} onChange={(e) => setDraft("mineruLocalLanguage", e.target.value)} placeholder="ch" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="mineru-parse-method">{t("settings.sections.mineru.parseMethod")}</Label>
                    <select id="mineru-parse-method" className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={draft.mineruLocalParseMethod} onChange={(e) => setDraft("mineruLocalParseMethod", e.target.value as MineruParseMethod)}>
                      <option value="auto">{t("settings.sections.mineru.parseAuto")}</option>
                      <option value="txt">{t("settings.sections.mineru.parseText")}</option>
                      <option value="ocr">{t("settings.sections.mineru.parseOcr")}</option>
                    </select>
                  </div>
                </div>
              )}

              {draft.mineruLocalBackend.endsWith("http-client") && (
                <div className="space-y-2">
                  <Label htmlFor="mineru-server-url">{t("settings.sections.mineru.serverUrl")}</Label>
                  <Input id="mineru-server-url" type="url" value={draft.mineruLocalServerUrl} onChange={(e) => setDraft("mineruLocalServerUrl", e.target.value)} placeholder="http://127.0.0.1:30000" />
                </div>
              )}

              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" checked={draft.mineruLocalFormulaEnabled} onChange={(e) => setDraft("mineruLocalFormulaEnabled", e.target.checked)} />{t("settings.sections.mineru.formulaParsing")}</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={draft.mineruLocalTableEnabled} onChange={(e) => setDraft("mineruLocalTableEnabled", e.target.checked)} />{t("settings.sections.mineru.tableParsing")}</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={draft.mineruLocalImageAnalysis} onChange={(e) => setDraft("mineruLocalImageAnalysis", e.target.checked)} />{t("settings.sections.mineru.imageAnalysis")}</label>
              </div>
            </div>
          )}
          {draft.mineruBackend === "cloud" && (
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              {t("settings.sections.mineru.testQuotaNotice", {
                defaultValue:
                  "Connection test submits a small demo file to MinerU and may consume a small amount of quota.",
              })}
            </p>
          )}

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handleTest}
              disabled={
                (draft.mineruBackend === "cloud" && !draft.mineruToken.trim()) ||
                (draft.mineruBackend === "local" && !draft.mineruLocalEndpoint.trim()) ||
                testState === "running"
              }
            >
              {testState === "running"
                ? t("settings.sections.mineru.testing", { defaultValue: "Testing..." })
                : t("settings.sections.mineru.test", {
                    defaultValue: "Test Connection",
                  })}
            </Button>
            {testState === "success" && (
              <span className="text-sm text-green-600">
                {t("settings.sections.mineru.testSuccess", {
                  defaultValue: "Connection successful",
                })}
              </span>
            )}
            {testState === "failed" && (
              <span className="text-sm text-red-600">
                {t("settings.sections.mineru.testFailed", {
                  defaultValue: "Test failed",
                })}
                : {testError}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Detection pill for the OpenDataLoader CLI.
 *
 * Selecting the parser is not the same as having it installed — it is an
 * external tool plus a JRE. Showing the result of a real probe here, rather
 * than at the first failed ingest, is the difference between a five-second
 * fix and a confusing error on a document. The report is the same
 * hand-transcribable block the Gemini CLI pill shows, for the same reason:
 * the machines that run this are often on isolated networks.
 */
function OpenDataLoaderStatus({ cliPath }: { cliPath: string }) {
  const { t } = useTranslation()
  const [state, setState] = useState<"idle" | "running" | "ok" | "err">("idle")
  const [result, setResult] = useState<{ version: string | null; report: string } | null>(null)

  async function detect() {
    setState("running")
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      const r = await invoke<{ installed: boolean; version: string | null; report: string }>(
        "opendataloader_detect",
        { cliPath: cliPath.trim() || null },
      )
      setResult({ version: r.version, report: r.report })
      setState(r.installed ? "ok" : "err")
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setResult({
        version: null,
        report: `[OPENDATALOADER DETECT]\n1 invoke   FAIL  ${message}\n=> FAILED (detect command did not run)`,
      })
      setState("err")
    }
  }

  return (
    <div className="space-y-1.5">
      <Button type="button" variant="outline" size="sm" onClick={() => void detect()} disabled={state === "running"}>
        {state === "running"
          ? t("settings.sections.pdfParser.checking", { defaultValue: "Checking…" })
          : t("settings.sections.pdfParser.check", { defaultValue: "Check installation" })}
      </Button>
      {result && (
        <>
          {state === "ok" && (
            <div className="text-xs text-emerald-700 dark:text-emerald-400">
              {t("settings.sections.pdfParser.detected", {
                defaultValue: "Detected{{version}}.",
                version: result.version ? ` ${result.version}` : "",
              })}
            </div>
          )}
          <pre className="select-all overflow-x-auto whitespace-pre rounded bg-background/60 p-2 font-mono text-[10px] leading-relaxed">
            {result.report}
          </pre>
        </>
      )}
    </div>
  )
}
