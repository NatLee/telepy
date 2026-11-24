//! 裝置代理（`/ws/proxy/`、`/api/proxy/*`）在 SSH lab 上的端到端測試：真的閘道、真的裝置 sshd，經裝置連到這台機器上
//! 的一個 TCP 服務。/ The device proxy end to end on the SSH lab: the real gateway, a real device sshd, and a TCP service
//! on this machine reached through the device.

mod common;

use std::time::Duration;

use axum::http::StatusCode;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use common::lab::{free_port, Lab};
use common::TestApp;

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

fn in_days(n: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::days(n)).to_rfc3339()
}

async fn token(app: &TestApp, web: &str, body: Value) -> (String, i64) {
    let r = app.post("/api/auth/tokens", Some(web), body).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    (r.json["secret"].as_str().unwrap().to_string(), r.json["token"]["id"].as_i64().unwrap())
}

/// 把收到的位元組轉成大寫回去的 TCP 服務（裝置的 sshd 會連到它）。/ A TCP service answering in upper case (the device's sshd connects to it).
async fn shout_server() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                while let Ok(n) = s.read(&mut buf).await {
                    if n == 0 || s.write_all(&buf[..n].to_ascii_uppercase()).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    port
}

/// 撥 `/ws/proxy/`：成功回 WebSocket，被拒回（狀態、`{error, code}`）。/ Dial `/ws/proxy/`: the socket, or (status, body) when refused.
async fn dial(base: &str, bearer: Option<&str>, query: &str) -> Result<Ws, (StatusCode, Value)> {
    let mut req = format!("{base}/ws/proxy/?{query}").into_client_request().unwrap();
    if let Some(t) = bearer {
        req.headers_mut().insert("authorization", format!("Bearer {t}").parse().unwrap());
    }
    match connect_async(req).await {
        Ok((ws, _)) => Ok(ws),
        Err(WsError::Http(resp)) => {
            let status = StatusCode::from_u16(resp.status().as_u16()).unwrap();
            let body = resp.body().as_ref().and_then(|b| serde_json::from_slice(b).ok()).unwrap_or(Value::Null);
            Err((status, body))
        }
        Err(e) => panic!("websocket: {e}"),
    }
}

async fn refused(base: &str, bearer: Option<&str>, query: &str) -> (StatusCode, String) {
    match dial(base, bearer, query).await {
        Ok(_) => panic!("{query} should have been refused"),
        Err((status, body)) => (status, body["code"].as_str().unwrap_or("").to_string()),
    }
}

/// 送一段、等回來的那一段。/ Send some bytes and wait for the answer.
async fn say(ws: &mut Ws, text: &str) -> String {
    ws.send(Message::Binary(text.as_bytes().to_vec().into())).await.unwrap();
    loop {
        match tokio::time::timeout(Duration::from_secs(10), ws.next()).await.expect("an answer in 10 s") {
            Some(Ok(Message::Binary(b))) => return String::from_utf8_lossy(&b).into_owned(),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            other => panic!("unexpected frame: {other:?}"),
        }
    }
}

