//! `/ws/filemanager/`：檔案管理（FileManagerConsumer）。
//! 優先走原生 SFTP（russh + russh-sftp，結構化 readdir）；SFTP subsystem 不可用時退回
//! 「常駐 `ssh … cat` ControlMaster + 遠端 `ls -la` / PowerShell JSON」的舊路徑。
//! Actions: `shell_detect`、`list_files {path}`；回 `{action, data}`；錯誤 `{action:"error", data:{status:"error", message}}`。

use std::process::Stdio;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use russh_sftp::client::SftpSession;
use serde_json::{json, Value};
use tokio::process::{Child, Command};

use super::{auth, close, is_ping, send_json};
use crate::db;
use crate::permissions::{self, Permission};
use crate::sftp;
use crate::ssh::device::{self, DeviceConn};
use crate::ssh::process::{filemanager_exec_args, filemanager_master_args, terminate_child};
use crate::ssh::SshTarget;
use crate::state::AppState;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// Python `format_size`：`f"{size:.1f} {unit}"`，0 → "0 B"。
pub fn format_size(mut size: f64) -> String {
    if size == 0.0 {
        return "0 B".to_string();
    }
    let units = ["B", "KB", "MB", "GB"];
    let mut i = 0;
    while size >= 1024.0 && i < units.len() - 1 {
        size /= 1024.0;
        i += 1;
    }
    format!("{size:.1} {}", units[i])
}

/// `parse_unix_output`：跳過 `total` 行；`type`/`name`/`size`。
pub fn parse_unix_listing(stdout: &str) -> Vec<Value> {
    let mut files = Vec::new();
    for line in stdout.trim().lines().skip(1) {
        if line.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 9 {
            continue;
        }
        let name = parts[8..].join(" ");
        if name == "." || name == ".." {
            continue;
        }
        let size = parts[4];
        let size_val = match size.parse::<f64>() {
            Ok(n) => Value::String(format_size(n)),
            Err(_) => Value::String(size.to_string()),
        };
        files.push(json!({
            "name": name,
            "type": if parts[0].starts_with('d') { "directory" } else { "file" },
            "size": size_val,
        }));
    }
    files
}

/// `parse_powershell_output`
pub fn parse_powershell_listing(stdout: &str) -> Vec<Value> {
    let Ok(v) = serde_json::from_str::<Value>(stdout) else { return vec![] };
    let items = match v {
        Value::Array(a) => a,
        other => vec![other],
    };
    items
        .iter()
        .map(|item| {
            let name = item.get("Name").and_then(|n| n.as_str()).unwrap_or("");
            let mode = item.get("Mode").and_then(|m| m.as_str()).unwrap_or("").to_ascii_lowercase();
            let length = item.get("Length").and_then(|l| l.as_f64()).unwrap_or(0.0);
            let is_dir = mode.contains('d') || mode.contains("directory");
            json!({
                "name": name,
                "type": if is_dir { "directory" } else { "file" },
                "size": if length != 0.0 { Value::String(format_size(length)) } else { Value::String("N/A".into()) },
            })
        })
        .collect()
}

/// 舊路徑：常駐 ControlMaster + 單次指令。/ Fallback: exec over a ControlMaster session.
struct ExecSession {
    state: AppState,
    target: SshTarget,
    master: Option<Child>,
}

impl ExecSession {
    async fn start(state: AppState, target: SshTarget) -> std::io::Result<Self> {
        let child = Command::new(&state.config.ssh_binary)
            .args(filemanager_master_args(&target))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        tracing::info!(target = %target.userhost(), port = target.port, "SSH session initialized (exec fallback)");
        Ok(Self { state, target, master: Some(child) })
    }

