//! MCP 端點端到端：OAuth token → `/mcp`（rmcp stateless Streamable HTTP）→ AI SSH session 打到一個假的裝置 sshd
//! （russh server：exec 用 `sh -c`、sftp 轉接本機 `sftp-server`）。沒有 ssh-keygen 就跳過；沒有 sftp-server 時略過 SFTP 部分。
//! The MCP endpoint end to end against a fake device sshd (russh server running `sh -c` and the local sftp-server).
//! 互動 shell 用假 sshd 的 PTY echo shell；agent 瀏覽器用一個假的 kasm session-manager（HTTP，回答 CDP 動作），不需要 Docker。
//! Interactive shells run against the fake sshd's PTY echo shell; agent browsers against a fake session-manager.
mod common;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use russh::server::{self, Auth, ChannelOpenHandle, Handler, Msg, Session};
use russh::{Channel, ChannelId, ChannelMsg};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::process::Command;

use common::{Resp, TestApp};
use telepy_server::db;

const SFTP_SERVERS: [&str; 3] = ["/usr/libexec/sftp-server", "/usr/lib/openssh/sftp-server", "/usr/lib/ssh/sftp-server"];

fn sftp_server_bin() -> Option<&'static str> {
    SFTP_SERVERS.iter().copied().find(|p| Path::new(p).exists())
}

fn have(bin: &str) -> bool {
    std::process::Command::new("which").arg(bin).output().map(|o| o.status.success()).unwrap_or(false)
}

fn keygen(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    let out = std::process::Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-f"]).arg(&path).output().unwrap();
    assert!(out.status.success(), "ssh-keygen: {}", String::from_utf8_lossy(&out.stderr));
    path
}

// ---------------------------------------------------------------- fake device sshd

/// 假裝置看到的事：echo shell 跑了的指令、PTY 要求、視窗大小變化。/ What the fake device saw.
#[derive(Default)]
struct DeviceLog {
    commands: Vec<String>,
    terms: Vec<(String, u32, u32)>,
    resizes: Vec<(u32, u32)>,
}

struct Device {
    home: PathBuf,
    channels: HashMap<ChannelId, Channel<Msg>>,
    log: Arc<Mutex<DeviceLog>>,
}

impl Handler for Device {
    type Error = russh::Error;

    async fn auth_publickey(&mut self, _user: &str, _key: &russh::keys::PublicKey) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(&mut self, channel: Channel<Msg>, reply: ChannelOpenHandle, _session: &mut Session) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(&mut self, id: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        let Some(channel) = self.channels.remove(&id) else { return session.channel_failure(id) };
        session.channel_success(id)?;
        tokio::spawn(run_exec(channel, session.handle(), String::from_utf8_lossy(data).into_owned(), self.home.clone()));
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn pty_request(&mut self, id: ChannelId, term: &str, cols: u32, rows: u32, _pw: u32, _ph: u32, _modes: &[(russh::Pty, u32)], session: &mut Session) -> Result<(), Self::Error> {
        self.log.lock().unwrap().terms.push((term.to_string(), cols, rows));
        session.channel_success(id)
    }

    async fn window_change_request(&mut self, id: ChannelId, cols: u32, rows: u32, _pw: u32, _ph: u32, session: &mut Session) -> Result<(), Self::Error> {
        self.log.lock().unwrap().resizes.push((cols, rows));
        session.channel_success(id)
    }

    async fn shell_request(&mut self, id: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        let Some(channel) = self.channels.remove(&id) else { return session.channel_failure(id) };
        session.channel_success(id)?;
        tokio::spawn(run_echo_shell(channel, self.log.clone()));
        Ok(())
    }

    async fn subsystem_request(&mut self, id: ChannelId, name: &str, session: &mut Session) -> Result<(), Self::Error> {
        match (name, sftp_server_bin(), self.channels.remove(&id)) {
            ("sftp", Some(bin), Some(channel)) => {
                session.channel_success(id)?;
                tokio::spawn(run_sftp(channel, bin, self.home.clone()));
                Ok(())
            }
            _ => session.channel_failure(id),
        }
    }
}

async fn run_exec(mut channel: Channel<Msg>, handle: server::Handle, cmd: String, home: PathBuf) {
    let id = channel.id();
    let mut child = Command::new("sh").arg("-c").arg(&cmd).current_dir(&home).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn().unwrap();
    let (mut out, mut err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let (mut w_out, mut w_err) = (channel.make_writer(), channel.make_writer_ext(Some(1)));
    let copy_out = tokio::spawn(async move {
        let _ = tokio::io::copy(&mut out, &mut w_out).await;
        let _ = w_out.flush().await;
    });
    let copy_err = tokio::spawn(async move {
        let _ = tokio::io::copy(&mut err, &mut w_err).await;
        let _ = w_err.flush().await;
    });
    // 客戶端送 signal 或關 channel → 殺掉子程序（逾時測試靠這個）。/ A signal or close from the client kills the child.
    let mut killed = false;
    let status = loop {
        tokio::select! {
            st = child.wait() => break st.ok(),
            msg = channel.wait() => match msg {
                Some(ChannelMsg::Signal { .. }) | Some(ChannelMsg::Close) | None => { killed = true; break None }
                _ => {}
            }
        }
    };
    if killed {
        let _ = child.kill().await;
    }
    let _ = copy_out.await;
    let _ = copy_err.await;
    if let Some(st) = status {
        let _ = handle.exit_status_request(id, st.code().unwrap_or(255) as u32).await;
    }
    let _ = channel.eof().await;
    let _ = channel.close().await;
}

/// 像 tty 的 shell：`$ ` 提示、回顯、退格、Ctrl+C；Enter 「執行」：`draw` 清畫面畫一個 TUI，`exit` 結束，其他印 `ran:<行>`。
/// A tty-like shell: prompt, echo, backspace, Ctrl+C; Enter "runs" the line (`draw` paints a TUI, `exit` ends).
async fn run_echo_shell(channel: Channel<Msg>, log: Arc<Mutex<DeviceLog>>) {
    let mut s = channel.into_stream();
    let _ = s.write_all(b"welcome\r\n$ ").await;
    let mut buf = [0u8; 4096];
    let mut line = String::new();
    'shell: while let Ok(n) = s.read(&mut buf).await {
        if n == 0 {
            break;
        }
        let mut out = String::new();
        for c in String::from_utf8_lossy(&buf[..n]).chars() {
            match c {
                '\r' | '\n' => {
                    let cmd = std::mem::take(&mut line).trim().to_string();
                    out.push_str("\r\n");
                    match cmd.as_str() {
                        "" => {}
                        "exit" => {
                            let _ = s.write_all(out.as_bytes()).await;
                            break 'shell;
                        }
                        "draw" => out.push_str("\x1b[2J\x1b[1;1HTOP LINE\x1b[3;5Hmiddle\x1b[5;1H"),
                        _ => {
                            out.push_str(&format!("ran:{cmd}\r\n"));
                            log.lock().unwrap().commands.push(cmd);
                        }
                    }
                    out.push_str("$ ");
                }
                '\x03' => {
                    line.clear();
                    out.push_str("^C\r\n$ ");
                }
                '\x7f' | '\x08' => {
                    if line.pop().is_some() {
                        out.push_str("\x08 \x08");
                    }
                }
                c if !c.is_control() => {
                    line.push(c);
                    out.push(c);
                }
                _ => {}
            }
        }
        if s.write_all(out.as_bytes()).await.is_err() {
            break;
        }
    }
    let _ = s.shutdown().await;
}

async fn run_sftp(channel: Channel<Msg>, bin: &str, home: PathBuf) {
    let mut child = Command::new(bin).current_dir(&home).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).spawn().unwrap();
    let (mut cin, mut cout) = (child.stdin.take().unwrap(), child.stdout.take().unwrap());
    let (mut r, mut w) = tokio::io::split(channel.into_stream());
    let up = tokio::spawn(async move {
        let _ = tokio::io::copy(&mut r, &mut cin).await;
    });
    let _ = tokio::io::copy(&mut cout, &mut w).await;
    let _ = w.shutdown().await;
    up.abort();
}

/// 起一個假裝置 sshd，回 port。/ Start the fake device sshd and return its port.
async fn start_device(host_key: &Path, home: PathBuf, log: Arc<Mutex<DeviceLog>>) -> u16 {
    let key = russh::keys::load_secret_key(host_key, None).unwrap();
    let config = Arc::new(server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            let (cfg, home, log) = (config.clone(), home.clone(), log.clone());
            tokio::spawn(async move {
                if let Ok(s) = server::run_stream(cfg, sock, Device { home, channels: HashMap::new(), log }).await {
                    let _ = s.await;
                }
            });
        }
    });
    port
}

// ---------------------------------------------------------------- fake kasm session-manager