/// 這條 WebSocket 在幾秒內被關掉了嗎。/ Whether the socket gets closed within a few seconds.
async fn ends(ws: &mut Ws) -> bool {
    let wait = async {
        loop {
            match ws.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                _ => {}
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(8), wait).await.is_ok()
}

async fn events(app: &TestApp, tunnel: i64, kind: &str) -> Vec<String> {
    sqlx::query_scalar::<_, String>("SELECT message FROM telepy_gateway_event WHERE tunnel_id = ? AND event = ? ORDER BY id").bind(tunnel).bind(kind).fetch_all(&app.state.db.read).await.unwrap()
}

#[tokio::test]
async fn a_token_proxies_through_a_device_only_while_everything_allows_it() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let base = lab.ws_base().await;
    let alice = lab.user("alice").await;
    let mallory = lab.user("mallory").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], true).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let other = lab.machine("spare", &[("ubuntu", &[&lab.service])], true).await;
    let spare = lab.device(&alice, "spare", &other).await;
    lab.username(&alice, &spare, "ubuntu").await;
    let id = dev.tunnel_id;
    let shout = shout_server().await;
    let closed = free_port();

    let (tok, tok_id) = token(app, &alice.token, json!({"name": "ci", "scopes": ["proxy:use"], "expires_at": in_days(3)})).await;
    let (no_scope, _) = token(app, &alice.token, json!({"name": "reader", "scopes": ["tunnels:read"], "expires_at": in_days(3)})).await;
    let (elsewhere, _) = token(app, &alice.token, json!({"name": "spare only", "scopes": ["proxy:use"], "tunnel_ids": [spare.tunnel_id], "expires_at": in_days(3)})).await;
    let (stranger, _) = token(app, &mallory.token, json!({"name": "m", "scopes": ["proxy:use"], "expires_at": in_days(3)})).await;
    let q = |port: u16| format!("tunnel=box&host=127.0.0.1&port={port}");

    // 1) 預設關閉：token 連不了、列不了；網頁看得到「沒開」。/ Off by default: a token can neither connect nor list; the web sees "off".
    assert_eq!(refused(&base, Some(&tok), &q(shout)).await, (StatusCode::FORBIDDEN, "proxy_disabled".into()));
    assert_eq!(app.get("/api/proxy/tunnels", Some(&tok)).await.json["code"], "proxy_disabled");
    let r = app.get("/api/proxy/tunnels", Some(&alice.token)).await;
    assert_eq!((r.status, r.json["enabled"].as_bool()), (StatusCode::OK, Some(false)), "{}", r.text);
    let r = app.post("/api/site/settings", Some(&lab.admin_token), json!({"proxy_enabled": true})).await;
    assert_eq!(r.json["values"]["proxy_enabled"], true, "{}", r.text);

    // 2) 每一道門。/ Every gate.
    assert_eq!(refused(&base, None, &q(shout)).await, (StatusCode::UNAUTHORIZED, "token_required".into()));
    assert_eq!(refused(&base, Some("tpt_nonsense"), &q(shout)).await, (StatusCode::UNAUTHORIZED, "token_invalid".into()));
    assert_eq!(refused(&base, Some(&alice.token), &q(shout)).await.0, StatusCode::UNAUTHORIZED, "a web sign-in token is not a proxy credential");
    assert_eq!(refused(&base, Some(&no_scope), &q(shout)).await, (StatusCode::FORBIDDEN, "token_scope".into()));
    assert_eq!(refused(&base, Some(&stranger), &q(shout)).await, (StatusCode::NOT_FOUND, "tunnel_not_found".into()));
    assert_eq!(refused(&base, Some(&elsewhere), &q(shout)).await, (StatusCode::NOT_FOUND, "tunnel_not_found".into()), "outside the token's tunnels");
    assert_eq!(refused(&base, Some(&tok), &format!("tunnel=nope&host=127.0.0.1&port={shout}")).await, (StatusCode::NOT_FOUND, "tunnel_not_found".into()));
    assert_eq!(refused(&base, Some(&tok), "tunnel=box&host=127.0.0.1").await, (StatusCode::BAD_REQUEST, "bad_request".into()));
    assert_eq!(refused(&base, Some(&tok), &format!("tunnel=box&host=-oProxyCommand%3Dx&port={shout}")).await, (StatusCode::BAD_REQUEST, "bad_target".into()));
    assert_eq!(refused(&base, Some(&tok), &format!("{}&account=root", q(shout))).await, (StatusCode::BAD_REQUEST, "username".into()));
    assert_eq!(refused(&base, Some(&tok), &q(closed)).await, (StatusCode::BAD_GATEWAY, "connect_failed".into()), "the device could not connect");

    // 3) 通了：位元組經裝置的 sshd 到服務再回來；用名稱或 id 都行。/ Through: bytes go via the device's sshd and back; by name or id.
    let mut ws = dial(&base, Some(&tok), &q(shout)).await.expect("the proxy connection");
    assert_eq!(say(&mut ws, "hello through the device").await, "HELLO THROUGH THE DEVICE");
    let mut by_id = dial(&base, Some(&tok), &format!("tunnel={id}&host=localhost&port={shout}&account=ubuntu")).await.expect("by id");
    assert_eq!(say(&mut by_id, "again").await, "AGAIN");
    assert!(boxm.logged_in("ubuntu", &lab.service), "Telepy logged in to the device as the chosen account");

    // 4) 兩條連線是同一個 session；清單與通道列表。/ Both connections are one session; the lists.
    let r = app.get("/api/proxy/sessions", Some(&tok)).await;
    let list = r.json.as_array().unwrap();
    assert_eq!(list.len(), 1, "{}", r.text);
    let s = &list[0];
    assert_eq!((s["connections"].as_u64(), s["connections_total"].as_u64(), s["username"].as_str(), s["kind"].as_str(), s["client_name"].as_str()), (Some(2), Some(2), Some("ubuntu"), Some("token"), Some("API token \"ci\"")), "{s}");
    assert_eq!(s["targets"], json!([format!("127.0.0.1:{shout}"), format!("localhost:{shout}")]));
    let sid = s["id"].as_str().unwrap().to_string();
    assert_eq!(app.get("/api/proxy/sessions", Some(&alice.token)).await.json.as_array().unwrap().len(), 1, "the owner sees it on the web");
    assert_eq!(app.get("/api/proxy/sessions", Some(&mallory.token)).await.json, json!([]));
    assert_eq!(app.get("/api/proxy/sessions", Some(&elsewhere)).await.json, json!([]), "another credential of the same person doesn't");
    assert_eq!(app.get("/api/proxy/sessions?scope=all", Some(&alice.token)).await.json["code"], "admin_only");
    let r = app.get("/api/proxy/tunnels", Some(&tok)).await;
    let names: Vec<&str> = r.json["tunnels"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["box", "spare"], "{}", r.text);
    assert_eq!((r.json["tunnels"][0]["accounts"].clone(), r.json["tunnels"][0]["default_account"].as_str(), r.json["tunnels"][0]["blocked"].clone()), (json!(["ubuntu"]), Some("ubuntu"), Value::Null));
    assert!(r.json["endpoints"]["websocket"].as_str().unwrap().ends_with("/ws/proxy/"), "{}", r.text);
    let only: Vec<i64> = app.get("/api/proxy/tunnels", Some(&elsewhere)).await.json["tunnels"].as_array().unwrap().iter().map(|t| t["id"].as_i64().unwrap()).collect();
    assert_eq!(only, [spare.tunnel_id], "an app or token lists only the tunnels it was given");
    assert_eq!(events(app, id, "proxy_open").await.len(), 1);

    // 5) 上限：同時最多 2 條。/ The limit: two at once.
    let r = app.post("/api/site/settings", Some(&lab.admin_token), json!({"proxy_max_connections": 2})).await;
    assert_eq!(r.json["values"]["proxy_max_connections"], 2, "{}", r.text);
    assert_eq!(refused(&base, Some(&tok), &q(shout)).await, (StatusCode::TOO_MANY_REQUESTS, "proxy_busy".into()));
    drop(by_id);
    let mut third = None;
    for _ in 0..40 {
        if let Ok(ws) = dial(&base, Some(&tok), &q(shout)).await {
            third = Some(ws);
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let mut third = third.expect("a slot frees up once a connection closes");
    assert_eq!(say(&mut third, "third").await, "THIRD");

    // 6) 別人不能結束它；擁有者從網頁結束 → 連線全部被切，事件寫下去了哪裡。/ A stranger can't end it; the owner can → every connection is cut and the event says where it went.
    assert_eq!(app.delete(&format!("/api/proxy/sessions/{sid}"), Some(&mallory.token)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.delete(&format!("/api/proxy/sessions/{sid}"), Some(&alice.token)).await.status, StatusCode::OK);
    assert!(ends(&mut ws).await && ends(&mut third).await, "ending the session cuts its connections");
    assert_eq!(app.get("/api/proxy/sessions", Some(&tok)).await.json, json!([]));
    let closes = events(app, id, "proxy_close").await;
    assert_eq!(closes.len(), 1, "{closes:?}");
    assert!(closes[0].contains("ended by its owner") && closes[0].contains("3 connection(s)") && closes[0].contains(&format!("127.0.0.1:{shout}")), "{}", closes[0]);

    // 7) 撤銷 token：下一輪檢查就切斷，之後也連不上。/ Revoking the token: the next check cuts it, and nothing connects afterwards.
    let mut ws = dial(&base, Some(&tok), &q(shout)).await.expect("a new session");
    assert_eq!(say(&mut ws, "before").await, "BEFORE");
    assert!(app.delete(&format!("/api/auth/tokens/{tok_id}"), Some(&alice.token)).await.status.is_success());
    assert_eq!(telepy_server::proxy::reap_once(&app.state).await, 1);
    assert!(ends(&mut ws).await);
    assert_eq!(refused(&base, Some(&tok), &q(shout)).await.0, StatusCode::UNAUTHORIZED);
    assert!(events(app, id, "proxy_close").await.last().unwrap().contains("revoked"));

    // 8) 需要二次驗證的通道不給代理；管理員關掉總開關 → 開著的全部切斷。/ A step-up tunnel is refused; turning the switch off cuts what is open.
    let (tok2, _) = token(app, &alice.token, json!({"name": "ci2", "scopes": ["proxy:use"], "expires_at": in_days(3)})).await;
    let mut ws = dial(&base, Some(&tok2), &format!("tunnel=spare&host=127.0.0.1&port={shout}")).await.expect("the spare tunnel");
    assert_eq!(say(&mut ws, "spare").await, "SPARE");
    let r = app.post("/api/site/settings", Some(&lab.admin_token), json!({"proxy_enabled": false})).await;
    assert_eq!(r.json["values"]["proxy_enabled"], false, "{}", r.text);
    assert_eq!(telepy_server::proxy::reap_once(&app.state).await, 1);
    assert!(ends(&mut ws).await);
    assert!(events(app, spare.tunnel_id, "proxy_close").await[0].contains("turned off"));
}

/// 一個回「收到的請求第一行」的 HTTP 服務。/ An HTTP service answering with the request line it received.
async fn echo_line_server() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let n = s.read(&mut buf).await.unwrap_or(0);
                let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                let body = format!("got [{}] proxy-header={}", text.lines().next().unwrap_or_default(), text.to_ascii_lowercase().contains("proxy-authorization"));
                let _ = s.write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
            });
        }
    });
    port
}

