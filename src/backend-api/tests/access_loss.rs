//! 失去權限就結束每一種進行中的 session（SSH lab 上）：檔案管理（允許帳號被拿掉 → 4009 + `files_close` 說為什麼）、
//! 筆電經 gateway 的 ssh（取消分享 → 馬上斷 + `session_ended` 事件）、看終端機（降成 VIEW → 4009，被看的人照用）；
//! 停用帳號：網頁登入全部撤銷（通知 socket 4010 `disabled`、access token / refresh 立刻失效）、終端機與檔案 4009、
//! MCP agent session 關掉、個人 API token 與 OAuth app 暫停（重新啟用就回來，網頁登入不會）、筆電 ssh 也連不上。
//! 遠端瀏覽器 / 遠端桌面 / RustDesk 的同一件事在各自的測試檔（它們的假服務在那裡）。
//! Losing access ends every kind of live session: files (account removed → 4009 + why in `files_close`), laptop SSH
//! through the gateway (unshare → cut at once + a `session_ended` event), watchers (lowered to VIEW → 4009, the watched
//! shell carries on). Disabling an account revokes its web sign-ins (4010 `disabled`, tokens stop at once), ends its
//! terminals / file managers (4009) and MCP agent sessions, and suspends its API tokens and OAuth apps (back on
//! re-enable; web sign-ins are not), and laptop SSH is refused. Remote browser / desktop / RustDesk live next to their
//! fake services in their own test files.
mod common;

use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use common::lab::{Device, Hop, Lab, LabUser};
use common::TestApp;
use telepy_server::access_recheck::ENDED_BY;

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

async fn events(lab: &Lab, token: &str, tunnel_id: i64) -> Vec<Value> {
    lab.app.get(&format!("/api/log/ssh/events?tunnel_id={tunnel_id}"), Some(token)).await.json.as_array().cloned().unwrap_or_default()
}