/// 假的 session-manager 收到的請求（`create` / `cdp <action>` / `stop`）。/ Requests the fake session-manager got.
type KasmLog = Arc<Mutex<Vec<Value>>>;

/// 回答 `POST /sessions`、`POST /sessions/{id}/cdp`（照動作回假的頁面）、`DELETE /sessions/{id}`。
/// Answers session create, CDP actions (with a fake page) and stop.
async fn start_kasm(log: KasmLog) -> u16 {
    use axum::extract::{Path as UrlPath, State};
    use axum::routing::{delete, post};
    use axum::Json;
    async fn create(State(log): State<KasmLog>, Json(body): Json<Value>) -> (StatusCode, Json<Value>) {
        log.lock().unwrap().push(json!({"op": "create", "proxy": body["proxy"]}));
        (StatusCode::CREATED, Json(json!({"session_id": "kasm-1", "ws_port": 18443})))
    }
    async fn cdp(State(log): State<KasmLog>, UrlPath(sid): UrlPath<String>, Json(a): Json<Value>) -> (StatusCode, Json<Value>) {
        log.lock().unwrap().push(json!({"op": "cdp", "session": sid, "action": a.clone()}));
        let page = |url: &str| json!({"url": url, "title": "Fake page"});
        match a["action"].as_str().unwrap_or("") {
            "navigate" => (StatusCode::OK, Json(page(a["url"].as_str().unwrap_or("")))),
            "screenshot" => (StatusCode::OK, Json(json!({"data": STANDARD.encode(b"\x89PNG fake"), "width": 1280, "height": 720, "url": "https://example.com/", "title": "Fake page"}))),
            "read" => (StatusCode::OK, Json(json!({"title": "Fake page", "url": "https://example.com/", "text": "Hello from behind the device", "truncated": false, "links": []}))),
            "click" if a["selector"] == "#missing" => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({"error": "No element matches #missing"}))),
            "click" => (StatusCode::OK, Json(json!({"clicked": "button “Save”", "url": "https://example.com/saved", "title": "Saved"}))),
            "type" => (StatusCode::OK, Json(page("https://example.com/"))),
            other => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({"error": format!("unknown action {other}")}))),
        }
    }
    async fn stop(State(log): State<KasmLog>, UrlPath(sid): UrlPath<String>) -> Json<Value> {
        log.lock().unwrap().push(json!({"op": "stop", "session": sid}));
        Json(json!({"status": "stopped"}))
    }
    let app = axum::Router::new()
        .route("/sessions", post(create))
        .route("/sessions/{sid}/cdp", post(cdp))
        .route("/sessions/{sid}", delete(stop))
        .with_state(log);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    port
}

// ---------------------------------------------------------------- OAuth + MCP helpers

const REDIRECT: &str = "http://localhost:33418/callback";
const VERIFIER: &str = "verifier-verifier-verifier-verifier-verifier-0123";