    /// `execute_ssh_command_persistent`：30s 逾時 → ("", "Command timed out", 124)。
    async fn exec(&self, command: &str) -> (String, String, i32) {
        let mut child = match Command::new(&self.state.config.ssh_binary)
            .args(filemanager_exec_args(&self.target, command))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => return (String::new(), e.to_string(), 1),
        };
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let collect = async {
            let mut out = Vec::new();
            let mut err = Vec::new();
            if let Some(mut s) = stdout {
                let _ = tokio::io::AsyncReadExt::read_to_end(&mut s, &mut out).await;
            }
            if let Some(mut s) = stderr {
                let _ = tokio::io::AsyncReadExt::read_to_end(&mut s, &mut err).await;
            }
            let status = child.wait().await;
            (out, err, status)
        };
        match tokio::time::timeout(COMMAND_TIMEOUT, collect).await {
            Ok((out, err, status)) => (
                String::from_utf8_lossy(&out).to_string(),
                String::from_utf8_lossy(&err).to_string(),
                status.ok().and_then(|s| s.code()).unwrap_or(1),
            ),
            Err(_) => {
                tracing::error!("SSH command timed out after 30s");
                (String::new(), "Command timed out".to_string(), 124)
            }
        }
    }

    async fn is_powershell(&self) -> bool {
        let (out, _, code) = self.exec("Get-Host").await;
        code == 0 && out.contains("Name")
    }

    async fn cleanup(&mut self) {
        if let Some(mut child) = self.master.take() {
            terminate_child(&mut child, Duration::from_secs(5)).await;
            tracing::info!("SSH session cleaned up");
        }
    }
}

enum Backend {
    Sftp { sftp: SftpSession, home: String, shell: &'static str, _conn: DeviceConn },
    Exec(ExecSession),
}

impl Backend {
    async fn shell(&self) -> &'static str {
        match self {
            Backend::Sftp { shell, .. } => shell,
            Backend::Exec(s) => {
                if s.is_powershell().await {
                    "powershell"
                } else {
                    "unix"
                }
            }
        }
    }

    /// 回 (path, files) 或錯誤訊息。
    async fn list(&self, requested: Option<String>) -> Result<(String, Vec<Value>), String> {
        match self {
            Backend::Sftp { sftp, home, shell, .. } => {
                let raw = requested.unwrap_or_else(|| if *shell == "powershell" { "C:\\".into() } else { "~/".into() });
                let path = sftp::resolve_path(&raw, home);
                let entries = sftp::list_dir(sftp, &path).await.map_err(|e| format!("Failed to list files: {e}"))?;
                Ok((path, entries.iter().map(sftp::ws_entry_json).collect()))
            }
            Backend::Exec(s) => {
                let is_ps = s.is_powershell().await;
                let path = requested.unwrap_or_else(|| if is_ps { "C:\\".into() } else { "~/".into() });
                let command = if is_ps {
                    format!("Get-ChildItem -Path \"{path}\" | Select-Object Mode, LastWriteTime, Length, Name | ConvertTo-Json")
                } else {
                    format!("ls -la {path}")
                };
                let (stdout, stderr, code) = s.exec(&command).await;
                if code != 0 {
                    return Err(format!("Failed to list files: {stderr}"));
                }
                let files = if is_ps { parse_powershell_listing(&stdout) } else { parse_unix_listing(&stdout) };
                Ok((path, files))
            }
        }
    }

    async fn cleanup(&mut self) {
        if let Backend::Exec(s) = self {
            s.cleanup().await;
        }
    }
}

async fn send_error(socket: &mut WebSocket, message: String) -> bool {
    send_json(socket, &json!({ "action": "error", "data": { "status": "error", "message": message } })).await
}

async fn send_response(socket: &mut WebSocket, action: &str, data: Value) -> bool {
    send_json(socket, &json!({ "action": action, "data": data })).await
}

async fn open_backend(state: &AppState, username: &str, reverse_port: i64) -> Option<Backend> {
    match device::connect(&state.config, username, reverse_port).await {
        Ok(conn) => match conn.sftp().await {
            Ok(sftp) => {
                let home = sftp::home(&sftp).await;
                let shell = if sftp::is_windows_home(&home) { "powershell" } else { "unix" };
                tracing::info!(%username, reverse_port, home, "FileManager: native SFTP session ready");
                return Some(Backend::Sftp { sftp, home, shell, _conn: conn });
            }
            Err(e) => tracing::warn!(error = %e, "FileManager: SFTP subsystem unavailable, falling back to exec"),
        },
        Err(e) => tracing::warn!(error = %e, "FileManager: native SSH connection failed, falling back to exec"),
    }
    let target = SshTarget::new(&state.config, username, reverse_port);
    ExecSession::start(state.clone(), target).await.ok().map(Backend::Exec)
}

