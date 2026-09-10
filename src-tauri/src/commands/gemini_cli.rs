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
}

const GEMINI_SPAWN_TIMEOUT_MINUTES: u64 = 10;
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

#[tauri::command]
pub async fn gemini_cli_detect() -> Result<DetectResult, String> {
    let path = match find_gemini_command().await {
        Ok(p) => p,
        Err(error) => {
            return Ok(DetectResult {
                installed: false,
                version: None,
                path: None,
                error: Some(error),
            });
        }
    };

    let path_str = path.to_string_lossy().to_string();
    let mut cmd = Command::new(&path);
    suppress_windows_console(&mut cmd);
    // `gemini` is a node shim; under a GUI launch the inherited PATH lacks
    // node, so hand it the login shell PATH or its shebang fails with
    // `env: node: No such file or directory`.
    if let Some(path_env) = child_path_env().await {
        cmd.env("PATH", path_env);
    }
    let output = tokio::time::timeout(Duration::from_secs(3), cmd.arg("--version").output()).await;

    match output {
        Ok(Ok(out)) if out.status.success() => {
            // `gemini --version` has printed update notices above the version
            // itself; the version is the last non-empty line.
            let stdout = String::from_utf8_lossy(&out.stdout);
            let version = stdout
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .next_back()
                .map(str::to_string);
            Ok(DetectResult {
                installed: true,
                version,
                path: Some(path_str),
                error: None,
            })
        }
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Ok(DetectResult {
                installed: false,
                version: None,
                path: Some(path_str),
                error: Some(if stderr.is_empty() {
                    format!("`gemini --version` exited with {}", out.status)
                } else {
                    stderr
                }),
            })
        }
        Ok(Err(e)) => Ok(DetectResult {
            installed: false,
            version: None,
            path: Some(path_str),
            error: Some(format!("Failed to spawn `gemini`: {e}")),
        }),
        Err(_) => Ok(DetectResult {
            installed: false,
            version: None,
            path: Some(path_str),
            error: Some("`gemini --version` timed out after 3s".to_string()),
        }),
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

    let working_directory = resolve_gemini_working_directory(working_directory).await?;
    let gemini = find_gemini_command().await?;
    let mut cmd = Command::new(&gemini);
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

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn gemini: {e}"))?;

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
