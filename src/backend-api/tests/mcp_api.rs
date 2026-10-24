//! MCP 端點端到端：OAuth token → `/mcp`（rmcp stateless Streamable HTTP）→ AI SSH session 打到一個假的裝置 sshd
//! （russh server：exec 用 `sh -c`、sftp 轉接本機 `sftp-server`）。沒有 ssh-keygen 就跳過；沒有 sftp-server 時略過 SFTP 部分。
//! The MCP endpoint end to end against a fake device sshd (russh server running `sh -c` and the local sftp-server).
mod common;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use russh::server::{self, Auth, ChannelOpenHandle, Handler, Msg, Session};
use russh::{Channel, ChannelId, ChannelMsg};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
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

struct Device {
    home: PathBuf,
    channels: HashMap<ChannelId, Channel<Msg>>,
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
async fn start_device(host_key: &Path, home: PathBuf) -> u16 {
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
            let (cfg, home) = (config.clone(), home.clone());
            tokio::spawn(async move {
                if let Ok(s) = server::run_stream(cfg, sock, Device { home, channels: HashMap::new() }).await {
                    let _ = s.await;
                }
            });
        }
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
    let device_port = start_device(&host_key, home.path().to_path_buf()).await;

    let mut app = common::spawn().await;
    let mut config = app.state.config.clone();
    config.ssh_identity = identity;
    config.ssh_target_host = "127.0.0.1".into();
    app.state = telepy_server::state::AppState::new(config, app.state.db.clone());
    app.router = telepy_server::app::build(app.state.clone());
    let web = app.login("admin", "pw").await;
    let admin_id = app.get("/api/auth/user/profile", Some(&web)).await.json["id"].as_i64().unwrap();
    let r = app.post("/api/reverse/server/keys", Some(&web), json!({"host_friendly_name": "box-a", "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIboxa box-a", "reverse_port": device_port})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let tunnel_id = r.json["id"].as_i64().unwrap();
    let r = app.post("/api/reverse/server/usernames", Some(&web), json!({"reverse_server": tunnel_id, "username": "alice"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    Some(Setup { app, web, admin_id, tunnel_id, device_port, home, _keys: keys })
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
    for t in ["list_tunnels", "tunnel_status", "ssh_session_open", "ssh_exec", "ssh_session_close", "ssh_session_list", "sftp_list", "sftp_read", "sftp_write"] {
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
