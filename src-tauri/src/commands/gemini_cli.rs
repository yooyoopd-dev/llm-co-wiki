//! Gemini CLI subprocess transport.
//!
//! Sibling of `codex_cli.rs`, but Gemini CLI does not stream JSONL: with
//! `-o json` it prints a single envelope
//! (`{ session_id, response, stats, error }`) once the turn is finished, and
//! puts the *error* envelope on stderr with exit code 41. So there is nothing
//! to emit per line — this command collects stdout/stderr and fires one
//! `gemini-cli:{stream_id}:done` event; the TS transport opens the envelope.
//!
//! Flag choices and the failure modes they defend against are documented on
//! `build_gemini_cli_args`; they come from the measured behaviour of Gemini
//! CLI 0.58.0 recorded in yooyoopd-dev/co-secondbrain
//! (`app/src/core/agent/gemini.ts`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use super::cli_resolver::{child_path_env, find_cli_command};

#[derive(Default)]
pub struct GeminiCliState {
    children: Arc<Mutex<HashMap<String, Child>>>,
}

#[derive(Serialize)]
pub struct DetectResult {
    installed: bool,
    version: Option<String>,
    path: Option<String>,
    error: Option<String>,
    /// Step-by-step account of what detection actually did, short enough to be
    /// read off a screen and typed into a ticket by hand. Machines that run
    /// this CLI are often on an isolated network where no file can leave, so
    /// the report — not a log file — is the only thing that travels.
    report: String,
}

const GEMINI_SPAWN_TIMEOUT_MINUTES: u64 = 10;
/// `gemini --version` boots Node, reads the CLI's own settings and — on a
/// managed corporate machine — can wait on antivirus or a network check before
/// printing a line. Three seconds was not a real budget for that; the probe
/// reported "not installed" for a CLI that works fine in a terminal.
const GEMINI_DETECT_TIMEOUT_SECS: u64 = 30;
/// Diagnostics are meant to be copied by hand off a screen, so each captured
/// stream is trimmed to one short line.
const DETECT_SNIPPET_CHARS: usize = 120;
const STDERR_LIMIT_BYTES: usize = 1024 * 1024;
const STDOUT_LIMIT_BYTES: usize = 4 * 1024 * 1024;

fn append_capped_line(collected: &mut String, line: &str, limit_bytes: usize) {
    if collected.len() >= limit_bytes {
        return;
    }
    for ch in line.chars() {
        if collected.len() + ch.len_utf8() > limit_bytes {
            break;
        }
        collected.push(ch);
    }
    if collected.len() < limit_bytes {
        collected.push('\n');
    }
}

async fn find_gemini_command() -> Result<PathBuf, String> {
    find_cli_command("gemini", &["gemini.cmd", "gemini.exe"]).await
}

fn suppress_windows_console(_cmd: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Collapse a captured stream into one short, typeable line.
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

/// `gemini --version` prints update notices above the version itself, so the
/// version is the last non-empty line rather than the first.
fn version_from_stdout(stdout: &[u8]) -> Option<String> {
    String::from_utf8_lossy(stdout)
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .map(str::to_string)
}

/// Is this a Windows batch shim? npm installs the Windows entry point as
/// `gemini.cmd`. Whether a batch file can be handed straight to
/// `CreateProcessW` differs between toolchain versions, so a batch target gets
/// a second attempt through `cmd.exe /C` when the direct spawn is refused.
fn is_batch_shim(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

/// How to start the resolved CLI.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Launch {
    /// Spawn the resolved path itself. The default — it is what already works
    /// on macOS and Linux, and on Windows for a real `.exe`.
    Direct,
    /// Run it through `cmd.exe /C`, for a batch shim the OS refused to start.
    CmdShim,
}

impl Launch {
    fn label(self) -> &'static str {
        match self {
            Launch::Direct => "direct",
            Launch::CmdShim => "cmd /C (batch shim)",
        }
    }
}

fn launcher(path: &Path, launch: Launch) -> Command {
    match launch {
        Launch::Direct => Command::new(path),
        Launch::CmdShim => {
            let mut cmd = Command::new("cmd");
            cmd.arg("/C").arg(path);
            cmd
        }
    }
}

struct ProbeOutcome {
    launch: Launch,
    result: Result<std::process::Output, std::io::Error>,
    elapsed_ms: u128,
}