/// 等一筆 `kind` 事件，訊息含 `needle`。/ Wait for a `kind` event whose message contains `needle`.
async fn wait_event(lab: &Lab, token: &str, tunnel_id: i64, kind: &str, needle: &str) -> String {
    for _ in 0..100 {
        if let Some(e) = events(lab, token, tunnel_id).await.into_iter().rev().find(|e| e["event"] == kind && e["message"].as_str().unwrap_or("").contains(needle)) {
            return e["message"].as_str().unwrap().to_string();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("no {kind} event with {needle:?}: {:?}", events(lab, token, tunnel_id).await);
}

async fn wait_presence(lab: &Lab, tunnel_id: i64, what: &str, ok: impl Fn(&[telepy_server::presence::Entry]) -> bool) {
    for _ in 0..100 {
        if ok(&lab.app.state.presence.for_tunnel(tunnel_id)) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("presence never became {what}: {:?}", lab.app.state.presence.for_tunnel(tunnel_id));
}

fn has_kind(p: &[telepy_server::presence::Entry], kind: &str, user: &str) -> bool {
    p.iter().any(|e| e.kind.as_str() == kind && e.username == user)
}

/// 開著的檔案管理 socket（登入裝置帳號後才回）。/ An open file manager socket, returned once the device login is up.
async fn file_manager(lab: &Lab, user: &LabUser, dev: &Device, os_user: &str) -> Ws {
    let base = lab.ws_base().await;
    let (mut ws, _) = connect_async(format!("{base}/ws/filemanager/")).await.unwrap();
    let auth = json!({"type": "auth", "token": user.token, "server_id": dev.tunnel_id.to_string(), "username": os_user});
    ws.send(Message::Text(auth.to_string().into())).await.unwrap();
    wait_presence(lab, dev.tunnel_id, "a file manager", |p| has_kind(p, "files", &user.username)).await;
    ws
}

/// 等伺服器關掉 socket，回 (關閉碼, 原因)。/ Wait for the server to close the socket.
async fn closed(ws: &mut Ws) -> (u16, String) {
    loop {
        match tokio::time::timeout(Duration::from_secs(10), ws.next()).await.expect("the socket was not closed") {
            Some(Ok(Message::Close(Some(f)))) => return (u16::from(f.code), f.reason.to_string()),
            Some(Ok(Message::Close(None))) | None => return (1005, String::new()),
            Some(Ok(_)) => {}
            Some(Err(e)) => panic!("socket error: {e}"),
        }
    }
}

/// 從 hub 等一則 `SESSION-ENDED`（`kind`）。/ Wait for a `SESSION-ENDED` of `kind` on the user's hub channel.
async fn session_ended(rx: &mut tokio::sync::broadcast::Receiver<std::sync::Arc<str>>, kind: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let m: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
            if m["message"]["action"] == "SESSION-ENDED" && m["message"]["kind"] == kind {
                return m["message"].clone();
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no SESSION-ENDED for {kind}"))
}

#[tokio::test]
async fn losing_access_ends_files_laptop_ssh_and_watchers() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await; // owner
    let bob = lab.user("bob").await; // VIEW sharee
    let carol = lab.user("carol").await; // ADMIN sharee who watches
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service, &bob.key])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    let id = dev.tunnel_id;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    lab.share(&alice, &dev, &carol, "admin", &[]).await;
    let allowed = format!("/tunnels/share/{id}/{}/allowed-usernames", bob.id);

    // 1. 檔案管理：允許帳號被拿掉 → 4009（原因 = 存取變了）、通知、`files_close` 說為什麼。
    // Files: the account leaves the allow-list → 4009, a notification, and why in `files_close`.
    let mut hub = lab.app.state.hub.subscribe_user(bob.id);
    let mut fm = file_manager(&lab, &bob, &dev, "ubuntu").await;
    let r = lab.app.patch(&allowed, Some(&alice.token), json!({"allowed_target_username_ids": []})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(closed(&mut fm).await, (4009, ENDED_BY.to_string()));
    let note = session_ended(&mut hub, "files").await;
    assert_eq!((note["reason"].as_str(), note["by"].as_str()), (Some("login_removed"), Some(ENDED_BY)), "{note}");
    wait_event(&lab, &alice.token, id, "files_close", "the login account is no longer allowed").await;
    wait_presence(&lab, id, "without files", |p| !has_kind(p, "files", "bob")).await;

    // 2. 筆電經 gateway 的 ssh（跑 20 秒）：取消分享 → 馬上斷，記一筆 `session_ended`。
    // Laptop SSH running 20 s: unsharing cuts it at once and logs `session_ended`.
    let r = lab.app.patch(&allowed, Some(&alice.token), json!({"allowed_target_username_ids": [ubuntu]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let laptop = [(Hop::Tunnel(&dev), "ubuntu")];
    let started = Instant::now();
    let (run, _) = tokio::join!(lab.laptop_exec(&bob, &laptop, "sleep 20"), async {
        wait_presence(&lab, id, "a laptop ssh", |p| has_kind(p, "ssh", "bob")).await;
        let r = lab.app.delete(&format!("/tunnels/unshare/{id}/{}", bob.id), Some(&alice.token)).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    });
    assert!(!run.ok, "the laptop ssh must be cut: {run:?}");
    assert!(started.elapsed() < Duration::from_secs(15), "cut at once, not after the command finished");
    let note = session_ended(&mut hub, "ssh").await;
    assert_eq!(note["reason"], "access_removed", "{note}");
    wait_event(&lab, &alice.token, id, "session_ended", "access to the tunnel was removed").await;
    wait_presence(&lab, id, "without ssh", |p| !has_kind(p, "ssh", "bob")).await;

    // 3. 看終端機：carol 被降成 VIEW → 她的觀看 4009；bob 的 shell 照用。
    // Watching: carol lowered to VIEW → her watch closes 4009; bob's shell carries on.
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    let mut t = lab.terminal(&bob, &dev, "ubuntu").await.expect("bob's terminal");
    t.expect("login:ubuntu@box").await;
    let mut w = lab.watch(&carol, &t.shell_id()).await.expect("carol watches");
    wait_presence(&lab, id, "a watcher", |p| has_kind(p, "watch", "carol")).await;
    let mut carol_hub = lab.app.state.hub.subscribe_user(carol.id);
    let r = lab.app.patch(&format!("/tunnels/update-permission/{id}/{}", carol.id), Some(&alice.token), json!({"permission_type": "view"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(w.wait_closed_reason().await, Some((4009, ENDED_BY.to_string())));
    assert_eq!(session_ended(&mut carol_hub, "watch").await["reason"], "access_removed");
    wait_event(&lab, &alice.token, id, "terminal_watch_end", "they no longer manage this tunnel").await;
    t.input("echo still-here\r").await;
    t.expect("still-here").await;
    assert!(has_kind(&lab.app.state.presence.for_tunnel(id), "terminal", "bob"), "the watched shell stays");
}

// ---------------------------------------------------------------- disabling an account

const REDIRECT: &str = "http://localhost:33418/callback";
const VERIFIER: &str = "verifier-verifier-verifier-verifier-verifier-0123";

/// OAuth app（MCP）的 access token。/ An OAuth app's (MCP) access token.
async fn oauth_token(app: &TestApp, web: &str, scope: &str) -> String {
    let r = app.post("/api/oauth/register", None, json!({"client_name": "Test Agent", "redirect_uris": [REDIRECT], "token_endpoint_auth_method": "none"})).await;
    let client_id = r.json["client_id"].as_str().unwrap().to_string();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(VERIFIER.as_bytes()));
    let r = app
        .post(
            "/api/oauth/authorize",
            Some(web),
            json!({"response_type": "code", "client_id": client_id, "redirect_uri": REDIRECT, "code_challenge": challenge, "code_challenge_method": "S256", "scope": scope, "approve": true}),
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
    r.json["access_token"].as_str().unwrap().to_string()
}

async fn mcp(app: &TestApp, token: &str, body: Value) -> common::Resp {
    let req = Request::builder()
        .method(Method::POST)
        .uri("/mcp")
        .header(header::HOST, "telepy.test")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-06-18")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(body.to_string()))
        .unwrap();
    app.send(req).await
}

fn tools_list() -> Value {
    json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
}

/// 通知 socket，認證完成（ping → pong）才回。/ A notifications socket, returned once authenticated.
async fn notifications(lab: &Lab, token: &str) -> Ws {
    let base = lab.ws_base().await;
    let (mut ws, _) = connect_async(format!("{base}/ws/notifications/")).await.unwrap();
    ws.send(Message::Text(json!({"type": "auth", "token": token}).to_string().into())).await.unwrap();
    ws.send(Message::Text(json!({"type": "ping"}).to_string().into())).await.unwrap();
    loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("no pong").unwrap().unwrap() {
            Message::Text(t) if t.contains("pong") => return ws,
            Message::Close(f) => panic!("notifications refused: {f:?}"),
            _ => {}
        }
    }
}

#[tokio::test]
async fn disabling_an_account_signs_it_out_and_ends_everything_it_holds() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service, &bob.key])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    let id = dev.tunnel_id;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;

    // bob 的網頁登入（真的 session）、開著的通知 socket、個人 API token、一個 MCP app（開著一個 agent SSH session）。
    // bob's web sign-in (a real session), an open notifications socket, an API token, an MCP app with an agent session.
    let issued = telepy_server::auth::sessions::issue(&app.state, bob.id, &Default::default(), "password", None).await.unwrap();
    let (web, refresh) = (issued["access_token"].as_str().unwrap().to_string(), issued["refresh_token"].as_str().unwrap().to_string());
    let mut notes = notifications(&lab, &web).await;
    let expires = (chrono::Utc::now() + chrono::Duration::days(30)).to_rfc3339();
    let r = app.post("/api/auth/tokens", Some(&web), json!({"name": "ci", "scopes": ["tunnels:read"], "expires_at": expires})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let pat = r.json["secret"].as_str().unwrap().to_string();
    assert_eq!(app.get("/api/auth/user/profile", Some(&pat)).await.status, StatusCode::OK);
    let agent = oauth_token(app, &web, "tunnels:read ssh:exec").await;
    let r = mcp(app, &agent, json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "ssh_session_open", "arguments": {"tunnel_id": id, "username": "ubuntu"}}})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(!r.json["result"]["isError"].as_bool().unwrap_or(false), "{}", r.text);
    assert_eq!(app.state.ai.list().iter().filter(|s| s.user_id == bob.id).count(), 1);

    // 一個網頁終端機與一個檔案管理（不綁網頁登入的 token，所以是存取檢查結束它們，不是登出）。
    // A web terminal and a file manager (tokens without a sign-in session, so the access check ends them, not the sign-out).
    let mut term = lab.terminal(&bob, &dev, "ubuntu").await.expect("terminal");
    term.expect("login:ubuntu@box").await;
    let mut fm = file_manager(&lab, &bob, &dev, "ubuntu").await;

    // 停用前的預估。/ The preview before disabling.
    let preview = app.get(&format!("/api/user/users/{}/disable-preview", bob.id), Some(&lab.admin_token)).await;
    assert_eq!(preview.status, StatusCode::OK, "{}", preview.text);
    let expect = json!({"web_sessions": 1, "live_sessions": 2, "agent_sessions": 1, "api_tokens": 1, "connected_apps": 1});
    assert_eq!(preview.json, expect);
    assert_eq!(app.get(&format!("/api/user/users/{}/disable-preview", bob.id), Some(&alice.token)).await.status, StatusCode::FORBIDDEN, "admins only");

    // 停用：回應說做了什麼。/ Disable: the response reports what was done.
    let r = app.post(&format!("/api/user/users/{}", bob.id), Some(&lab.admin_token), json!({"is_active": false})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["is_active"], false);
    assert_eq!(r.json["disabled"], expect);

    // 網頁：通知 socket 4010（原因 disabled）、access token 立刻 401、refresh 被拒（也說 disabled）。
    // Web: the socket closes 4010 (disabled), the access token is refused at once, so is the refresh token.
    assert_eq!(closed(&mut notes).await, (4010, "disabled".to_string()));
    let r = app.get("/api/auth/user/profile", Some(&web)).await;
    assert_eq!((r.status, r.json["signed_out"].as_str()), (StatusCode::UNAUTHORIZED, Some("disabled")), "{}", r.text);
    let r = app.post("/api/auth/token/refresh", None, json!({"refresh": refresh})).await;
    assert_eq!((r.status, r.json["signed_out"].as_str()), (StatusCode::UNAUTHORIZED, Some("disabled")), "{}", r.text);
    // 進行中的 session：終端機與檔案 4009，agent session 關掉。/ Live sessions: 4009 for both, the agent session closed.
    assert_eq!(term.wait_closed_reason().await, Some((4009, ENDED_BY.to_string())));
    assert_eq!(closed(&mut fm).await, (4009, ENDED_BY.to_string()));
    wait_presence(&lab, id, "empty", |p| p.iter().all(|e| e.user_id != bob.id)).await;
    assert!(app.state.ai.list().iter().all(|s| s.user_id != bob.id));
    wait_event(&lab, &alice.token, id, "terminal_close", "the account was disabled").await;
    wait_event(&lab, &alice.token, id, "files_close", "the account was disabled").await;
    // token 與 app：拒絕，但還在清單上。/ Token and app: refused, but still listed.
    assert_eq!(app.get("/api/auth/user/profile", Some(&pat)).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(mcp(app, &agent, tools_list()).await.status, StatusCode::UNAUTHORIZED);
    // 筆電經 gateway 的 ssh：停用的帳號的金鑰被拒。/ Laptop SSH: a disabled account's key is refused.
    let run = lab.laptop_exec(&bob, &[(Hop::Tunnel(&dev), "ubuntu")], "whoami").await;
    assert!(!run.ok && !run.stdout.contains("ubuntu"), "a disabled account must not reach the device: {run:?}");

    // 重新啟用：token 與 app 回來，網頁登入不會（要重新登入）。/ Re-enable: tokens and apps are back, web sign-ins are not.
    let r = app.post(&format!("/api/user/users/{}", bob.id), Some(&lab.admin_token), json!({"is_active": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(r.json.get("disabled").is_none(), "{}", r.text);
    assert_eq!(app.get("/api/auth/user/profile", Some(&pat)).await.status, StatusCode::OK);
    assert_eq!(mcp(app, &agent, tools_list()).await.status, StatusCode::OK);
    assert_eq!(app.get("/api/auth/user/profile", Some(&web)).await.status, StatusCode::UNAUTHORIZED, "the sign-in stays revoked");
    assert_eq!(app.post("/api/auth/token/refresh", None, json!({"refresh": refresh})).await.status, StatusCode::UNAUTHORIZED);
    let run = lab.laptop_exec(&bob, &[(Hop::Tunnel(&dev), "ubuntu")], "whoami").await;
    assert!(run.ok && run.stdout.contains("ubuntu"), "laptop SSH works again: {run:?}");
}
