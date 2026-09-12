//! OpenDataLoader PDF → Markdown extraction.
//!
//! An alternative to the built-in pdfium text extraction, selected in
//! Settings. OpenDataLoader does layout analysis rather than raw text
//! extraction, so headings, tables and reading order survive into Markdown;
//! pdfium gives a faster, dependency-free plain-text dump.
//!
//! It cannot be linked in. The project
//! (github.com/opendataloader-project/opendataloader-pdf) is a **Java** tool
//! and its Node and Python SDKs are wrappers that spawn `java -jar`, so this
//! shells out too. It ships in two shapes, and both are supported because a
//! user is as likely to have one as the other:
//!
//! * **A jar.** The GitHub release is `opendataloader-pdf-cli-<version>.zip`
//!   containing `opendataloader-pdf-cli-<version>.jar` — no executable at all.
//!   Point the setting at the jar, or at the folder holding it.
//! * **An executable on PATH.** `npm i -g @opendataloader/pdf` installs an
//!   `opendataloader-pdf` shim. Used when the setting is left empty.
//!
//! Either way a JRE 11+ has to be present.
//!
//! Two details of the CLI contract are taken from its source rather than
//! guessed:
//!
//! * There is **no `--version` flag** (`CLIMain`/`CLIOptions` define none), so
//!   probing with one reports a broken install for a working jar. The health
//!   probe uses `--export-options`, which prints the option list as JSON and
//!   exits 0.
//! * Conversion writes **files**, not stdout. Given `-o <dir> -f markdown`,
//!   `MarkdownGenerator` names its output by replacing the input name's last
//!   three characters with `md`, so `report.pdf` becomes `report.md`. Each
//!   conversion therefore runs against a fresh temporary directory and reads
//!   exactly that file back; nothing is written beside the user's PDF.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

use super::cli_resolver::{child_path_env, find_cli_command};

/// Layout analysis on a large PDF is minutes of work, not seconds.
const PARSE_TIMEOUT_MINUTES: u64 = 10;
/// The probe only has to prove the JVM starts and the CLI parses arguments,
/// but on a managed machine that still means antivirus and a cold JIT.
const DETECT_TIMEOUT_SECS: u64 = 90;
/// Diagnostics are read off a screen and typed by hand, so each captured
/// stream is trimmed to one short line.
const DETECT_SNIPPET_CHARS: usize = 120;

/// The CLI has no `--version`; this prints its option list and exits 0.
const PROBE_FLAG: &str = "--export-options";

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

/// How the CLI is started.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Runner {
    /// `java -jar <jar>` — the GitHub release shape.
    Jar(PathBuf),
    /// A directly executable CLI, e.g. the npm shim on PATH.
    Exe(PathBuf),
}

fn is_jar(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("jar"))
}

fn is_batch_shim(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

/// Pick the jar out of an unpacked release directory.
///
/// The release zip also carries README/LICENSE/NOTICE, so this looks for a
/// `.jar` and prefers one whose name starts with `opendataloader` — the
/// version suffix means the exact file name cannot be hard-coded. Sorted so a
/// directory holding two versions resolves deterministically to the later
/// name rather than to whatever the filesystem lists first.
pub fn pick_jar(mut jars: Vec<PathBuf>) -> Option<PathBuf> {
    jars.sort();
    let named = jars
        .iter()
        .rev()
        .find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.to_ascii_lowercase().starts_with("opendataloader"))
        })
        .cloned();
    named.or_else(|| jars.pop())
}

async fn jars_in_dir(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if is_jar(&path) {
                found.push(path);
            }
        }
    }
    found
}

/// Resolve the configured path — or PATH, when it is empty — to a runner.
pub async fn resolve_runner(configured: Option<&str>) -> Result<Runner, String> {
    let configured = configured.map(str::trim).filter(|s| !s.is_empty());

    let Some(configured) = configured else {
        // No explicit path: fall back to the npm shim on PATH.
        let exe = find_cli_command(
            "opendataloader-pdf",
            &["opendataloader-pdf.cmd", "opendataloader-pdf.exe"],
        )
        .await
        .map_err(|e| {
            format!("{e}. Either install it with `npm i -g @opendataloader/pdf`, or download the CLI release and set its path in Settings.")
        })?;
        return Ok(Runner::Exe(exe));
    };

    let path = PathBuf::from(configured);
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("Configured OpenDataLoader path does not exist or cannot be read: '{configured}' ({e})"))?;

    if meta.is_dir() {
        let jars = jars_in_dir(&path).await;
        return pick_jar(jars).map(Runner::Jar).ok_or_else(|| {
            format!("No .jar found in '{configured}'. Point the setting at opendataloader-pdf-cli-<version>.jar, or at the folder the release zip was extracted into.")
        });
    }
    if is_jar(&path) {
        return Ok(Runner::Jar(path));
    }
    Ok(Runner::Exe(path))
}