/// Run `--version` once with the given strategy.
async fn probe_version(path: &Path, launch: Launch, path_env: Option<&str>) -> ProbeOutcome {
    let mut cmd = launcher(path, launch);
    suppress_windows_console(&mut cmd);
    if let Some(path_env) = path_env {
        cmd.env("PATH", path_env);
    }
    let started = std::time::Instant::now();
    let result = match tokio::time::timeout(
        Duration::from_secs(GEMINI_DETECT_TIMEOUT_SECS),
        cmd.arg("--version").output(),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!("no exit within {GEMINI_DETECT_TIMEOUT_SECS}s"),
        )),
    };
    ProbeOutcome {
        launch,
        result,
        elapsed_ms: started.elapsed().as_millis(),
    }
}

#[tauri::command]
pub async fn gemini_cli_detect() -> Result<DetectResult, String> {
    let mut lines: Vec<String> = vec!["[GEMINI DETECT]".to_string()];

    let path = match find_gemini_command().await {
        Ok(p) => p,
        Err(error) => {
            lines.push(format!("1 resolve  FAIL  {error}"));
            lines.push("  candidates: gemini.cmd, gemini.exe, gemini (on PATH)".to_string());
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
    lines.push(format!("1 resolve  OK    {path_str}"));

    // `gemini` is a node shim; under a GUI launch the inherited PATH lacks
    // node, so hand it the login shell PATH or its shebang fails with
    // `env: node: No such file or directory`.
    let path_env = child_path_env().await;
    lines.push(format!(
        "2 PATH     {}",
        if path_env.is_some() {
            "login shell PATH prepended"
        } else {
            "inherited"
        }
    ));

    let mut outcome = probe_version(&path, Launch::Direct, path_env.as_deref()).await;
    // A batch shim the OS refused to start gets one retry through cmd.exe.
    if outcome.result.is_err() && is_batch_shim(&path) && outcome.launch == Launch::Direct {
        let first = outcome;
        lines.push(format!(
            "3 launch   {} -> spawn FAIL after {}ms",
            first.launch.label(),
            first.elapsed_ms
        ));
        if let Err(e) = &first.result {
            lines.push(format!("  detail   {e}"));
        }
        outcome = probe_version(&path, Launch::CmdShim, path_env.as_deref()).await;
    }

    let step = lines.len() + 1;
    match outcome.result {
        Ok(out) if out.status.success() => {
            let version = version_from_stdout(&out.stdout);
            lines.push(format!(
                "{step} launch   {} -> exit 0 in {}ms",
                outcome.launch.label(),
                outcome.elapsed_ms
            ));
            lines.push(format!("  stdout   {}", snippet(&out.stdout)));
            lines.push(format!("  stderr   {}", snippet(&out.stderr)));
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
            lines.push(format!(
                "{step} launch   {} -> exit {code} in {}ms",
                outcome.launch.label(),
                outcome.elapsed_ms
            ));
            lines.push(format!("  stdout   {}", snippet(&out.stdout)));
            lines.push(format!("  stderr   {stderr}"));
            lines.push("=> FAILED (CLI ran and reported an error)".to_string());
            Ok(DetectResult {
                installed: false,
                version: None,
                path: Some(path_str),
                error: Some(format!("`gemini --version` exited with {code}: {stderr}")),
                report: lines.join("\n"),
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
            lines.push(format!(
                "{step} launch   {} -> TIMEOUT after {}s",
                outcome.launch.label(),
                GEMINI_DETECT_TIMEOUT_SECS
            ));
            lines.push("  hint     time `gemini --version` in a terminal".to_string());
            lines.push("=> FAILED (timed out)".to_string());
            Ok(DetectResult {
                installed: false,
                version: None,
                path: Some(path_str),
                error: Some(format!(
                    "`gemini --version` did not finish within {GEMINI_DETECT_TIMEOUT_SECS}s"
                )),
                report: lines.join("\n"),
            })
        }
        Err(e) => {
            let os_code = e
                .raw_os_error()
                .map(|c| format!(" (os error {c})"))
                .unwrap_or_default();
            lines.push(format!(
                "{step} launch   {} -> spawn FAIL{os_code} after {}ms",
                outcome.launch.label(),
                outcome.elapsed_ms
            ));
            lines.push(format!("  detail   {e}"));
            lines.push("=> FAILED (could not start the process)".to_string());
            Ok(DetectResult {
                installed: false,
                version: None,
                path: Some(path_str),
                error: Some(format!("Failed to spawn `gemini`{os_code}: {e}")),
                report: lines.join("\n"),
            })
        }
    }
}

#[tauri::command]
pub async fn gemini_cli_spawn(
    app: AppHandle,
    state: State<'_, GeminiCliState>,
    stream_id: String,
    model: String,
    prompt: String,
    working_directory: Option<String>,
) -> Result<(), String> {
    if prompt.trim().is_empty() {
        return Err("No prompt to send to gemini CLI".to_string());
    }

    validate_model(&model)?;
    let working_directory = resolve_gemini_working_directory(working_directory).await?;
    let gemini = find_gemini_command().await?;
    let mut launch = Launch::Direct;
    let mut cmd = launcher(&gemini, launch);
    suppress_windows_console(&mut cmd);
    // See `gemini_cli_detect`: the node shim needs the login shell PATH at run
    // time so its shebang resolves `node` under a GUI launch.
    if let Some(path_env) = child_path_env().await {
        cmd.env("PATH", path_env);
    }
    cmd.args(build_gemini_cli_args(&model));
    cmd.current_dir(&working_directory);

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        // Mirrors detection: a batch shim the OS refused to start directly is
        // retried through cmd.exe. `model` is validated above so it cannot
        // introduce a second command when cmd re-parses the line.
        Err(first) if is_batch_shim(&gemini) && launch == Launch::Direct => {
            launch = Launch::CmdShim;
            let mut retry = launcher(&gemini, launch);
            suppress_windows_console(&mut retry);
            if let Some(path_env) = child_path_env().await {
                retry.env("PATH", path_env);
            }
            retry.args(build_gemini_cli_args(&model));
            retry.current_dir(&working_directory);
            retry
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            retry.spawn().map_err(|e| {
                format!("Failed to spawn gemini (direct: {first}; via cmd /C: {e})")
            })?
        }
        Err(e) => return Err(format!("Failed to spawn gemini: {e}")),
    };

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Missing stdin handle".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Missing stdout handle".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Missing stderr handle".to_string())?;

    stdin
        .write_all(prompt.as_bytes())
        .await
        .map_err(|e| format!("Failed to write to gemini stdin: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush gemini stdin: {e}"))?;
    drop(stdin);

    state.children.lock().await.insert(stream_id.clone(), child);

    let children = Arc::clone(&state.children);
    let timeout_children = Arc::clone(&state.children);
    let timed_out = Arc::new(AtomicBool::new(false));
    let timeout_flag = Arc::clone(&timed_out);
    let timeout_stream_id = stream_id.clone();
    let timeout_duration = Duration::from_secs(GEMINI_SPAWN_TIMEOUT_MINUTES * 60);
    let app_for_task = app.clone();
    let stream_id_task = stream_id.clone();
    let done_topic = format!("gemini-cli:{stream_id}:done");

    tokio::spawn(async move {
        tokio::time::sleep(timeout_duration).await;
        if let Some(mut child) = timeout_children.lock().await.remove(&timeout_stream_id) {
            timeout_flag.store(true, Ordering::SeqCst);
            let _ = child.start_kill();
        }
    });

    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut stderr_reader = BufReader::new(stderr).lines();
        let app = app_for_task;

        let stderr_task = tokio::spawn(async move {
            let mut collected = String::new();
            while let Ok(Some(line)) = stderr_reader.next_line().await {
                eprintln!("[gemini-cli stderr] {line}");
                append_capped_line(&mut collected, &line, STDERR_LIMIT_BYTES);
            }
            collected
        });

        // Unlike Codex, nothing is emitted per line: the whole answer arrives
        // as one JSON envelope, so the buffer is only handed over at the end.
        let mut stdout_text = String::new();
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => append_capped_line(&mut stdout_text, &line, STDOUT_LIMIT_BYTES),
                Ok(None) => break,
                Err(e) => {
                    eprintln!("[gemini-cli stdout] read error: {e}");
                    break;
                }
            }
        }

        let child_opt = children.lock().await.remove(&stream_id_task);
        let exit_code = if let Some(mut child) = child_opt {
            match child.wait().await {
                Ok(status) => status.code(),
                Err(_) => None,
            }
        } else {
            None
        };

        let mut stderr_text = stderr_task.await.unwrap_or_default();
        if timed_out.load(Ordering::SeqCst) {
            if !stderr_text.is_empty() {
                stderr_text.push('\n');
            }
            stderr_text.push_str(&format!(
                "Gemini CLI timed out after {GEMINI_SPAWN_TIMEOUT_MINUTES} minutes."
            ));
        } else if stderr_text.len() >= STDERR_LIMIT_BYTES {
            stderr_text.push_str("\n[stderr truncated]");
        }
        if stdout_text.len() >= STDOUT_LIMIT_BYTES {
            stdout_text.push_str("\n[stdout truncated]");
        }

        let code = if timed_out.load(Ordering::SeqCst) {
            Some(-1)
        } else {
            exit_code
        };

        let _ = app.emit(
            &done_topic,
            serde_json::json!({
                "code": code,
                "stderr": stderr_text,
                "stdout": stdout_text,
            }),
        );
    });

    Ok(())
}

