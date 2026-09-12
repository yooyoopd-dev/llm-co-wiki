//! OpenDataLoader PDF → Markdown extraction.
//!
//! An alternative to the built-in pdfium text extraction, selected in
//! Settings. OpenDataLoader does layout analysis rather than raw text
//! extraction, so headings, tables and reading order survive into Markdown;
//! pdfium gives a faster, dependency-free plain-text dump.
//!
//! It is not a library we can link. The project
//! (github.com/opendataloader-project/opendataloader-pdf) is a **Java** tool;
//! its Node and Python SDKs are wrappers that spawn `java -jar`. So this
//! shells out to the `opendataloader-pdf` CLI the user installs, exactly as
//! the Gemini CLI provider does, and the user needs both that CLI and a
//! JRE 11+ on PATH.
//!
//! The CLI writes files rather than printing to stdout: given
//! `-o <dir> -f markdown`, `MarkdownGenerator` names its output by replacing
//! the input's last three characters with `md`
//! (`java/.../markdown/MarkdownGenerator.java`), i.e. `report.pdf` becomes
//! `report.md` in the output directory. This runs it against a fresh
//! temporary directory and reads that one file back, so nothing is written
//! next to the user's source PDF.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

use super::cli_resolver::{child_path_env, find_cli_command};

/// Layout analysis on a large PDF is minutes of work, not seconds — the
/// budget has to cover a real document, not a smoke test.
const PARSE_TIMEOUT_MINUTES: u64 = 10;
/// `--version` only has to prove the JVM starts, but on a managed machine
/// that still means antivirus and a cold JIT.
const DETECT_TIMEOUT_SECS: u64 = 60;
/// Diagnostics are read off a screen and typed by hand, so each captured
/// stream is trimmed to one short line.
const DETECT_SNIPPET_CHARS: usize = 120;

#[derive(Serialize)]
pub struct DetectResult {
    installed: bool,
    version: Option<String>,
    path: Option<String>,
    error: Option<String>,
    /// Step-by-step account of what detection did, short enough to be read off
    /// a screen and typed into a ticket. Machines that run this are often on
    /// an isolated network where no log file can leave.
    report: String,
}

async fn find_opendataloader_command() -> Result<PathBuf, String> {
    find_cli_command(
        "opendataloader-pdf",
        &["opendataloader-pdf.cmd", "opendataloader-pdf.exe"],
    )
    .await
}

async fn find_java_command() -> Result<PathBuf, String> {
    find_cli_command("java", &["java.exe"]).await
}