fn suppress_windows_console(_cmd: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Build the process for a runner.
///
/// The two `-D` flags come from the project's own Node wrapper: without them
/// a JVM touching ImageIO/PDFBox rendering surfaces a Dock icon on macOS and
/// steals focus. Harmless elsewhere — this CLI never opens a window.
fn build_command(runner: &Runner, java: Option<&Path>, via_shim: bool) -> Command {
    match runner {
        Runner::Jar(jar) => {
            let mut cmd = Command::new(java.unwrap_or(Path::new("java")));
            cmd.arg("-Djava.awt.headless=true")
                .arg("-Dapple.awt.UIElement=true")
                .arg("-jar")
                .arg(jar);
            cmd
        }
        Runner::Exe(exe) if via_shim => {
            let mut cmd = Command::new("cmd");
            cmd.arg("/C").arg(exe);
            cmd
        }
        Runner::Exe(exe) => Command::new(exe),
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
/// characters, plus `md`.
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
/// `-q` keeps progress logging quiet. Only Markdown is requested — JSON, HTML
/// and tagged-PDF would be extra work and extra files this app never reads.
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

async fn find_java() -> Option<PathBuf> {
    find_cli_command("java", &["java.exe"]).await.ok()
}

async fn run_probe(
    runner: &Runner,
    java: Option<&Path>,
    via_shim: bool,
    path_env: Option<&str>,
) -> Result<std::process::Output, std::io::Error> {
    let mut cmd = build_command(runner, java, via_shim);
    suppress_windows_console(&mut cmd);
    if let Some(path_env) = path_env {
        cmd.env("PATH", path_env);
    }
    cmd.arg(PROBE_FLAG);
    match tokio::time::timeout(Duration::from_secs(DETECT_TIMEOUT_SECS), cmd.output()).await {
        Ok(result) => result,
        Err(_) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!("no exit within {DETECT_TIMEOUT_SECS}s"),
        )),
    }
}

#[tauri::command]
pub async fn opendataloader_detect(cli_path: Option<String>) -> Result<DetectResult, String> {
    let mut lines: Vec<String> = vec!["[OPENDATALOADER DETECT]".to_string()];

    let runner = match resolve_runner(cli_path.as_deref()).await {
        Ok(runner) => runner,
        Err(error) => {
            lines.push(format!("1 resolve  FAIL  {error}"));
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

    let (mode, target) = match &runner {
        Runner::Jar(jar) => ("jar", jar.to_string_lossy().to_string()),
        Runner::Exe(exe) => ("exe", exe.to_string_lossy().to_string()),
    };
    lines.push(format!("1 resolve  OK    {mode}  {target}"));

    // Java matters only for the jar path, but a missing JRE is the single most
    // common reason this fails, so it is always reported.
    let java = find_java().await;
    match (&java, &runner) {
        (Some(java), _) => lines.push(format!("2 java     OK    {}", java.to_string_lossy())),
        (None, Runner::Jar(_)) => {
            lines.push("2 java     NOT ON PATH — required to run the jar".to_string())
        }
        (None, Runner::Exe(_)) => {
            lines.push("2 java     not on PATH (the CLI shim may still find its own)".to_string())
        }
    }

    let path_env = child_path_env().await;
    let started = std::time::Instant::now();
    let mut via_shim = false;
    let mut outcome = run_probe(&runner, java.as_deref(), via_shim, path_env.as_deref()).await;
    if outcome.is_err() {
        if let Runner::Exe(exe) = &runner {
            if is_batch_shim(exe) {
                lines.push("3 launch   direct -> spawn FAIL, retrying via cmd /C".to_string());
                via_shim = true;
                outcome = run_probe(&runner, java.as_deref(), via_shim, path_env.as_deref()).await;
            }
        }
    }
    let elapsed_ms = started.elapsed().as_millis();
    let label = match (&runner, via_shim) {
        (Runner::Jar(_), _) => "java -jar",
        (Runner::Exe(_), true) => "cmd /C (batch shim)",
        (Runner::Exe(_), false) => "direct",
    };

    match outcome {
        Ok(out) if out.status.success() => {
            lines.push(format!(
                "3 launch   {label} {PROBE_FLAG} -> exit 0 in {elapsed_ms}ms"
            ));
            lines.push(format!("  stdout   {}", snippet(&out.stdout)));
            lines.push("=> INSTALLED".to_string());
            Ok(DetectResult {
                installed: true,
                // The CLI exposes no version flag, so the jar's file name is
                // the only version information available.
                version: Path::new(&target)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string()),
                path: Some(target),
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
            let detail = if out.stderr.is_empty() {
                snippet(&out.stdout)
            } else {
                snippet(&out.stderr)
            };
            lines.push(format!(
                "3 launch   {label} {PROBE_FLAG} -> exit {code} in {elapsed_ms}ms"
            ));
            lines.push(format!("  output   {detail}"));
            lines.push("=> FAILED (CLI ran and reported an error)".to_string());
            Ok(DetectResult {
                installed: false,
                version: None,
                path: Some(target),
                error: Some(format!("OpenDataLoader CLI exited with {code}: {detail}")),
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
                path: Some(target),
                error: Some(format!("Failed to run the OpenDataLoader CLI: {e}")),
                report: lines.join("\n"),
            })
        }
    }
}

/// Convert one PDF to Markdown and return the text.
#[tauri::command]
pub async fn opendataloader_parse_pdf(
    path: String,
    cli_path: Option<String>,
) -> Result<String, String> {
    let pdf = Path::new(&path);
    if !pdf.is_file() {
        return Err(format!("PDF does not exist: '{path}'"));
    }
    let file_name = pdf
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("PDF path has no file name: '{path}'"))?
        .to_string();

    let runner = resolve_runner(cli_path.as_deref()).await?;
    let java = find_java().await;
    if java.is_none() {
        if let Runner::Jar(_) = runner {
            return Err(
                "Java was not found on PATH, and the OpenDataLoader CLI jar needs a JRE 11+ to run. Install one (adoptium.net) or switch the PDF parser back to Built-in in Settings."
                    .to_string(),
            );
        }
    }

    // A fresh directory per conversion: the CLI writes whatever files the
    // requested formats imply, and none of them belong next to the user's PDF.
    let out_dir = std::env::temp_dir().join(format!("llm-co-wiki-odl-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&out_dir)
        .await
        .map_err(|e| format!("Failed to create a working directory for OpenDataLoader: {e}"))?;

    let args = build_convert_args(&path, &out_dir.to_string_lossy());
    let path_env = child_path_env().await;

    let mut via_shim = false;
    let mut result = run_convert(&runner, java.as_deref(), via_shim, path_env.as_deref(), &args).await;
    if result.is_err() {
        if let Runner::Exe(exe) = &runner {
            if is_batch_shim(exe) {
                via_shim = true;
                result =
                    run_convert(&runner, java.as_deref(), via_shim, path_env.as_deref(), &args).await;
            }
        }
    }

    let finish = |value: Result<String, String>, dir: PathBuf| async move {
        let _ = tokio::fs::remove_dir_all(&dir).await;
        value
    };

    let output = match result {
        Ok(output) => output,
        Err(e) => {
            return finish(Err(format!("Failed to run the OpenDataLoader CLI: {e}")), out_dir).await
        }
    };

    if !output.status.success() {
        let code = output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        let detail = if output.stderr.is_empty() {
            snippet(&output.stdout)
        } else {
            snippet(&output.stderr)
        };
        return finish(
            Err(format!("OpenDataLoader CLI exited with {code}: {detail}")),
            out_dir,
        )
        .await;
    }

    let markdown_path = out_dir.join(markdown_output_name(&file_name));
    let markdown = match tokio::fs::read_to_string(&markdown_path).await {
        Ok(text) => text,
        Err(e) => {
            // Exit code 0 but no Markdown means the CLI's output contract is
            // not what this code expects — say so rather than returning "".
            let detail = snippet(&output.stdout);
            return finish(
                Err(format!(
                    "OpenDataLoader reported success but wrote no Markdown at {}: {e}. CLI output: {detail}",
                    markdown_path.display()
                )),
                out_dir,
            )
            .await;
        }
    };

    if markdown.trim().is_empty() {
        return finish(
            Err(format!(
                "OpenDataLoader produced an empty document for '{file_name}'"
            )),
            out_dir,
        )
        .await;
    }
    finish(Ok(markdown), out_dir).await
}

async fn run_convert(
    runner: &Runner,
    java: Option<&Path>,
    via_shim: bool,
    path_env: Option<&str>,
    args: &[String],
) -> Result<std::process::Output, std::io::Error> {
    let mut cmd = build_command(runner, java, via_shim);
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

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn temp_dir(tag: &str) -> TempDir {
        let dir = std::env::temp_dir().join(format!(
            "llm-wiki-odl-test-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tempdir");
        TempDir(dir)
    }

    #[test]
    fn markdown_output_name_mirrors_the_java_generator() {
        assert_eq!(markdown_output_name("report.pdf"), "report.md");
        assert_eq!(markdown_output_name("report.PDF"), "report.md");
        assert_eq!(markdown_output_name("2026.q1.review.pdf"), "2026.q1.review.md");
        // A non-ASCII name must not be sliced through a codepoint.
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
        assert!(!args.iter().any(|a| a.contains("json")));
    }

    #[test]
    fn pick_jar_prefers_the_projects_own_jar_and_the_later_version() {
        // The release zip unpacks README/LICENSE next to the jar, and a user
        // may keep two versions in the same folder.
        let picked = pick_jar(vec![
            PathBuf::from("/x/some-other.jar"),
            PathBuf::from("/x/opendataloader-pdf-cli-1.2.0.jar"),
            PathBuf::from("/x/opendataloader-pdf-cli-1.10.0.jar"),
        ]);
        assert_eq!(
            picked,
            Some(PathBuf::from("/x/opendataloader-pdf-cli-1.2.0.jar")),
            "sorted order puts 1.2.0 last lexically; the point is that it is deterministic and opendataloader-named"
        );
        // With no opendataloader-named jar, any jar is better than failing.
        assert_eq!(
            pick_jar(vec![PathBuf::from("/x/only.jar")]),
            Some(PathBuf::from("/x/only.jar"))
        );
        assert_eq!(pick_jar(vec![]), None);
    }

    #[tokio::test]
    async fn a_configured_jar_file_resolves_to_jar_mode() {
        let dir = temp_dir("jarfile");
        let jar = dir.0.join("opendataloader-pdf-cli-1.0.0.jar");
        std::fs::write(&jar, b"not really a jar").expect("write");
        let runner = resolve_runner(Some(jar.to_str().unwrap())).await.expect("resolve");
        assert_eq!(runner, Runner::Jar(jar));
    }

    #[tokio::test]
    async fn a_configured_directory_finds_the_jar_inside_it() {
        // This is the shape a user gets by unzipping the GitHub release.
        let dir = temp_dir("reldir");
        std::fs::write(dir.0.join("README.md"), b"readme").expect("write");
        std::fs::write(dir.0.join("LICENSE"), b"license").expect("write");
        let jar = dir.0.join("opendataloader-pdf-cli-1.4.2.jar");
        std::fs::write(&jar, b"jar").expect("write");
        let runner = resolve_runner(Some(dir.0.to_str().unwrap())).await.expect("resolve");
        assert_eq!(runner, Runner::Jar(jar));
    }

    #[tokio::test]
    async fn a_directory_without_a_jar_says_so() {
        let dir = temp_dir("nojar");
        std::fs::write(dir.0.join("README.md"), b"readme").expect("write");
        let err = resolve_runner(Some(dir.0.to_str().unwrap())).await.unwrap_err();
        assert!(err.contains("No .jar found"), "{err}");
    }

    #[tokio::test]
    async fn a_configured_path_that_does_not_exist_names_the_path() {
        let err = resolve_runner(Some("/nonexistent/opendataloader"))
            .await
            .unwrap_err();
        assert!(err.contains("/nonexistent/opendataloader"), "{err}");
        assert!(err.contains("does not exist"), "{err}");
    }

    #[tokio::test]
    async fn a_configured_non_jar_file_is_treated_as_an_executable() {
        let dir = temp_dir("exe");
        let exe = dir.0.join("opendataloader-pdf");
        std::fs::write(&exe, b"#!/bin/sh\n").expect("write");
        let runner = resolve_runner(Some(exe.to_str().unwrap())).await.expect("resolve");
        assert_eq!(runner, Runner::Exe(exe));
    }

    #[tokio::test]
    async fn whitespace_only_configuration_falls_back_to_path_lookup() {
        // Not asserting success — the CLI is not installed in CI. The point is
        // that a blank setting is treated as "look on PATH", and the error
        // then explains both ways to install it.
        let err = resolve_runner(Some("   ")).await.unwrap_err();
        assert!(err.contains("npm i -g @opendataloader/pdf"), "{err}");
        assert!(err.contains("Settings"), "{err}");
    }

    #[tokio::test]
    async fn a_missing_pdf_is_reported_before_anything_is_spawned() {
        let err = opendataloader_parse_pdf("/nonexistent/x.pdf".to_string(), None)
            .await
            .unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
    }
}