async fn oauth_token(app: &TestApp, web: &str, scope: &str, tunnel_ids: Value) -> (String, i64) {
    let r = app.post("/api/oauth/register", None, json!({"client_name": "Test Agent", "redirect_uris": [REDIRECT], "token_endpoint_auth_method": "none"})).await;
    let client_id = r.json["client_id"].as_str().unwrap().to_string();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(VERIFIER.as_bytes()));
    let r = app
        .post(
            "/api/oauth/authorize",
            Some(web),
            json!({"response_type": "code", "client_id": client_id, "redirect_uri": REDIRECT, "code_challenge": challenge, "code_challenge_method": "S256", "scope": scope, "approve": true, "tunnel_ids": tunnel_ids}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let to = url::Url::parse(r.json["redirect_to"].as_str().unwrap()).unwrap();
    let code = to.query_pairs().find(|(k, _)| k == "code").unwrap().1.into_owned();
    let form = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([("grant_type", "authorization_code"), ("code", code.as_str()), ("client_id", client_id.as_str()), ("code_verifier", VERIFIER), ("redirect_uri", REDIRECT)])
        .finish();
    let req = Request::post("/api/oauth/token").header(header::CONTENT_TYPE, "application/x-www-form-urlencoded").body(Body::from(form)).unwrap();
    let r = app.send(req).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let access = r.json["access_token"].as_str().unwrap().to_string();
    let claims = app.state.jwt.verify_mcp(&access).unwrap();
    (access, claims.grant_id)
}

async fn mcp_raw(app: &TestApp, token: Option<&str>, body: Value) -> Resp {
    let mut req = Request::builder()
        .method(Method::POST)
        .uri("/mcp")
        .header(header::HOST, "telepy.test")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-06-18");
    if let Some(t) = token {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    app.send(req.body(Body::from(body.to_string())).unwrap()).await
}

/// tools/call → (isError, structuredContent 或文字內容)。/ Call a tool; returns (is_error, structured or text).
async fn call(app: &TestApp, token: &str, tool: &str, args: Value) -> (bool, Value) {
    let r = mcp_raw(app, Some(token), json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": tool, "arguments": args}})).await;
    assert_eq!(r.status, StatusCode::OK, "{tool}: {}", r.text);
    let result = &r.json["result"];
    assert!(result.is_object(), "{tool}: {}", r.text);
    let is_error = result["isError"].as_bool().unwrap_or(false);
    let value = if result["structuredContent"].is_object() { result["structuredContent"].clone() } else { result["content"][0]["text"].clone() };
    (is_error, value)
}

struct Setup {
    app: TestApp,
    web: String,
    admin_id: i64,
    tunnel_id: i64,
    device_port: u16,
    home: tempfile::TempDir,
    device: Arc<Mutex<DeviceLog>>,
    kasm: KasmLog,
    _keys: tempfile::TempDir,
}

async fn setup() -> Option<Setup> {
    if !have("ssh-keygen") {
        eprintln!("skipping: ssh-keygen not available");
        return None;
    }
    let keys = tempfile::tempdir().unwrap();
    let identity = keygen(keys.path(), "backend_key");
    let host_key = keygen(keys.path(), "device_host_key");
    let home = tempfile::tempdir().unwrap();
    let device = Arc::new(Mutex::new(DeviceLog::default()));
    let device_port = start_device(&host_key, home.path().to_path_buf(), device.clone()).await;
    let kasm: KasmLog = Arc::default();
    let kasm_port = start_kasm(kasm.clone()).await;

    let mut app = common::spawn().await;
    let mut config = app.state.config.clone();
    config.ssh_identity = identity;
    config.ssh_target_host = "127.0.0.1".into();
    config.kasm_api = format!("http://127.0.0.1:{kasm_port}");
    app.state = telepy_server::state::AppState::new(config, app.state.db.clone());
    app.router = telepy_server::app::build(app.state.clone());
    let web = app.login("admin", "pw").await;
    let admin_id = app.get("/api/auth/user/profile", Some(&web)).await.json["id"].as_i64().unwrap();
    let r = app.post("/api/reverse/server/keys", Some(&web), json!({"host_friendly_name": "box-a", "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIboxa box-a", "reverse_port": device_port})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let tunnel_id = r.json["id"].as_i64().unwrap();
    let r = app.post("/api/reverse/server/usernames", Some(&web), json!({"reverse_server": tunnel_id, "username": "alice"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    Some(Setup { app, web, admin_id, tunnel_id, device_port, home, device, kasm, _keys: keys })
}

// ---------------------------------------------------------------- tests

#[tokio::test]
async fn mcp_requires_an_oauth_token() {
    let app = common::spawn().await;
    let web = app.login("admin", "pw").await;
    let init = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}});
    let r = mcp_raw(&app, None, init.clone()).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let www = r.headers.get(header::WWW_AUTHENTICATE).unwrap().to_str().unwrap();
    assert_eq!(www, r#"Bearer resource_metadata="http://telepy.test/.well-known/oauth-protected-resource/mcp""#);
    let r = mcp_raw(&app, Some(&web), init.clone()).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED, "a web token is not an MCP token");
    assert!(r.headers.get(header::WWW_AUTHENTICATE).unwrap().to_str().unwrap().contains(r#"error="invalid_token""#));

    // 驗證只套在 /mcp：其他不存在的路徑仍是 404。/ The bearer check covers /mcp only; unknown paths stay 404.
    assert_eq!(app.get("/api/nope", None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get("/mcpx", None).await.status, StatusCode::NOT_FOUND);

    let (token, _) = oauth_token(&app, &web, "", json!(null)).await;
    let r = mcp_raw(&app, Some(&token), init).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(r.headers.get(header::CONTENT_TYPE).unwrap().to_str().unwrap().starts_with("application/json"));
    assert_eq!(r.json["result"]["serverInfo"]["name"], "telepy");
    assert!(r.json["result"]["instructions"].as_str().unwrap().contains("ssh_session_open"));
    let r = mcp_raw(&app, Some(&token), json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})).await;
    let names: HashSet<&str> = r.json["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    for t in ["list_tunnels", "tunnel_status", "ssh_session_open", "ssh_exec", "ssh_session_close", "ssh_session_list", "sftp_list", "sftp_read", "sftp_write", "shell_open", "shell_send", "shell_read", "shell_resize", "shell_close", "browser_open", "browser_navigate", "browser_screenshot", "browser_read", "browser_click", "browser_type", "browser_close"] {
        assert!(names.contains(t), "missing tool {t}: {names:?}");
    }
    let exec = r.json["result"]["tools"].as_array().unwrap().iter().find(|t| t["name"] == "ssh_exec").unwrap();
    assert!(exec["inputSchema"]["properties"]["command"].is_object());
    assert_eq!(exec["annotations"]["destructiveHint"], true);

    // 管理員要求 TOTP、這個帳號還沒設：token 一律無效。/ Required TOTP not set up yet: the token is refused.
    sqlx::query("UPDATE site_settings_sitesettings SET mfa_require_totp = 1 WHERE id = 1").execute(&app.state.db.write).await.unwrap();
    app.state.mfa.requirement.invalidate_all();
    let r = mcp_raw(&app, Some(&token), json!({"jsonrpc": "2.0", "id": 3, "method": "tools/list"})).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{}", r.text);
    assert!(r.headers.get(header::WWW_AUTHENTICATE).unwrap().to_str().unwrap().contains(r#"error="invalid_token""#));
}

#[tokio::test]
async fn sessions_exec_sftp_and_audit() {
    let Some(s) = setup().await else { return };
    let app = &s.app;
    let (token, grant_id) = oauth_token(app, &s.web, "", json!(null)).await;

    let (err, v) = call(app, &token, "list_tunnels", json!({})).await;
    assert!(!err, "{v}");
    let t = &v["tunnels"][0];
    assert_eq!(t["name"], "box-a");
    assert_eq!(t["usernames"], json!(["alice"]));
    assert_eq!(t["permission"], "owner");
    assert!(t["online"].is_null(), "no status source in tests = unknown");

    // 錯的 username → 告訴 agent 有哪些可用。/ A wrong username lists the allowed ones.
    let (err, v) = call(app, &token, "ssh_session_open", json!({"tunnel_id": s.tunnel_id, "username": "root"})).await;
    assert!(err);
    assert!(v.as_str().unwrap().contains("Allowed: alice"), "{v}");
    let (err, v) = call(app, &token, "ssh_session_open", json!({"tunnel_id": 999})).await;
    assert!(err && v.as_str().unwrap().contains("not found"), "{v}");

    // 開（唯一的 username 自動選上）。/ Open; the only username is picked automatically.
    let (err, v) = call(app, &token, "ssh_session_open", json!({"tunnel_id": s.tunnel_id, "idle_timeout_s": 120})).await;
    assert!(!err, "{v}");
    let sid = v["session_id"].as_str().unwrap().to_string();
    assert!(sid.starts_with("ais_"));
    assert_eq!(v["username"], "alice");
    assert_eq!(v["idle_timeout_s"], 120);
    assert_eq!(v["max_lifetime_s"], 7200);

    // exec：stdout / stderr / exit code 分開。/ Separate streams and the exit code.
    let (err, v) = call(app, &token, "ssh_exec", json!({"session_id": sid, "command": "echo hello; echo oops 1>&2; exit 3"})).await;
    assert!(!err, "{v}");
    assert_eq!(v["exit_code"], 3);
    assert_eq!(v["stdout"], "hello\n");
    assert_eq!(v["stderr"], "oops\n");
    assert_eq!(v["timed_out"], false);
    // 同一條連線上的多個指令，cwd 是 home。/ More commands on the same connection.
    let (_, v) = call(app, &token, "ssh_exec", json!({"session_id": sid, "command": "pwd"})).await;
    assert!(v["stdout"].as_str().unwrap().trim_end().ends_with(s.home.path().file_name().unwrap().to_str().unwrap()), "{v}");
    // 輸出截斷：保留頭尾。/ Truncation keeps the start and the end.
    let (_, v) = call(app, &token, "ssh_exec", json!({"session_id": sid, "command": "i=0; while [ $i -lt 3000 ]; do echo line$i; i=$((i+1)); done", "max_output_bytes": 2048})).await;
    assert_eq!(v["truncated"], true);
    let out = v["stdout"].as_str().unwrap();
    assert!(out.starts_with("line0\n") && out.ends_with("line2999\n") && out.contains("bytes omitted"), "{out}");
    // 逾時：被 KILL。/ Timeout kills the command.
    let (_, v) = call(app, &token, "ssh_exec", json!({"session_id": sid, "command": "sleep 30", "timeout_s": 1})).await;
    assert_eq!(v["timed_out"], true, "{v}");
    assert!(v["exit_code"].is_null());

    // SFTP（有 sftp-server 才測）。/ SFTP when a local sftp-server exists.
    if sftp_server_bin().is_some() {
        let (err, v) = call(app, &token, "sftp_write", json!({"session_id": sid, "path": "~/notes.txt", "content": "first\n"})).await;
        assert!(!err, "{v}");
        assert_eq!(v["bytes_written"], 6);
        call(app, &token, "sftp_write", json!({"session_id": sid, "path": "~/notes.txt", "content": "second\n", "append": true})).await;
        assert_eq!(std::fs::read_to_string(s.home.path().join("notes.txt")).unwrap(), "first\nsecond\n");
        let (_, v) = call(app, &token, "sftp_read", json!({"session_id": sid, "path": "~/notes.txt"})).await;
        assert_eq!(v["content"], "first\nsecond\n");
        assert_eq!((v["encoding"].as_str(), v["eof"].as_bool()), (Some("utf-8"), Some(true)));
        let (_, v) = call(app, &token, "sftp_read", json!({"session_id": sid, "path": "~/notes.txt", "offset": 6, "max_bytes": 3})).await;
        assert_eq!((v["content"].as_str(), v["eof"].as_bool()), (Some("sec"), Some(false)));
        call(app, &token, "sftp_write", json!({"session_id": sid, "path": "~/bin.dat", "content": STANDARD.encode([0u8, 159, 146, 150]), "encoding": "base64"})).await;
        let (_, v) = call(app, &token, "sftp_read", json!({"session_id": sid, "path": "~/bin.dat"})).await;
        assert_eq!(v["encoding"], "base64");
        assert_eq!(STANDARD.decode(v["content"].as_str().unwrap()).unwrap(), vec![0u8, 159, 146, 150]);
        let (_, v) = call(app, &token, "sftp_list", json!({"session_id": sid})).await;
        let names: Vec<&str> = v["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["bin.dat", "notes.txt"]);
        assert!(v["entries"][1]["mode"].as_str().unwrap().starts_with("-rw"));
        let (err, v) = call(app, &token, "sftp_read", json!({"session_id": sid, "path": "~/missing"})).await;
        assert!(err, "{v}");
    }

    // web 端看得到 session，tunnel_status 有資料。/ The web sees the session; tunnel_status works.
    let r = app.get("/api/ai/sessions", Some(&s.web)).await;
    assert_eq!(r.json.as_array().unwrap().len(), 1, "{}", r.text);
    assert_eq!(r.json[0]["client_name"], "Test Agent");
    assert_eq!(r.json[0]["tunnel"]["name"], "box-a");
    assert!(r.json[0]["commands"].as_u64().unwrap() >= 4);
    let (_, v) = call(app, &token, "ssh_session_list", json!({})).await;
    assert_eq!(v["sessions"][0]["session_id"], sid);
    let (_, v) = call(app, &token, "tunnel_status", json!({"tunnel_id": s.tunnel_id})).await;
    assert_eq!(v["name"], "box-a");

    // 另一個 app（另一個 grant）用不到這個 session。/ Another app cannot use this session.
    let (other, _) = oauth_token(app, &s.web, "", json!(null)).await;
    let (err, v) = call(app, &other, "ssh_exec", json!({"session_id": sid, "command": "id"})).await;
    assert!(err && v.as_str().unwrap().contains("Unknown or expired session_id"), "{v}");

    // 關閉 → 再用就失敗；稽核紀錄完整。/ Close; reuse fails; the audit trail is complete.
    let (err, _) = call(app, &token, "ssh_session_close", json!({"session_id": sid})).await;
    assert!(!err);
    let (err, _) = call(app, &token, "ssh_exec", json!({"session_id": sid, "command": "true"})).await;
    assert!(err);
    let r = app.get(&format!("/api/ai/activity?tunnel_id={}", s.tunnel_id), Some(&s.web)).await;
    let rows = r.json.as_array().unwrap();
    let exec = rows.iter().find(|e| e["tool"] == "ssh_exec" && e["exit_code"] == 3).unwrap();
    assert_eq!(exec["detail"], "echo hello; echo oops 1>&2; exit 3");
    assert_eq!(exec["user"]["username"], "admin");
    assert_eq!(exec["target_username"], "alice");
    assert!(exec["at"].as_str().unwrap().ends_with("+08:00"));
    assert!(rows.iter().any(|e| e["tool"] == "ssh_exec" && e["error"].as_str().is_some_and(|x| x.contains("timed out"))));
    assert!(rows.iter().any(|e| e["tool"] == "ssh_session_close" && e["detail"].as_str().unwrap().starts_with("reason: closed_by_agent")));
    assert!(rows.iter().any(|e| e["tool"] == "ssh_session_open" && e["ok"] == true));
    let _ = (grant_id, s.admin_id);
}

#[tokio::test]
async fn scopes_limits_revocation_and_the_reaper() {
    let Some(s) = setup().await else { return };
    let app = &s.app;

    // 只有 tunnels:read → 不能開 session。/ tunnels:read only → cannot open sessions.
    let (read_only, _) = oauth_token(app, &s.web, "tunnels:read", json!(null)).await;
    let (err, v) = call(app, &read_only, "ssh_session_open", json!({"tunnel_id": s.tunnel_id})).await;
    assert!(err && v.as_str().unwrap().contains("ssh:exec"), "{v}");
    // ssh:exec 但沒有 ssh:files → 不能讀檔。/ ssh:exec without ssh:files → no SFTP.
    let (exec_only, _) = oauth_token(app, &s.web, "ssh:exec", json!(null)).await;
    let (err, v) = call(app, &exec_only, "list_tunnels", json!({})).await;
    assert!(err && v.as_str().unwrap().contains("tunnels:read"), "{v}");
    let (_, v) = call(app, &exec_only, "ssh_session_open", json!({"tunnel_id": s.tunnel_id})).await;
    let sid = v["session_id"].as_str().unwrap().to_string();
    let (err, v) = call(app, &exec_only, "sftp_list", json!({"session_id": sid})).await;
    assert!(err && v.as_str().unwrap().contains("ssh:files"), "{v}");
    // 隧道限制：限制在別的隧道 → 不能開這個。/ Tunnel restriction.
    let r = app.post("/api/reverse/server/keys", Some(&s.web), json!({"host_friendly_name": "box-b", "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIboxb box-b", "reverse_port": 30999})).await;
    let other_tunnel = r.json["id"].as_i64().unwrap();
    let (restricted, _) = oauth_token(app, &s.web, "", json!([other_tunnel])).await;
    let (err, v) = call(app, &restricted, "ssh_session_open", json!({"tunnel_id": s.tunnel_id})).await;
    assert!(err && v.as_str().unwrap().contains("not given access"), "{v}");
    let (_, v) = call(app, &restricted, "list_tunnels", json!({})).await;
    assert_eq!(v["tunnels"].as_array().unwrap().len(), 1);
    assert_eq!(v["tunnels"][0]["name"], "box-b");

    // 每人上限（站台設定）。/ Per-user cap from the site settings.
    app.post("/api/site/settings", Some(&s.web), json!({"ai_max_sessions_per_user": 1})).await;
    let (full, full_grant) = oauth_token(app, &s.web, "", json!(null)).await;
    let (err, v) = call(app, &full, "ssh_session_open", json!({"tunnel_id": s.tunnel_id})).await;
    assert!(err && v.as_str().unwrap().contains("the limit is 1"), "{v}");
    app.post("/api/site/settings", Some(&s.web), json!({"ai_max_sessions_per_user": 3})).await;
    let (_, v) = call(app, &full, "ssh_session_open", json!({"tunnel_id": s.tunnel_id})).await;
    let full_sid = v["session_id"].as_str().unwrap().to_string();
    assert_eq!(app.state.ai.count_for_user(s.admin_id), 2);

    // 撤銷 grant → 它的 session 立即關掉、token 失效。/ Revoking the grant closes its sessions at once.
    assert_eq!(app.delete(&format!("/api/oauth/grants/{full_grant}"), Some(&s.web)).await.status, StatusCode::NO_CONTENT);
    assert!(app.state.ai.get(&full_sid).is_none());
    assert_eq!(mcp_raw(app, Some(&full), json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})).await.status, StatusCode::UNAUTHORIZED);

    // reaper：裝置離線 → 關閉並記錄原因。/ Reaper: the device goes offline.
    let mut owner_rx = app.state.hub.subscribe_user(s.admin_id);
    app.state.status.set_listen_ports(HashSet::new());
    telepy_server::ai::reap_once(&app.state).await;
    assert!(app.state.ai.get(&sid).is_none(), "offline device → closed");
    let msg: Value = serde_json::from_str(&owner_rx.try_recv().unwrap()).unwrap();
    assert_eq!(msg["message"]["action"], "AI-SESSION-CLOSED");
    assert_eq!(msg["message"]["reason"], "device_offline");
    let (err, v) = call(app, &exec_only, "ssh_session_open", json!({"tunnel_id": s.tunnel_id})).await;
    assert!(err && v.as_str().unwrap().contains("offline"), "{v}");
    app.state.status.set_listen_ports([s.device_port].into_iter().collect());

    // reaper：username 被刪 → permission_removed。/ Reaper: the username is removed.
    let (_, v) = call(app, &exec_only, "ssh_session_open", json!({"tunnel_id": s.tunnel_id})).await;
    let sid = v["session_id"].as_str().unwrap().to_string();
    telepy_server::ai::reap_once(&app.state).await;
    assert!(app.state.ai.get(&sid).is_some(), "nothing changed → still open");
    let uid = db::tunnels::usernames_for_tunnel(&app.state.db, s.tunnel_id).await.unwrap()[0].id;
    db::tunnels::username_delete(&app.state.db, uid).await.unwrap();
    telepy_server::ai::reap_once(&app.state).await;
    assert!(app.state.ai.get(&sid).is_none());
    let r = app.get("/api/ai/activity", Some(&s.web)).await;
    assert!(r.json.as_array().unwrap().iter().any(|e| e["detail"].as_str().is_some_and(|d| d.starts_with("reason: permission_removed"))));
}

#[tokio::test]
async fn sharees_agents_notify_the_owner_and_can_be_closed_by_them() {
    let Some(s) = setup().await else { return };
    let app = &s.app;
    app.post("/api/site/settings", Some(&s.web), json!({"allow_registration": true})).await;
    let bob = app.login("bob", "pw").await;
    let bob_id = app.get("/api/auth/user/profile", Some(&bob)).await.json["id"].as_i64().unwrap();
    let alice_uid = db::tunnels::usernames_for_tunnel(&app.state.db, s.tunnel_id).await.unwrap()[0].id;
    let r = app.post(&format!("/tunnels/share/{}", s.tunnel_id), Some(&s.web), json!({"shared_with_user_id": bob_id, "permission_type": "view", "allowed_target_username_ids": [alice_uid]})).await;
    assert!(r.status.is_success(), "{}", r.text);

    let mut owner_rx = app.state.hub.subscribe_user(s.admin_id);
    let (bob_token, _) = oauth_token(app, &bob, "", json!(null)).await;
    let (err, v) = call(app, &bob_token, "list_tunnels", json!({})).await;
    assert!(!err);
    assert_eq!(v["tunnels"][0]["permission"], "view");
    let (err, v) = call(app, &bob_token, "ssh_session_open", json!({"tunnel_id": s.tunnel_id})).await;
    assert!(!err, "{v}");
    let sid = v["session_id"].as_str().unwrap().to_string();
    let msg: Value = serde_json::from_str(&owner_rx.try_recv().unwrap()).unwrap();
    assert_eq!(msg["message"]["action"], "AI-SESSION-OPENED");
    assert_eq!(msg["message"]["by"], "bob");
    assert_eq!(msg["message"]["client"], "Test Agent");
    assert_eq!(msg["message"]["tunnel_id"], s.tunnel_id);

    // owner 看得到、也能關；陌生人不行。/ The owner sees and can close it; a stranger cannot.
    let r = app.get("/api/ai/sessions", Some(&s.web)).await;
    assert_eq!(r.json[0]["user"]["username"], "bob");
    let carol = app.login("carol", "pw").await;
    assert_eq!(app.get("/api/ai/sessions", Some(&carol)).await.json, json!([]));
    assert_eq!(app.delete(&format!("/api/ai/sessions/{sid}"), Some(&carol)).await.status, StatusCode::NOT_FOUND);
    assert!(app.get("/api/ai/activity", Some(&carol)).await.json.as_array().unwrap().is_empty(), "strangers see no activity");
    assert!(!app.get("/api/ai/activity", Some(&bob)).await.json.as_array().unwrap().is_empty());
    // 全站的 session / 紀錄只給管理員（管理區）；管理員預設也只看自己的。
    // Everyone's sessions / calls are admins only (the admin section); by default an admin sees only their own too.
    for path in ["/api/ai/sessions?scope=all", "/api/ai/activity?scope=all"] {
        let r = app.get(path, Some(&carol)).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{path}: {}", r.text);
        assert_eq!(r.json["code"], "admin_only");
    }
    let carol_id = app.get("/api/auth/user/profile", Some(&carol)).await.json["id"].as_i64().unwrap();
    db::users::set_flags(&app.state.db, carol_id, None, Some(true)).await.unwrap();
    assert_eq!(app.get("/api/ai/sessions", Some(&carol)).await.json, json!([]), "an admin's own view has nothing of others");
    assert!(app.get("/api/ai/activity", Some(&carol)).await.json.as_array().unwrap().is_empty());
    assert_eq!(app.get("/api/ai/sessions?scope=all", Some(&carol)).await.json[0]["user"]["username"], "bob");
    assert!(!app.get("/api/ai/activity?scope=all", Some(&carol)).await.json.as_array().unwrap().is_empty());
    assert_eq!(app.delete(&format!("/api/ai/sessions/{sid}"), Some(&s.web)).await.status, StatusCode::NO_CONTENT);
    let (err, _) = call(app, &bob_token, "ssh_exec", json!({"session_id": sid, "command": "true"})).await;
    assert!(err);

    // 取消分享 → 下一輪 reaper 關掉 bob 的 session。/ Unsharing closes the sharee's session on the next pass.
    let (_, v) = call(app, &bob_token, "ssh_session_open", json!({"tunnel_id": s.tunnel_id})).await;
    let sid = v["session_id"].as_str().unwrap().to_string();
    let r = app.delete(&format!("/tunnels/unshare/{}/{bob_id}", s.tunnel_id), Some(&s.web)).await;
    assert!(r.status.is_success(), "{}", r.text);
    telepy_server::ai::reap_once(&app.state).await;
    assert!(app.state.ai.get(&sid).is_none());
}

/// 指令規則也管 agent：擋下的回錯誤；要核准的停在 tool call 裡，owner 在網頁核准就跑、拒絕就回錯誤（agent 用 owner 的身分也一樣要按）。
/// Command rules apply to agents: blocked commands fail; held ones wait inside the tool call until the owner approves
/// in the web (even when the agent acts as the owner) and fail when denied.
#[tokio::test]
async fn command_rules_block_and_hold_agent_commands() {
    let Some(s) = setup().await else { return };
    let app = &s.app;
    let rules = format!("/api/reverse/server/{}/command-rules", s.tunnel_id);
    for body in [
        json!({"action": "block", "pattern": "rm", "note": "Nothing gets deleted here"}),
        json!({"action": "approve", "pattern": "touch"}),
        json!({"action": "block", "pattern": "cat", "via": "terminal"}),
    ] {
        let r = app.post(&rules, Some(&s.web), body).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    }
    let (token, _) = oauth_token(app, &s.web, "", json!(null)).await;
    let (_, v) = call(app, &token, "ssh_session_open", json!({"tunnel_id": s.tunnel_id})).await;
    let sid = v["session_id"].as_str().unwrap().to_string();
    std::fs::write(s.home.path().join("keep.txt"), "x").unwrap();

    // 擋下：沒跑，錯誤裡有規則與說明。/ Blocked: not run; the error names the rule and its note.
    let (err, v) = call(app, &token, "ssh_exec", json!({"session_id": sid, "command": "rm -f keep.txt"})).await;
    assert!(err, "{v}");
    let msg = v.as_str().unwrap();
    assert!(msg.contains("`rm`") && msg.contains("Nothing gets deleted here"), "{msg}");
    assert!(s.home.path().join("keep.txt").exists());
    // 只管終端機的規則不管 agent。/ A terminal-only rule leaves agents alone.
    let (err, v) = call(app, &token, "ssh_exec", json!({"session_id": sid, "command": "cat keep.txt"})).await;
    assert!(!err && v["stdout"] == "x", "{v}");
    // 提醒：照跑，結果附上提醒。/ A reminder: it runs, and the result carries the note.
    let r = app.post(&rules, Some(&s.web), json!({"action": "warn", "pattern": "ls", "note": "Mind the noise"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let (err, v) = call(app, &token, "ssh_exec", json!({"session_id": sid, "command": "ls keep.txt"})).await;
    assert!(!err && v["stdout"].as_str().unwrap().contains("keep.txt"), "{v}");
    assert!(v["reminder"].as_str().unwrap().contains("Mind the noise"), "{v}");

    // 要核准：tool call 等著，owner 核准後才跑。/ Held: the call waits until the owner approves.
    let mut owner_rx = app.state.hub.subscribe_user(s.admin_id);
    let first_pending = || async {
        loop {
            let r = app.get("/api/command-requests?status=pending", Some(&s.web)).await;
            if let Some(q) = r.json["requests"].as_array().and_then(|a| a.first()) {
                return q.clone();
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    };
    let approve_soon = async {
        let q = first_pending().await;
        assert_eq!(q["source"], "agent");
        assert_eq!(q["client"], "Test Agent");
        assert_eq!(q["command"], "touch approved.txt");
        assert_eq!(q["can_decide"], true, "the owner decides on their own agent's commands");
        assert!(!s.home.path().join("approved.txt").exists(), "nothing runs before the approval");
        let r = app.post(&format!("/api/command-requests/{}/approve", q["id"]), Some(&s.web), json!({})).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    };
    let ((err, v), ()) = tokio::join!(call(app, &token, "ssh_exec", json!({"session_id": sid, "command": "touch approved.txt"})), approve_soon);
    assert!(!err, "{v}");
    assert_eq!(v["exit_code"], 0);
    assert!(s.home.path().join("approved.txt").exists());
    let mut actions = Vec::new();
    while let Ok(m) = owner_rx.try_recv() {
        let m: Value = serde_json::from_str(&m).unwrap();
        actions.push(m["message"]["action"].as_str().unwrap_or_default().to_string());
    }
    assert!(actions.contains(&"COMMAND-APPROVAL-REQUESTED".to_string()) && actions.contains(&"COMMAND-APPROVAL-DECIDED".to_string()), "{actions:?}");

    // 拒絕：回錯誤、沒跑。/ Denied: an error, nothing ran.
    let deny_soon = async {
        let q = first_pending().await;
        let r = app.post(&format!("/api/command-requests/{}/deny", q["id"]), Some(&s.web), json!({"reason": "use the staging box"})).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    };
    let ((err, v), ()) = tokio::join!(call(app, &token, "ssh_exec", json!({"session_id": sid, "command": "touch denied.txt"})), deny_soon);
    assert!(err, "{v}");
    assert!(v.as_str().unwrap().contains("use the staging box"), "{v}");
    assert!(!s.home.path().join("denied.txt").exists());

    // 每次都進 AI 稽核（被擋的算失敗）。/ Every call is audited; refused ones as failures.
    let r = app.get("/api/ai/activity", Some(&s.web)).await;
    let failed: Vec<&str> = r.json.as_array().unwrap().iter().filter(|e| e["tool"] == "ssh_exec" && e["ok"] == false).map(|e| e["error"].as_str().unwrap_or_default()).collect();
    assert!(failed.iter().any(|e| e.contains("blocked by the rule `rm`")), "{failed:?}");
    assert!(failed.iter().any(|e| e.contains("denied")), "{failed:?}");
}

/// 等到第一筆待核准的指令申請。/ Wait for the first pending command request.
async fn first_pending(app: &TestApp, web: &str) -> Value {
    loop {
        let r = app.get("/api/command-requests?status=pending", Some(web)).await;
        if let Some(q) = r.json["requests"].as_array().and_then(|a| a.first()) {
            return q.clone();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 讀到輸出裡出現 `needle` 為止（最多幾次）。/ Read until `needle` shows up in the output.
async fn read_until(app: &TestApp, token: &str, shell: &str, needle: &str) -> Value {
    let mut seen = String::new();
    for _ in 0..10 {
        let (err, v) = call(app, token, "shell_read", json!({"shell_id": shell, "timeout_ms": 2000})).await;
        assert!(!err, "{v}");
        seen.push_str(v["output"].as_str().unwrap_or(""));
        if seen.contains(needle) || v["screen"].as_str().unwrap_or("").contains(needle) {
            return v;
        }
    }
    panic!("{needle:?} never showed up; got {seen:?}");
}

/// 互動 shell：PTY（xterm-256color）、輸出 + 畫面、控制字元、改大小、上限、錄影、跟 session 一起關、即時 session 頁的 shell 數。
/// Interactive shells: PTY, output + screen, control characters, resize, the cap, recording, closing with the session.
#[tokio::test]
async fn interactive_shells_read_the_screen_and_are_recorded() {
    let Some(s) = setup().await else { return };
    let app = &s.app;
    let (token, _) = oauth_token(app, &s.web, "", json!(null)).await;
    let (_, v) = call(app, &token, "ssh_session_open", json!({"tunnel_id": s.tunnel_id})).await;
    let sid = v["session_id"].as_str().unwrap().to_string();

    // tunnels:read 而已 → 不能開 shell。/ tunnels:read alone cannot open a shell.
    let (read_only, _) = oauth_token(app, &s.web, "tunnels:read", json!(null)).await;
    let (err, v) = call(app, &read_only, "shell_open", json!({"session_id": sid})).await;
    assert!(err && v.as_str().unwrap().contains("ssh:exec"), "{v}");

    let (err, v) = call(app, &token, "shell_open", json!({"session_id": sid, "cols": 100, "rows": 30})).await;
    assert!(!err, "{v}");
    let shell = v["shell_id"].as_str().unwrap().to_string();
    assert!(shell.starts_with("sh_"));
    assert_eq!(v["recorded"], false);
    assert_eq!(s.device.lock().unwrap().terms, vec![("xterm-256color".to_string(), 100, 30)]);

    // 提示字元出現在畫面上。/ The prompt shows on the screen.
    let v = read_until(app, &token, &shell, "$").await;
    assert!(v["screen"].as_str().unwrap().starts_with("welcome\n$"), "{v}");
    assert_eq!(v["size"], json!({"cols": 100, "rows": 30}));

    // 打字 + Enter：跑了。/ Type and press Enter: it runs.
    let (err, v) = call(app, &token, "shell_send", json!({"shell_id": shell, "input": "echo hi", "press_enter": true})).await;
    assert!(!err, "{v}");
    assert_eq!(v["bytes_sent"], 8);
    read_until(app, &token, &shell, "ran:echo hi").await;
    assert_eq!(s.device.lock().unwrap().commands, vec!["echo hi".to_string()]);

    // TUI：清畫面、跳游標畫字 → screen 照人看到的樣子。/ A TUI drawn with cursor moves reads like the screen.
    call(app, &token, "shell_send", json!({"shell_id": shell, "input": "draw\r"})).await;
    let v = read_until(app, &token, &shell, "middle").await;
    let screen = v["screen"].as_str().unwrap();
    assert!(screen.starts_with("TOP LINE\n\n    middle"), "{screen:?}");
    assert_eq!(v["cursor"], json!({"row": 4, "col": 2}));

    // 控制字元：Ctrl+C 丟掉這一行。/ Control characters: Ctrl+C abandons the line.
    call(app, &token, "shell_send", json!({"shell_id": shell, "input": "half\u{3}"})).await;
    read_until(app, &token, &shell, "^C").await;
    let (_, v) = call(app, &token, "shell_resize", json!({"shell_id": shell, "cols": 90, "rows": 25})).await;
    assert_eq!(v["cols"], 90);
    assert_eq!(s.device.lock().unwrap().resizes, vec![(90, 25)]);

    // 即時 session 頁：這個 agent session 有 1 個 shell。/ The live sessions page shows one shell.
    let r = app.get("/api/sessions", Some(&s.web)).await;
    let row = r.json["sessions"].as_array().unwrap().iter().find(|x| x["kind"] == "ai").unwrap().clone();
    assert_eq!(row["shells"], 1, "{row}");
    assert_eq!(app.get("/api/ai/sessions", Some(&s.web)).await.json[0]["shells"], 1);

    // 錄影：開了之後新開的 shell 會錄（kind = agent）。/ Recording: shells opened afterwards are recorded as `agent`.
    let r = app.put(&format!("/api/reverse/server/{}/recording", s.tunnel_id), Some(&s.web), json!({"enabled": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let (_, v) = call(app, &token, "shell_open", json!({"session_id": sid})).await;
    assert_eq!(v["recorded"], true, "{v}");
    let second = v["shell_id"].as_str().unwrap().to_string();
    read_until(app, &token, &second, "$").await;
    call(app, &token, "shell_send", json!({"shell_id": second, "input": "uptime", "press_enter": true})).await;
    read_until(app, &token, &second, "ran:uptime").await;
    // 每個 session 最多 2 個。/ Two shells per session at most.
    let (err, v) = call(app, &token, "shell_open", json!({"session_id": sid})).await;
    assert!(err && v.as_str().unwrap().contains("limit is 2"), "{v}");
    let (err, _) = call(app, &token, "shell_close", json!({"shell_id": second})).await;
    assert!(!err);
    let (err, v) = call(app, &token, "shell_read", json!({"shell_id": second})).await;
    assert!(err && v.as_str().unwrap().contains("Unknown or closed shell_id"), "{v}");
    let r = app.get(&format!("/api/recordings?tunnel_id={}", s.tunnel_id), Some(&s.web)).await;
    let rec = r.json["recordings"][0].clone();
    assert_eq!(rec["kind"], "agent", "{}", r.text);
    assert_eq!(rec["os_user"], "alice");
    assert_eq!(rec["live"], false);
    let cast = app.get(&format!("/api/recordings/{}/cast", rec["id"]), Some(&s.web)).await.text;
    assert!(cast.contains("ran:uptime") && cast.contains(r#""width":120"#), "{cast}");

    // 關 session → 它的 shell 一起關；稽核每一步。/ Closing the session closes its shells; every step is audited.
    call(app, &token, "ssh_session_close", json!({"session_id": sid})).await;
    let (err, _) = call(app, &token, "shell_read", json!({"shell_id": shell})).await;
    assert!(err);
    let rows = app.get("/api/ai/activity", Some(&s.web)).await.json;
    let rows = rows.as_array().unwrap();
    let sent = rows.iter().find(|e| e["tool"] == "shell_send" && e["detail"].as_str().unwrap().ends_with("echo hi\\r")).unwrap();
    assert_eq!(sent["bytes_out"], 8);
    assert!(rows.iter().any(|e| e["tool"] == "shell_read"));
    assert!(rows.iter().any(|e| e["tool"] == "shell_resize" && e["detail"].as_str().unwrap().ends_with("90x25")));
    let closes: Vec<&str> = rows.iter().filter(|e| e["tool"] == "shell_close").map(|e| e["detail"].as_str().unwrap()).collect();
    assert!(closes.iter().any(|d| d.contains("closed_by_agent")) && closes.iter().any(|d| d.contains("session_closed")), "{closes:?}");
}

/// 指令規則也管 shell：擋下的那一行改送 Ctrl+C，要核准的等 owner 按。/ Command rules gate the shell's Enter too.
#[tokio::test]
async fn command_rules_gate_enter_in_agent_shells() {
    let Some(s) = setup().await else { return };
    let app = &s.app;
    let rules = format!("/api/reverse/server/{}/command-rules", s.tunnel_id);
    for body in [json!({"action": "block", "pattern": "rm", "note": "No deleting"}), json!({"action": "approve", "pattern": "touch"})] {
        assert_eq!(app.post(&rules, Some(&s.web), body).await.status, StatusCode::CREATED);
    }
    let (token, _) = oauth_token(app, &s.web, "", json!(null)).await;
    let (_, v) = call(app, &token, "ssh_session_open", json!({"tunnel_id": s.tunnel_id})).await;
    let sid = v["session_id"].as_str().unwrap().to_string();
    let (_, v) = call(app, &token, "shell_open", json!({"session_id": sid})).await;
    let shell = v["shell_id"].as_str().unwrap().to_string();
    read_until(app, &token, &shell, "$").await;

    // 沒有規則的指令照常跑。/ Commands without a rule run.
    let (err, v) = call(app, &token, "shell_send", json!({"shell_id": shell, "input": "ls -la", "press_enter": true})).await;
    assert!(!err, "{v}");
    read_until(app, &token, &shell, "ran:ls -la").await;

    // 擋下：Ctrl+C 取代 Enter，沒跑。/ Blocked: Ctrl+C instead of Enter; nothing ran.
    let (err, v) = call(app, &token, "shell_send", json!({"shell_id": shell, "input": "rm -rf /tmp/x", "press_enter": true})).await;
    assert!(err, "{v}");
    let msg = v.as_str().unwrap();
    assert!(msg.contains("`rm`") && msg.contains("No deleting") && msg.contains("Ctrl+C"), "{msg}");
    read_until(app, &token, &shell, "^C").await;
    assert!(!s.device.lock().unwrap().commands.iter().any(|c| c.starts_with("rm")));

    // 要核准：等 owner 在網頁按下才送 Enter。/ Held until the owner approves in the web.
    let approve = async {
        let q = first_pending(app, &s.web).await;
        assert_eq!((q["source"].as_str(), q["command"].as_str()), (Some("agent"), Some("touch done.txt")));
        assert!(!s.device.lock().unwrap().commands.iter().any(|c| c.starts_with("touch")), "nothing runs before the approval");
        let r = app.post(&format!("/api/command-requests/{}/approve", q["id"]), Some(&s.web), json!({})).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    };
    let ((err, v), ()) = tokio::join!(call(app, &token, "shell_send", json!({"shell_id": shell, "input": "touch done.txt", "press_enter": true})), approve);
    assert!(!err, "{v}");
    read_until(app, &token, &shell, "ran:touch done.txt").await;

    // 拒絕：Ctrl+C，tool 回錯誤。/ Denied: Ctrl+C and an error.
    let deny = async {
        let q = first_pending(app, &s.web).await;
        app.post(&format!("/api/command-requests/{}/deny", q["id"]), Some(&s.web), json!({"reason": "not today"})).await;
    };
    let ((err, v), ()) = tokio::join!(call(app, &token, "shell_send", json!({"shell_id": shell, "input": "touch no.txt", "press_enter": true})), deny);
    assert!(err && v.as_str().unwrap().contains("not today"), "{v}");
    assert!(!s.device.lock().unwrap().commands.iter().any(|c| c == "touch no.txt"));

    let rows = app.get("/api/ai/activity", Some(&s.web)).await.json;
    let failed: Vec<&str> = rows.as_array().unwrap().iter().filter(|e| e["tool"] == "shell_send" && e["ok"] == false).map(|e| e["error"].as_str().unwrap_or("")).collect();
    assert!(failed.iter().any(|e| e.contains("blocked by the rule `rm`")), "{failed:?}");
}

/// agent 的遠端瀏覽器：開（經裝置的 SOCKS）、導向、讀、截圖（image content block）、點、打字（敏感的只記長度）、即時 session 頁結束它。
/// Agent browsers: open through the device, navigate, read, screenshot as an image block, click, type (sensitive text
/// only by length), and being ended from the live sessions page.
#[tokio::test]
async fn agent_browsers_are_remote_browser_sessions() {
    let Some(s) = setup().await else { return };
    let app = &s.app;

    // 沒有 browser:use → 不能開。/ Without browser:use it can't open one.
    let (no_browser, _) = oauth_token(app, &s.web, "tunnels:read ssh:exec", json!(null)).await;
    let (err, v) = call(app, &no_browser, "browser_open", json!({"tunnel_id": s.tunnel_id})).await;
    assert!(err && v.as_str().unwrap().contains("browser:use"), "{v}");

    let (token, _) = oauth_token(app, &s.web, "browser:use", json!(null)).await;
    let (err, v) = call(app, &token, "browser_open", json!({"tunnel_id": s.tunnel_id, "url": "file:///etc/passwd"})).await;
    assert!(err && v.as_str().unwrap().contains("http and https"), "{v}");
    let mut owner_rx = app.state.hub.subscribe_user(s.admin_id);
    let (err, v) = call(app, &token, "browser_open", json!({"tunnel_id": s.tunnel_id, "url": "example.com"})).await;
    assert!(!err, "{v}");
    let bid = v["browser_id"].as_str().unwrap().to_string();
    assert!(bid.starts_with("aib_"));
    assert_eq!(v["page"]["title"], "Fake page");
    assert_eq!(v["username"], "alice");
    let msg: Value = serde_json::from_str(&owner_rx.try_recv().unwrap()).unwrap();
    assert_eq!((msg["message"]["action"].as_str(), msg["message"]["kind"].as_str()), (Some("AI-SESSION-OPENED"), Some("browser")));
    {
        let log = s.kasm.lock().unwrap();
        assert!(log[0]["proxy"].as_str().unwrap().starts_with("socks5://"), "{log:?}");
        assert_eq!(log[1]["action"], json!({"action": "navigate", "url": "https://example.com/"}));
    }

    let (err, v) = call(app, &token, "browser_read", json!({"browser_id": bid})).await;
    assert!(!err && v["text"] == "Hello from behind the device", "{v}");
    let (err, v) = call(app, &token, "browser_navigate", json!({"browser_id": bid, "url": "http://192.168.1.1/"})).await;
    assert!(!err && v["url"] == "http://192.168.1.1/", "{v}");
    // 截圖 = image content block（PNG）。/ A screenshot comes back as an image block.
    let r = mcp_raw(app, Some(&token), json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "browser_screenshot", "arguments": {"browser_id": bid}}})).await;
    let content = &r.json["result"]["content"];
    assert_eq!((content[0]["type"].as_str(), content[0]["mimeType"].as_str()), (Some("image"), Some("image/png")), "{}", r.text);
    assert_eq!(STANDARD.decode(content[0]["data"].as_str().unwrap()).unwrap(), b"\x89PNG fake");
    let (err, v) = call(app, &token, "browser_click", json!({"browser_id": bid, "selector": "#missing"})).await;
    assert!(err && v.as_str().unwrap().contains("No element matches #missing"), "{v}");
    let (err, v) = call(app, &token, "browser_click", json!({"browser_id": bid, "text": "Save"})).await;
    assert!(!err && v["title"] == "Saved", "{v}");
    let (err, _) = call(app, &token, "browser_type", json!({"browser_id": bid, "selector": "#pw", "text": "hunter2", "press_enter": true})).await;
    assert!(!err);
    call(app, &token, "browser_type", json!({"browser_id": bid, "selector": "#q", "text": "weather", "sensitive": false})).await;

    // 列在 session 清單與即時 session 頁（kind browser、client = app）。/ Listed for the agent and on the live sessions page.
    let (_, v) = call(app, &token, "ssh_session_list", json!({})).await;
    assert_eq!(v["browsers"][0]["browser_id"], bid);
    let r = app.get("/api/sessions", Some(&s.web)).await;
    let row = r.json["sessions"].as_array().unwrap().iter().find(|x| x["kind"] == "browser").unwrap().clone();
    assert_eq!(row["client"], "Test Agent");

    // 從即時 session 頁結束 → tool 回「被誰結束」，kasm session 收掉。/ Ended from the web: tools say who ended it.
    assert_eq!(app.delete(&format!("/api/sessions/{}", row["id"]), Some(&s.web)).await.status, StatusCode::NO_CONTENT);
    let (err, v) = call(app, &token, "browser_read", json!({"browser_id": bid})).await;
    assert!(err && v.as_str().unwrap().contains("ended by admin"), "{v}");
    assert!(s.kasm.lock().unwrap().iter().any(|e| e["op"] == "stop" && e["session"] == "kasm-1"));
    assert!(app.state.ai.browsers.get(&bid).is_none());

    // 稽核：網址、選擇器；敏感文字只記長度。/ Audit: URLs and selectors; sensitive text by length only.
    let rows = app.get("/api/ai/activity", Some(&s.web)).await.json;
    let rows = rows.as_array().unwrap();
    let detail = |tool: &str| rows.iter().filter(|e| e["tool"] == tool).map(|e| e["detail"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>();
    assert!(detail("browser_open")[0].contains("url: https://example.com/"));
    assert_eq!(detail("browser_navigate"), vec!["http://192.168.1.1/".to_string()]);
    assert_eq!(detail("browser_screenshot"), vec!["screenshot".to_string()]);
    let typed = detail("browser_type");
    assert!(typed.iter().any(|d| d == "selector: #pw; 7 characters + Enter") && typed.iter().any(|d| d == "selector: #q; \"weather\""), "{typed:?}");
    assert!(!typed.iter().any(|d| d.contains("hunter2")));
    assert!(detail("browser_close")[0].contains("by: admin"));
    let events = app.get(&format!("/api/log/ssh/events?tunnel_id={}", s.tunnel_id), Some(&s.web)).await.json;
    let kinds: Vec<&str> = events.as_array().unwrap().iter().map(|e| e["event"].as_str().unwrap_or("")).collect();
    assert!(kinds.contains(&"browser_open") && kinds.contains(&"browser_close"), "{kinds:?}");

    // 撤銷 grant → 開著的瀏覽器立刻關。/ Revoking the grant closes its browsers at once.
    let (token2, grant2) = oauth_token(app, &s.web, "browser:use", json!(null)).await;
    let (_, v) = call(app, &token2, "browser_open", json!({"tunnel_id": s.tunnel_id})).await;
    let bid2 = v["browser_id"].as_str().unwrap().to_string();
    assert_eq!(app.delete(&format!("/api/oauth/grants/{grant2}"), Some(&s.web)).await.status, StatusCode::NO_CONTENT);
    assert!(app.state.ai.browsers.get(&bid2).is_none());
}

/// REST 版的瀏覽器動作（`/api/browser/*`）：個人 API token（`browser:use`）與網頁登入都能用；跟 MCP 同一套上限、稽核、
/// 「誰在用」；session 只屬於開它的憑證；敏感隧道拒絕；token 的 MCP tool call 也進呼叫紀錄。
/// The REST browser actions with a personal token and with a web sign-in: same limit, audit and presence as MCP;
/// a browser belongs to its credential; step-up tunnels are refused; a token's MCP tool calls reach the call log.
#[tokio::test]
async fn browser_rest_api_with_tokens_and_web() {
    let Some(s) = setup().await else { return };
    let app = &s.app;
    let tok = |scopes: Value| {
        let web = s.web.clone();
        async move {
            let r = app.post("/api/auth/tokens", Some(&web), json!({"name": "scraper", "scopes": scopes, "expires_at": (chrono::Utc::now() + chrono::Duration::days(3)).to_rfc3339()})).await;
            assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
            r.json["secret"].as_str().unwrap().to_string()
        }
    };
    let read_only = tok(json!(["tunnels:read"])).await;
    let r = app.post("/api/browser/sessions", Some(&read_only), json!({"tunnel_id": s.tunnel_id})).await;
    assert_eq!((r.status, r.json["code"].as_str(), r.json["scope"].as_str()), (StatusCode::FORBIDDEN, Some("token_scope"), Some("browser:use")), "{}", r.text);

    let token = tok(json!(["tunnels:read", "browser:use"])).await;
    let r = app.post("/api/browser/sessions", Some(&token), json!({"tunnel_id": s.tunnel_id, "url": "file:///etc/passwd"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.json["url"].is_array(), "{}", r.text);
    let r = app.post("/api/browser/sessions", Some(&token), json!({"tunnel_id": s.tunnel_id, "url": "example.com"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let id = r.json["id"].as_str().unwrap().to_string();
    assert_eq!(r.json["page"]["url"], "https://example.com/");

    let r = app.post(&format!("/api/browser/sessions/{id}/navigate"), Some(&token), json!({"url": "http://192.168.1.1/"})).await;
    assert_eq!((r.status, r.json["url"].as_str()), (StatusCode::OK, Some("http://192.168.1.1/")), "{}", r.text);
    let r = app.get(&format!("/api/browser/sessions/{id}/text?selector=main"), Some(&token)).await;
    assert_eq!((r.status, r.json["text"].as_str()), (StatusCode::OK, Some("Hello from behind the device")), "{}", r.text);
    let r = app.get(&format!("/api/browser/sessions/{id}/screenshot"), Some(&token)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.headers.get("content-type").unwrap(), "image/png");
    assert!(r.text.contains("PNG fake"));
    let r = app.post(&format!("/api/browser/sessions/{id}/click"), Some(&token), json!({"selector": "#missing"})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_REQUEST, Some("browser_action_failed")), "{}", r.text);
    let r = app.post(&format!("/api/browser/sessions/{id}/click"), Some(&token), json!({"text": "Save"})).await;
    assert_eq!(r.json["url"], "https://example.com/saved", "{}", r.text);
    let r = app.post(&format!("/api/browser/sessions/{id}/type"), Some(&token), json!({"selector": "#pw", "text": "hunter2", "press_enter": true})).await;
    assert_eq!(r.json["typed"], 7, "{}", r.text);
    assert_eq!(app.get("/api/browser/sessions", Some(&token)).await.json.as_array().unwrap().len(), 1);
    // 「誰在用」：kind browser、client = token 的名稱。/ Presence: kind browser, client = the token's name.
    let live = app.get("/api/sessions", Some(&s.web)).await;
    let row = live.json["sessions"].as_array().unwrap().iter().find(|x| x["kind"] == "browser").unwrap().clone();
    assert_eq!(row["client"], "API token \"scraper\"", "{row}");

    // 網頁登入也能開；兩邊互相看不到對方的瀏覽器。/ A web sign-in can open one too; neither sees the other's.
    let r = app.post("/api/browser/sessions", Some(&s.web), json!({"tunnel_id": s.tunnel_id})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let web_id = r.json["id"].as_str().unwrap().to_string();
    assert_eq!(app.get(&format!("/api/browser/sessions/{web_id}/text"), Some(&token)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get(&format!("/api/browser/sessions/{id}/text"), Some(&s.web)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get("/api/browser/sessions", Some(&s.web)).await.json.as_array().unwrap().len(), 1);

    // 上限（跟 SSH session 共用）。/ The per-person limit, shared with SSH sessions.
    app.post("/api/site/settings", Some(&s.web), json!({"ai_max_sessions_per_user": 2})).await;
    let r = app.post("/api/browser/sessions", Some(&token), json!({"tunnel_id": s.tunnel_id})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_REQUEST, Some("browser_open_failed")), "{}", r.text);
    assert!(r.json["error"].as_str().unwrap().contains("limit is 2"), "{}", r.text);
    app.post("/api/site/settings", Some(&s.web), json!({"ai_max_sessions_per_user": 3})).await;

    assert_eq!(app.request(Method::DELETE, &format!("/api/browser/sessions/{web_id}"), Some(&s.web), None).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.request(Method::DELETE, &format!("/api/browser/sessions/{id}"), Some(&token), None).await.status, StatusCode::NO_CONTENT);
    let r = app.get(&format!("/api/browser/sessions/{id}/text"), Some(&token)).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::NOT_FOUND, Some("browser_closed")));

    // 敏感隧道拒絕。/ Step-up tunnels are refused.
    sqlx::query("UPDATE authorized_keys_reverseserverauthorizedkeys SET require_step_up = 1 WHERE id = ?").bind(s.tunnel_id).execute(&app.state.db.write).await.unwrap();
    let r = app.post("/api/browser/sessions", Some(&token), json!({"tunnel_id": s.tunnel_id})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("step_up_refused")), "{}", r.text);
    sqlx::query("UPDATE authorized_keys_reverseserverauthorizedkeys SET require_step_up = 0 WHERE id = ?").bind(s.tunnel_id).execute(&app.state.db.write).await.unwrap();

    // 稽核：跟 MCP 同一張表。/ Audited in the same table as MCP.
    let rows = app.get("/api/ai/activity", Some(&s.web)).await.json;
    let tools: Vec<(String, String)> = rows.as_array().unwrap().iter().map(|e| (e["tool"].as_str().unwrap().to_string(), e["client_name"].as_str().unwrap().to_string())).collect();
    for t in ["browser_open", "browser_navigate", "browser_read", "browser_screenshot", "browser_click", "browser_type", "browser_close"] {
        assert!(tools.iter().any(|(tool, c)| tool == t && c == "API token \"scraper\""), "{t}: {tools:?}");
    }
    assert!(tools.iter().any(|(tool, c)| tool == "browser_open" && c == "Telepy web sign-in"), "{tools:?}");
    let typed = rows.as_array().unwrap().iter().find(|e| e["tool"] == "browser_type").unwrap()["detail"].as_str().unwrap().to_string();
    assert!(typed.contains("7 characters") && !typed.contains("hunter2"), "{typed}");

    // 個人 token 的 MCP tool call 也進呼叫紀錄（成功 200、tool 錯誤 400）。/ A token's MCP tool calls are logged too.
    let (err, _) = call(app, &token, "list_tunnels", json!({})).await;
    assert!(!err);
    let (err, _) = call(app, &token, "browser_navigate", json!({"browser_id": "aib_nope", "url": "https://example.com"})).await;
    assert!(err);
    app.state.api_calls.flush().await;
    let log = app.get("/api/auth/tokens/calls?limit=1000", Some(&s.web)).await;
    let calls: Vec<(String, String, i64)> = log.json["calls"].as_array().unwrap().iter().map(|c| (c["method"].as_str().unwrap().to_string(), c["route"].as_str().unwrap().to_string(), c["status"].as_i64().unwrap())).collect();
    assert!(calls.contains(&("POST".into(), "/api/browser/sessions/{id}/navigate".into(), 200)), "{calls:?}");
    assert!(calls.contains(&("GET".into(), "/api/browser/sessions/{id}/screenshot".into(), 200)), "{calls:?}");
    assert!(calls.contains(&("MCP".into(), "list_tunnels".into(), 200)), "{calls:?}");
    assert!(calls.contains(&("MCP".into(), "browser_navigate".into(), 400)), "{calls:?}");
    assert!(!calls.iter().any(|(m, r, _)| m == "POST" && r == "/api/browser/sessions" && log.json["calls"].as_array().unwrap().iter().any(|c| c["client_name"] == "Telepy web sign-in")), "web calls are not logged");
}