/// Flags, and why each one is here:
///
/// * `--skip-trust` — clears the folder-trust gate. Without it the CLI can
///   refuse to run in a project directory it has not been told to trust.
/// * `--approval-mode plan` — read-only. The model may look at the project
///   but cannot write files or run commands; this transport is a completion
///   engine, not an agent with a workspace.
/// * `-o json` — the machine-readable envelope. Plain stdout mixes the answer
///   with the CLI's own chrome.
/// * `-m <model>` — the preset's model id.
///
/// The prompt deliberately does *not* go through `-p`: it is written to stdin,
/// so a long prompt cannot hit the platform's argv length limit.
/// On Windows a batch shim is launched through `cmd.exe`, which re-parses the
/// command line — so a model id carrying `&`, `|` or `^` would become a second
/// command. Model ids are vendor identifiers; restrict them to the characters
/// those actually use rather than trying to quote for two parsers at once.
fn validate_model(model: &str) -> Result<(), String> {
    let model = model.trim();
    if model
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
    {
        return Ok(());
    }
    Err(format!(
        "Gemini CLI model id may only contain letters, digits, '.', '_', '-' and ':': {model}"
    ))
}

fn build_gemini_cli_args(model: &str) -> Vec<String> {
    let mut args = vec![
        "--skip-trust".to_string(),
        "--approval-mode".to_string(),
        "plan".to_string(),
        "-o".to_string(),
        "json".to_string(),
    ];
    let model = model.trim();
    if !model.is_empty() {
        args.extend(["-m".to_string(), model.to_string()]);
    }
    args
}