pub async fn handle(state: AppState, mut socket: WebSocket) {
    let (user, msg) = match auth::first_message(&state, &mut socket).await {
        Ok(v) => v,
        Err(0) => return,
        Err(code) => {
            close(&mut socket, code).await;
            return;
        }
    };
    let (Some(server_id), Some(username)) = (auth::id_field(&msg, "server_id"), msg.get("username").and_then(|u| u.as_str()).map(str::to_string)) else {
        tracing::error!("FileManager auth message missing server_id/username");
        close(&mut socket, 4000).await;
        return;
    };
    tracing::info!(user = %user.username, "FileManager user authenticated");

    // 與 Django 版相同順序：權限(4004) → port(4002) → 有無 usernames(4006) → username 允許(4003)。
    let tunnel = match server_id.parse::<i64>() {
        Ok(id) => db::tunnels::by_id(&state.db, id).await.ok().flatten(),
        Err(_) => None,
    };
    let Some(tunnel) = tunnel else {
        close(&mut socket, 4004).await;
        return;
    };
    if !permissions::check_access(&state.db, user.id, &tunnel, Permission::View).await.unwrap_or(false) {
        close(&mut socket, 4004).await;
        return;
    }
    if tunnel.reverse_port <= 0 {
        close(&mut socket, 4002).await;
        return;
    }
    if !db::tunnels::usernames_exist_for_tunnel(&state.db, tunnel.id).await.unwrap_or(false) {
        close(&mut socket, 4006).await;
        return;
    }
    let allowed = permissions::allowed_usernames(&state.db, user.id, &tunnel).await.unwrap_or_default();
    if !allowed.iter().any(|u| u.username == username) {
        close(&mut socket, 4003).await;
        return;
    }

    let Some(mut backend) = open_backend(&state, &username, tunnel.reverse_port).await else {
        tracing::error!("Failed to initialize SSH session");
        close(&mut socket, 4005).await;
        return;
    };

    while let Some(Ok(frame)) = socket.recv().await {
        let text = match frame {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };
        if is_ping(&text) {
            if !send_json(&mut socket, &json!({"type": "pong"})).await {
                break;
            }
            continue;
        }
        let data: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => {
                if !send_error(&mut socket, "Invalid JSON data".into()).await {
                    break;
                }
                continue;
            }
        };
        let action = data.get("action").and_then(|a| a.as_str()).unwrap_or("").to_string();
        let payload = data.get("payload").cloned().unwrap_or_else(|| json!({}));
        let ok = match action.as_str() {
            "list_files" => {
                let requested = payload.get("path").and_then(|p| p.as_str()).map(str::to_string);
                match backend.list(requested).await {
                    Ok((path, files)) => send_response(&mut socket, "list_files", json!({ "status": "success", "path": path, "files": files })).await,
                    Err(e) => send_error(&mut socket, e).await,
                }
            }
            "shell_detect" => {
                let shell = backend.shell().await;
                send_response(&mut socket, "shell_detect", json!({ "status": "success", "shell": shell })).await
            }
            other => send_error(&mut socket, format!("Unknown action: {other}")).await,
        };
        if !ok {
            break;
        }
    }
    backend.cleanup().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_formatting_matches_python() {
        assert_eq!(format_size(0.0), "0 B");
        assert_eq!(format_size(512.0), "512.0 B");
        assert_eq!(format_size(4096.0), "4.0 KB");
        assert_eq!(format_size(1536.0 * 1024.0), "1.5 MB");
    }

    #[test]
    fn unix_listing() {
        let out = "total 12\ndrwxr-xr-x 2 u g 4096 Jan 1 00:00 .\ndrwxr-xr-x 2 u g 4096 Jan 1 00:00 ..\n-rw-r--r-- 1 u g 1536 Jan 1 00:00 my file.txt\ndrwxr-xr-x 2 u g 4096 Jan 1 00:00 dir\n";
        let files = parse_unix_listing(out);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0]["name"], "my file.txt");
        assert_eq!(files[0]["type"], "file");
        assert_eq!(files[0]["size"], "1.5 KB");
        assert_eq!(files[1]["type"], "directory");
    }

    #[test]
    fn powershell_listing() {
        let out = r#"[{"Mode":"d-----","LastWriteTime":"x","Length":null,"Name":"Users"},{"Mode":"-a----","Length":2048,"Name":"a.txt"}]"#;
        let files = parse_powershell_listing(out);
        assert_eq!(files[0]["type"], "directory");
        assert_eq!(files[0]["size"], "N/A");
        assert_eq!(files[1]["size"], "2.0 KB");
        let single = parse_powershell_listing(r#"{"Mode":"-a----","Length":1,"Name":"one"}"#);
        assert_eq!(single.len(), 1);
    }
}