fn suppress_windows_console(_cmd: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// npm installs the Windows entry point as a `.cmd` batch shim. Whether a
/// batch file can go straight to `CreateProcessW` differs between toolchain
/// versions, so such a target gets a second attempt through `cmd.exe /C`.
fn is_batch_shim(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

fn launcher(path: &Path, via_shim: bool) -> Command {
    if via_shim {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(path);
        cmd
    } else {
        Command::new(path)
    }
}

fn snippet(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.is_empty() {
        return "(empty)".to_string();
    }
    let mut out: String = joined.chars().take(DETECT_SNIPPET_CHARS).collect();
    if joined.chars().count() > DETECT_SNIPPET_CHARS {
        out.push('…');
    }
    out
}

/// The Markdown file the CLI will write for this input.
///
/// Mirrors `MarkdownGenerator`: the input's file name minus its last three
/// characters, plus `md`. Naming it here rather than globbing the directory
/// means a stale file from an earlier run could never be picked up — though
/// the directory is fresh anyway.
pub fn markdown_output_name(pdf_file_name: &str) -> String {
    let stem = if pdf_file_name.len() > 3 {
        &pdf_file_name[..pdf_file_name.len() - 3]
    } else {
        pdf_file_name
    };
    format!("{stem}md")
}

/// Arguments for a Markdown-only conversion into `output_dir`.
///
/// `-q` keeps the CLI's progress logging off stdout. Only Markdown is
/// requested — JSON, HTML and tagged-PDF outputs would be extra work and
/// extra files for output this app never reads.
pub fn build_convert_args(pdf_path: &str, output_dir: &str) -> Vec<String> {
    vec![
        pdf_path.to_string(),
        "-o".to_string(),
        output_dir.to_string(),
        "-f".to_string(),
        "markdown".to_string(),
        "-q".to_string(),
    ]
}

#[tauri::command]
pub async fn opendataloader_detect() -> Result<DetectResult, String> {
    let mut lines: Vec<String> = vec!["[OPENDATALOADER DETECT]".to_string()];

    // Java first: without a JRE the CLI resolves fine and then fails on every
    // document, which is a much more confusing way to find out.
    match find_java_command().await {
        Ok(java) => lines.push(format!("1 java     OK    {}", java.to_string_lossy())),
        Err(_) => lines.push("1 java     NOT ON PATH (JRE 11+ required)".to_string()),
    }

    let path = match find_opendataloader_command().await {
        Ok(p) => p,
        Err(error) => {
            lines.push(format!("2 resolve  FAIL  {error}"));
            lines.push("  install:  npm i -g @opendataloader/pdf".to_string());
            lines.push("=> NOT FOUND".to_string());
            return Ok(DetectResult {
                installed: false,
                version: None,
                path: None,
                error: Some(error),
                report: lines.join("\n"),
            });
        }
    };
    let path_str = path.to_string_lossy().to_string();
    lines.push(format!("2 resolve  OK    {path_str}"));

    let path_env = child_path_env().await;
    let mut via_shim = false;
    let started = std::time::Instant::now();
    let mut outcome = run_version(&path, via_shim, path_env.as_deref()).await;
    if outcome.is_err() && is_batch_shim(&path) {
        lines.push(format!(
            "3 launch   direct -> spawn FAIL after {}ms",
            started.elapsed().as_millis()
        ));
        via_shim = true;
        outcome = run_version(&path, via_shim, path_env.as_deref()).await;
    }
    let elapsed_ms = started.elapsed().as_millis();
    let label = if via_shim { "cmd /C (batch shim)" } else { "direct" };

    match outcome {
        Ok(out) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(str::trim)
                .rfind(|line| !line.is_empty())
                .map(str::to_string);
            lines.push(format!("3 launch   {label} -> exit 0 in {elapsed_ms}ms"));
            lines.push(format!("  stdout   {}", snippet(&out.stdout)));
            lines.push(format!(
                "=> INSTALLED {}",
                version.as_deref().unwrap_or("(no version line)")
            ));
            Ok(DetectResult {
                installed: true,
                version,
                path: Some(path_str),
                error: None,
                report: lines.join("\n"),
            })
        }
        Ok(out) => {
            let code = out
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".to_string());
            let stderr = snippet(&out.stderr);
            lines.push(format!("3 launch   {label} -> exit {code} in {elapsed_ms}ms"));
            lines.push(format!("  stderr   {stderr}"));
            lines.push("=> FAILED (CLI ran and reported an error)".to_string());
            Ok(DetectResult {
                installed: false,
                version: None,
                path: Some(path_str),
                error: Some(format!("`opendataloader-pdf --version` exited with {code}: {stderr}")),
                report: lines.join("\n"),
            })
        }
        Err(e) => {
            lines.push(format!("3 launch   {label} -> FAIL after {elapsed_ms}ms"));
            lines.push(format!("  detail   {e}"));
            lines.push("=> FAILED (could not start the process)".to_string());
            Ok(DetectResult {
                installed: false,
                version: None,
                path: Some(path_str),
                error: Some(format!("Failed to run opendataloader-pdf: {e}")),
                report: lines.join("\n"),
            })
        }
    }
}

async fn run_version(
    path: &Path,
    via_shim: bool,
    path_env: Option<&str>,
) -> Result<std::process::Output, std::io::Error> {
    let mut cmd = launcher(path, via_shim);
    suppress_windows_console(&mut cmd);
    if let Some(path_env) = path_env {
        cmd.env("PATH", path_env);
    }
    match tokio::time::timeout(
        Duration::from_secs(DETECT_TIMEOUT_SECS),
        cmd.arg("--version").output(),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!("no exit within {DETECT_TIMEOUT_SECS}s"),
        )),
    }
}