/// 對代理入口送一段、讀到對方關閉。/ Send to the proxy endpoint and read until it closes.
async fn through(proxy: u16, request: String) -> String {
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", proxy)).await.unwrap();
    s.write_all(request.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(15), s.read_to_end(&mut out)).await;
    String::from_utf8_lossy(&out).into_owned()
}

/// 標準的 HTTP 代理入口：通道寫在帳號、token 寫在密碼；之後跟 `/ws/proxy/` 是同一套檢查與同一個 session。
/// The standard HTTP proxy endpoint: the tunnel as the user, the token as the password; from there the same checks and
/// the same session as `/ws/proxy/`.
#[tokio::test]
async fn a_standard_proxy_client_gets_through_with_the_tunnel_as_user_and_a_token_as_password() {
    use base64::Engine;
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], true).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let web = echo_line_server().await;
    let closed = free_port();
    let r = app.post("/api/site/settings", Some(&lab.admin_token), json!({"proxy_enabled": true})).await;
    assert!(r.status.is_success(), "{}", r.text);
    let (tok, _) = token(app, &alice.token, json!({"name": "curl", "scopes": ["proxy:use"], "expires_at": in_days(3)})).await;
    let (no_scope, _) = token(app, &alice.token, json!({"name": "reader", "scopes": ["tunnels:read"], "expires_at": in_days(3)})).await;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = listener.local_addr().unwrap().port();
    tokio::spawn(telepy_server::proxy::listener::accept_loop(app.state.clone(), listener, None));
    let basic = |user: &str, pass: &str| format!("Proxy-Authorization: Basic {}\r\n", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}")));
    let get = |auth: String, port: u16| format!("GET http://127.0.0.1:{port}/status?x=1 HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}Proxy-Connection: keep-alive\r\n\r\n");

    // 沒帶帳密 / token 不對 = 407，請客戶端帶帳密。/ No credentials or a wrong token = 407 asking for them.
    let r = through(proxy, get(String::new(), web)).await;
    assert!(r.starts_with("HTTP/1.1 407 ") && r.contains("Proxy-Authenticate: Basic realm=") && r.contains("token_required"), "{r}");
    let r = through(proxy, get(basic("box", "tpt_nonsense"), web)).await;
    assert!(r.starts_with("HTTP/1.1 407 ") && r.contains("token_invalid"), "{r}");
    // 其他的拒絕跟 /ws/proxy/ 一樣。/ Other refusals are the same as /ws/proxy/.
    assert!(through(proxy, get(basic("box", &no_scope), web)).await.starts_with("HTTP/1.1 403 "));
    let r = through(proxy, get(basic("nope", &tok), web)).await;
    assert!(r.starts_with("HTTP/1.1 404 ") && r.contains("tunnel_not_found"), "{r}");
    let r = through(proxy, get(basic("box", &tok), closed)).await;
    assert!(r.starts_with("HTTP/1.1 502 ") && r.contains("connect_failed"), "{r}");
    assert!(through(proxy, "GET /not-a-proxy-request HTTP/1.1\r\n\r\n".to_string()).await.starts_with("HTTP/1.1 400 "));

    // 一般 HTTP：改成 origin-form，我們的 Proxy-Authorization 不會流到目標。/ Plain HTTP: origin-form, and our Proxy-Authorization never reaches the target.
    let r = through(proxy, get(basic("box", &tok), web)).await;
    assert!(r.starts_with("HTTP/1.1 200 OK") && r.ends_with("got [GET /status?x=1 HTTP/1.1] proxy-header=false"), "{r}");
    // 通道@裝置帳號、用 id、Bearer + Telepy-Tunnel 都行。/ tunnel@account, an id, and Bearer + Telepy-Tunnel all work.
    assert!(through(proxy, get(basic("box@ubuntu", &tok), web)).await.starts_with("HTTP/1.1 200 OK"));
    assert!(through(proxy, get(basic(&dev.tunnel_id.to_string(), &tok), web)).await.starts_with("HTTP/1.1 200 OK"));
    assert!(through(proxy, get(format!("Proxy-Authorization: Bearer {tok}\r\nTelepy-Tunnel: box\r\n"), web)).await.starts_with("HTTP/1.1 200 OK"));
    let r = through(proxy, get(basic("box@root", &tok), web)).await;
    assert!(r.starts_with("HTTP/1.1 400 ") && r.contains("username"), "{r}");

    // CONNECT：先回 200，之後原樣轉接。/ CONNECT: a 200 first, then bytes as they are.
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", proxy)).await.unwrap();
    s.write_all(format!("CONNECT 127.0.0.1:{web} HTTP/1.1\r\nHost: 127.0.0.1:{web}\r\n{}\r\n", basic("box", &tok)).as_bytes()).await.unwrap();
    let mut head = [0u8; 39];
    tokio::time::timeout(Duration::from_secs(15), s.read_exact(&mut head)).await.expect("the CONNECT answer").unwrap();
    assert_eq!(&head[..], b"HTTP/1.1 200 Connection established\r\n\r\n");
    s.write_all(b"GET /through-connect HTTP/1.1\r\nconnection: close\r\n\r\n").await.unwrap();
    let mut out = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(15), s.read_to_end(&mut out)).await;
    assert!(String::from_utf8_lossy(&out).ends_with("got [GET /through-connect HTTP/1.1] proxy-header=false"), "{}", String::from_utf8_lossy(&out));

    // 同一把 token、同一條通道：跟 WebSocket 那條路是同一個 session。/ Same token, same tunnel: one session with the WebSocket way.
    let base = lab.ws_base().await;
    let mut ws = dial(&base, Some(&tok), &format!("tunnel=box&host=127.0.0.1&port={}", shout_server().await)).await.expect("the websocket way");
    assert_eq!(say(&mut ws, "both ways").await, "BOTH WAYS");
    let list = app.get("/api/proxy/sessions", Some(&tok)).await.json;
    assert_eq!(list.as_array().unwrap().len(), 1, "{list}");
    assert!(list[0]["connections_total"].as_u64().unwrap() >= 6, "{list}");
    assert!(boxm.logged_in("ubuntu", &lab.service));
}