async fn resolve_gemini_working_directory(value: Option<String>) -> Result<PathBuf, String> {
    let raw = value
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Gemini CLI requires an active project working directory".to_string())?;
    let path = Path::new(raw.as_str());
    if !path.is_absolute() {
        return Err("Gemini CLI working directory must be an absolute project path".to_string());
    }
    let path_meta = tokio::fs::metadata(path).await.map_err(|e| {
        eprintln!("[gemini-cli] failed to read working directory metadata {raw}: {e}");
        format!("Gemini CLI working directory does not exist or cannot be read: {raw}")
    })?;
    if !path_meta.is_dir() {
        return Err(format!(
            "Gemini CLI working directory is not a directory: {raw}"
        ));
    }
    let index_path = path.join("wiki").join("index.md");
    let index_meta = tokio::fs::metadata(&index_path).await.map_err(|e| {
        eprintln!("[gemini-cli] failed to read wiki/index.md metadata for {raw}: {e}");
        format!("Gemini CLI working directory must be an LLM-CO-WIKI project containing wiki/index.md: {raw}")
    })?;
    if !index_meta.is_file() {
        return Err(format!(
            "Gemini CLI working directory must be an LLM-CO-WIKI project containing wiki/index.md: {raw}"
        ));
    }
    tokio::fs::canonicalize(path)
        .await
        .map_err(|e| format!("Failed to canonicalize Gemini CLI working directory {raw}: {e}"))
}