/// Convert one PDF to Markdown and return the text.
#[tauri::command]
pub async fn opendataloader_parse_pdf(path: String) -> Result<String, String> {
    let pdf = Path::new(&path);
    if !pdf.is_file() {
        return Err(format!("PDF does not exist: '{path}'"));
    }
    let file_name = pdf
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("PDF path has no file name: '{path}'"))?
        .to_string();

    let cli = find_opendataloader_command().await.map_err(|e| {
        format!("{e}. Install it with `npm i -g @opendataloader/pdf` (needs a JRE 11+), or switch the PDF parser back to Built-in in Settings.")
    })?;

    // A fresh directory per conversion: the CLI writes whatever files the
    // requested formats imply, and none of them belong next to the user's PDF.
    let out_dir = std::env::temp_dir().join(format!("llm-co-wiki-odl-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&out_dir)
        .await
        .map_err(|e| format!("Failed to create a working directory for OpenDataLoader: {e}"))?;
    let cleanup = |dir: PathBuf| async move {
        let _ = tokio::fs::remove_dir_all(&dir).await;
    };

    let args = build_convert_args(&path, &out_dir.to_string_lossy());
    let path_env = child_path_env().await;

    let mut via_shim = false;
    let mut result = run_convert(&cli, via_shim, path_env.as_deref(), &args).await;
    if result.is_err() && is_batch_shim(&cli) {
        via_shim = true;
        result = run_convert(&cli, via_shim, path_env.as_deref(), &args).await;
    }

    let output = match result {
        Ok(output) => output,
        Err(e) => {
            cleanup(out_dir).await;
            return Err(format!("Failed to run opendataloader-pdf: {e}"));
        }
    };

    if !output.status.success() {
        let code = output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        let detail = snippet(&output.stderr);
        cleanup(out_dir).await;
        return Err(format!(
            "opendataloader-pdf exited with {code}: {detail}"
        ));
    }

    let markdown_path = out_dir.join(markdown_output_name(&file_name));
    let markdown = match tokio::fs::read_to_string(&markdown_path).await {
        Ok(text) => text,
        Err(e) => {
            // Exit code 0 but no Markdown means the CLI's output contract is
            // not what this code expects — say so rather than returning "".
            let detail = snippet(&output.stdout);
            cleanup(out_dir).await;
            return Err(format!(
                "opendataloader-pdf reported success but wrote no Markdown at {}: {e}. CLI output: {detail}",
                markdown_path.display()
            ));
        }
    };
    cleanup(out_dir).await;

    if markdown.trim().is_empty() {
        return Err(format!(
            "opendataloader-pdf produced an empty document for '{file_name}'"
        ));
    }
    Ok(markdown)
}

async fn run_convert(
    cli: &Path,
    via_shim: bool,
    path_env: Option<&str>,
    args: &[String],
) -> Result<std::process::Output, std::io::Error> {
    let mut cmd = launcher(cli, via_shim);
    suppress_windows_console(&mut cmd);
    if let Some(path_env) = path_env {
        cmd.env("PATH", path_env);
    }
    cmd.args(args);
    match tokio::time::timeout(
        Duration::from_secs(PARSE_TIMEOUT_MINUTES * 60),
        cmd.output(),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!("no exit within {PARSE_TIMEOUT_MINUTES} minutes"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_output_name_mirrors_the_java_generator() {
        // MarkdownGenerator drops the last three characters and appends "md".
        assert_eq!(markdown_output_name("report.pdf"), "report.md");
        assert_eq!(markdown_output_name("report.PDF"), "report.md");
        // A dotted name keeps every earlier dot.
        assert_eq!(markdown_output_name("2026.q1.review.pdf"), "2026.q1.review.md");
        // Non-ASCII names must not be sliced through a codepoint.
        assert_eq!(markdown_output_name("보고서.pdf"), "보고서.md");
    }

    #[test]
    fn markdown_output_name_does_not_panic_on_a_short_name() {
        assert_eq!(markdown_output_name("a"), "amd");
        assert_eq!(markdown_output_name(""), "md");
    }

    #[test]
    fn convert_args_request_markdown_only_and_stay_quiet() {
        let args = build_convert_args("/tmp/in.pdf", "/tmp/out");
        assert_eq!(args[0], "/tmp/in.pdf", "input is positional and comes first");
        assert!(args.windows(2).any(|p| p[0] == "-o" && p[1] == "/tmp/out"));
        assert!(args.windows(2).any(|p| p[0] == "-f" && p[1] == "markdown"));
        assert!(args.contains(&"-q".to_string()));
        // Formats this app never reads would only cost time and disk.
        assert!(!args.iter().any(|a| a.contains("json")));
        assert!(!args.iter().any(|a| a.contains("html")));
    }

    #[tokio::test]
    async fn a_missing_pdf_is_reported_before_anything_is_spawned() {
        let err = opendataloader_parse_pdf("/nonexistent/x.pdf".to_string())
            .await
            .unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
    }
}