#[tauri::command]
pub async fn gemini_cli_kill(
    state: State<'_, GeminiCliState>,
    stream_id: String,
) -> Result<(), String> {
    if let Some(mut child) = state.children.lock().await.remove(&stream_id) {
        let _ = child.start_kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_capped_line_never_exceeds_limit() {
        let mut out = String::new();
        append_capped_line(&mut out, "abcdef", 4);
        assert_eq!(out, "abcd");
        append_capped_line(&mut out, "ignored", 4);
        assert_eq!(out, "abcd");
    }

    #[test]
    fn append_capped_line_preserves_utf8_boundaries() {
        let mut out = String::new();
        append_capped_line(&mut out, "é水x", 5);
        assert_eq!(out, "é水");
        assert_eq!(out.len(), 5);
        assert!(std::str::from_utf8(out.as_bytes()).is_ok());
    }

    #[test]
    fn snippet_collapses_whitespace_and_marks_truncation() {
        assert_eq!(snippet(b"  0.59.0 \n"), "0.59.0");
        assert_eq!(snippet(b"   "), "(empty)");
        assert_eq!(snippet(b""), "(empty)");
        assert_eq!(snippet(b"line one\nline two"), "line one line two");
        let long = "x".repeat(DETECT_SNIPPET_CHARS + 10);
        let out = snippet(long.as_bytes());
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().count(), DETECT_SNIPPET_CHARS + 1);
    }

    #[test]
    fn version_is_the_last_non_empty_line_not_the_first() {
        // An update notice above the version is the case that broke a naive
        // "first line" read.
        assert_eq!(
            version_from_stdout(b"Update available 0.58.0 -> 0.59.0\n\n0.59.0\n").as_deref(),
            Some("0.59.0")
        );
        assert_eq!(version_from_stdout(b"0.59.0").as_deref(), Some("0.59.0"));
        assert_eq!(version_from_stdout(b"   \n\n"), None);
    }

    #[test]
    fn validate_model_accepts_real_ids_and_rejects_shell_metacharacters() {
        assert!(validate_model("gemini-2.5-pro").is_ok());
        assert!(validate_model("models/gemini_1.5:latest").is_err());
        assert!(validate_model("").is_ok());
        for bad in ["a&calc", "a|b", "a^b", "a>b", "a b", "a\"b"] {
            assert!(validate_model(bad).is_err(), "should reject {bad}");
        }
    }

    #[test]
    fn gemini_args_are_read_only_and_machine_readable() {
        let args = build_gemini_cli_args("gemini-2.5-pro");
        assert!(args.contains(&"--skip-trust".to_string()));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--approval-mode" && pair[1] == "plan"));
        assert!(args.windows(2).any(|pair| pair[0] == "-o" && pair[1] == "json"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-m" && pair[1] == "gemini-2.5-pro"));
        // The prompt goes over stdin, never as an argument.
        assert!(!args.contains(&"-p".to_string()));
    }

    #[test]
    fn gemini_args_omit_the_model_flag_when_no_model_is_set() {
        let args = build_gemini_cli_args("   ");
        assert!(!args.contains(&"-m".to_string()));
    }

    struct TestDir(PathBuf);

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn gemini_working_directory_requires_absolute_existing_project() {
        assert!(resolve_gemini_working_directory(None)
            .await
            .unwrap_err()
            .contains("requires an active project"));
        assert!(resolve_gemini_working_directory(Some("   ".to_string()))
            .await
            .unwrap_err()
            .contains("requires an active project"));
        assert!(
            resolve_gemini_working_directory(Some("relative/project".to_string()))
                .await
                .unwrap_err()
                .contains("absolute")
        );

        let missing =
            std::env::temp_dir().join(format!("llm-wiki-gemini-cli-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&missing);
        assert!(
            resolve_gemini_working_directory(Some(missing.to_string_lossy().to_string()))
                .await
                .unwrap_err()
                .contains("does not exist or cannot be read")
        );

        let dir =
            std::env::temp_dir().join(format!("llm-wiki-gemini-cli-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tempdir");
        let _guard = TestDir(dir.clone());
        assert!(
            resolve_gemini_working_directory(Some(dir.to_string_lossy().to_string()))
                .await
                .unwrap_err()
                .contains("wiki/index.md")
        );

        let wiki_dir = dir.join("wiki");
        std::fs::create_dir_all(&wiki_dir).expect("wiki dir");
        std::fs::write(wiki_dir.join("index.md"), "# Index\n").expect("index");
        let resolved = resolve_gemini_working_directory(Some(dir.to_string_lossy().to_string()))
            .await
            .expect("valid project path");
        assert_eq!(resolved, dir.canonicalize().expect("canonical tempdir"));
    }
}
