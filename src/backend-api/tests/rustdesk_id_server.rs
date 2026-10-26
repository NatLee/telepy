//! Telepy 當 RustDesk 的 ID / 中繼伺服器（不經 SSH）：假的 RustDesk 裝置用 WebSocket 講 RustDesk 的 rendezvous 協定
//! （和 RustDesk 1.5.0 實測的訊息一樣），走一遍登記、註冊、瀏覽器 punch → 推中繼請求 → 兩端中繼以 uuid 配對、
//! 伺服器簽的裝置公鑰、移除、總開關。
//! Telepy as RustDesk's ID and relay server, end to end with a fake device speaking the rendezvous protocol over
//! WebSocket: enrolment, registration, the browser's punch, relay pairing, the signed device key, removal, the switch.

mod common;

use std::net::SocketAddr;
use std::time::Duration;

use axum::http::StatusCode;
use base64::Engine;
use ed25519_dalek::Verifier;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use telepy_server::rustdesk::codec::{self, rendezvous, rendezvous_with_id, FieldValue, PUNCH_HOLE_REQUEST, PUNCH_HOLE_RESPONSE, REGISTER_PK, REGISTER_PK_RESPONSE, RELAY_RESPONSE, REQUEST_RELAY};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// 真的 HTTP listener（WebSocket 要用）。/ A real listener for the WebSockets.
async fn listen(app: &common::TestApp) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = app.router.clone();
    tokio::spawn(async move { axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap() });
    format!("127.0.0.1:{}", addr.port())
}

async fn ws(url: &str) -> Ws {
    connect_async(url).await.unwrap_or_else(|e| panic!("connect {url}: {e}")).0
}

/// 下一則非空的 binary（略過心跳的空訊息與 ping）；Err = 關閉。/ The next non-empty binary message; Err = closed.
async fn recv(ws: &mut Ws) -> Result<Vec<u8>, ()> {
    loop {
        match tokio::time::timeout(Duration::from_secs(15), ws.next()).await.expect("nothing arrived") {
            Some(Ok(Message::Binary(b))) if !b.is_empty() => return Ok(b.to_vec()),
            Some(Ok(Message::Binary(_))) | Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => continue,
            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return Err(()),
            Some(Ok(_)) => continue,
        }
    }
}

async fn send(ws: &mut Ws, msg: Vec<u8>) {
    ws.send(Message::Binary(msg.into())).await.unwrap();
}

/// RustDesk 裝置送的 `RegisterPk`。/ The device's key registration.
fn register_pk(id: &str, uuid: &[u8], pk: &[u8]) -> Vec<u8> {
    fn field(num: u32, data: &[u8], out: &mut Vec<u8>) {
        out.push(((num << 3) | 2) as u8);
        out.push(data.len() as u8);
        out.extend_from_slice(data);
    }
    let mut inner = Vec::new();
    field(1, id.as_bytes(), &mut inner);
    field(2, uuid, &mut inner);
    field(3, pk, &mut inner);
    let mut out = Vec::new();
    field(REGISTER_PK, &inner, &mut out);
    out
}

fn register_result(msg: &[u8]) -> u64 {
    let (num, fs) = rendezvous(msg).expect("a rendezvous message");
    assert_eq!(num, REGISTER_PK_RESPONSE);
    fs.iter().find_map(|(n, v)| match v { FieldValue::Varint(r) if *n == 1 => Some(*r), _ => None }).unwrap_or(0)
}

fn bytes_of(fs: &[(u32, FieldValue<'_>)], num: u32) -> Vec<u8> {
    fs.iter().find_map(|(n, v)| match v { FieldValue::Bytes(b) if *n == num => Some(b.to_vec()), _ => None }).unwrap_or_default()
}

struct FakeDevice {
    id: String,
    uuid: Vec<u8>,
    pk: Vec<u8>,
}

impl FakeDevice {
    fn new(id: &str) -> Self {
        Self { id: id.into(), uuid: format!("uuid-of-{id}").into_bytes(), pk: [id.as_bytes()[0]; 32].to_vec() }
    }
    fn deploy_body(&self) -> Value {
        json!({ "id": self.id, "pk": B64.encode(&self.pk), "uuid": B64.encode(&self.uuid) })
    }
    async fn register(&self, sock: &mut Ws) -> u64 {
        send(sock, register_pk(&self.id, &self.uuid, &self.pk)).await;
        register_result(&recv(sock).await.expect("a register response"))
    }
}

/// `rustdesk --deploy` 會看到的回應：`result` 或一行純文字。/ What `rustdesk --deploy` sees: a `result` or plain text.
async fn deploy(app: &common::TestApp, token: &str, body: Value) -> String {
    let req = axum::http::Request::post("/api/devices/deploy")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap();
    let r = app.send(req).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    r.json["result"].as_str().map(str::to_string).unwrap_or(r.text)
}

#[tokio::test]
async fn rustdesk_devices_enrol_register_and_relay_without_ssh() {
    let app = common::spawn().await;
    let (admin, bob) = app.admin_and_user("alice", "bob").await;
    let host = listen(&app).await;
    let dev = FakeDevice::new("113668456");

    // 沒登記：裝置連得上，但註冊被回 NOT_DEPLOYED（它會停著等 --deploy）。/ Not enrolled yet: NOT_DEPLOYED.
    let mut reg = ws(&format!("ws://{host}/ws/id")).await;
    assert_eq!(dev.register(&mut reg).await, codec::register_result::NOT_DEPLOYED);

    // 登記指令。/ The enrolment command.
    let r = app.post("/api/rustdesk/enroll", Some(&bob), json!({"name": "Office PC"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let token = r.json["token"].as_str().unwrap().to_string();
    let enroll_id = r.json["id"].as_str().unwrap().to_string();
    assert!(token.starts_with("tpr_"));
    assert_eq!(r.json["phase"], "waiting");
    for os in ["linux", "macos", "windows"] {
        let c = r.json["commands"][os].as_str().unwrap();
        assert!(c.contains(&format!("--deploy --token {token}")), "{os}: {c}");
        assert!(c.contains("allow-websocket Y"), "{os}: {c}");
    }
    assert!(r.json["server"]["key"].as_str().unwrap().len() > 40);

    assert!(deploy(&app, "tpr_wrong", dev.deploy_body()).await.contains("not valid any more"), "a wrong token is one printable line");
    assert_eq!(deploy(&app, &token, json!({"id": "x", "pk": "", "uuid": ""})).await, "INVALID_INPUT");
    assert_eq!(deploy(&app, &token, dev.deploy_body()).await, "OK");
    assert!(deploy(&app, &token, FakeDevice::new("222333444").deploy_body()).await.contains("already used"));
    let r = app.get(&format!("/api/rustdesk/enroll/{enroll_id}"), Some(&bob)).await;
    assert_eq!(r.json["phase"], "enrolled");

    // 同一條連線再註冊一次 → OK，裝置在線。/ The device retries on the same socket and is accepted.
    assert_eq!(dev.register(&mut reg).await, codec::register_result::OK);
    let r = app.get(&format!("/api/rustdesk/enroll/{enroll_id}"), Some(&bob)).await;
    assert_eq!(r.json["phase"], "online");
    let r = app.get("/api/rustdesk/devices", Some(&bob)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let d = &r.json["devices"][0];
    assert_eq!(d["name"], "Office PC");
    assert_eq!(d["rustdesk_id"], "113668456");
    assert_eq!(d["online"], true);
    assert_eq!(d["mine"], true);
    let device_id = d["id"].as_i64().unwrap();
    let r = app.get("/api/rustdesk/devices", Some(&admin)).await;
    assert_eq!(r.json["devices"][0]["owner"]["username"], "bob", "admins see everyone's devices");
    assert_eq!(r.json["devices"][0]["mine"], false);

    // 裝置自己回報的系統資訊（uuid 要對）。/ The device's sysinfo (uuid must match).
    let r = app.post("/api/sysinfo", None, json!({"id": dev.id, "uuid": B64.encode(&dev.uuid), "hostname": "office-pc", "os": "debian / Linux 12", "version": "1.5.0"})).await;
    assert_eq!(r.text, "SYSINFO_UPDATED");
    let r = app.post("/api/sysinfo", None, json!({"id": dev.id, "uuid": "c3Bvb2Y=", "hostname": "evil"})).await;
    assert_eq!(r.text, "ID_NOT_FOUND");
    let r = app.get("/api/rustdesk/devices", Some(&bob)).await;
    assert_eq!(r.json["devices"][0]["hostname"], "office-pc");
    assert_eq!(r.json["devices"][0]["name"], "Office PC", "a given name is kept");
    let r = app.post("/api/audit/conn", None, json!({"action": "new"})).await;
    assert_eq!((r.status, r.text.as_str()), (StatusCode::OK, ""), "RustDesk retries anything but an empty body");

    // 瀏覽器 session。/ A browser session.
    let r = app.post(&format!("/api/rustdesk/devices/{device_id}/start"), Some(&bob), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let start = r.json.clone();
    assert_eq!(start["peer_id"], "113668456");
    let url = format!("ws://{host}{}?ticket={}", start["ws_path"].as_str().unwrap(), start["ticket"].as_str().unwrap());
    let key = ed25519_dalek::VerifyingKey::from_bytes(&B64.decode(start["key"].as_str().unwrap()).unwrap().try_into().unwrap()).unwrap();

    let mut browser_id = ws(&url).await;
    send(&mut browser_id, rendezvous_with_id(PUNCH_HOLE_REQUEST, "113668456")).await;
    // 裝置在註冊連線上收到中繼請求。/ The device gets the relay request on its registration socket.
    let pushed = recv(&mut reg).await.unwrap();
    let (num, fs) = rendezvous(&pushed).unwrap();
    assert_eq!(num, REQUEST_RELAY);
    let uuid = String::from_utf8(bytes_of(&fs, 2)).unwrap();
    let relay_url = String::from_utf8(bytes_of(&fs, 4)).unwrap();
    assert_eq!(relay_url, format!("ws://{host}/ws/relay"), "from the address the device itself used");
    assert!(!bytes_of(&fs, 3).is_empty(), "a socket_addr, or the device drops the request as a duplicate");
    assert!(fs.contains(&(5, FieldValue::Varint(1))), "secure");
    // 瀏覽器收到 relay_response，附伺服器簽的 IdPk{id, 裝置公鑰}。/ The browser gets the signed device key.
    let answer = recv(&mut browser_id).await.unwrap();
    let (num, fs) = rendezvous(&answer).unwrap();
    assert_eq!(num, RELAY_RESPONSE);
    assert_eq!(String::from_utf8(bytes_of(&fs, 2)).unwrap(), uuid);
    let signed = bytes_of(&fs, 5);
    let sig = ed25519_dalek::Signature::from_bytes(signed[..64].try_into().unwrap());
    assert!(key.verify(&signed[64..], &sig).is_ok(), "signed with the key from the start response");
    assert_eq!(&signed[64..], &codec::id_pk("113668456", &dev.pk)[..]);

    // 兩端中繼：裝置先到也行。/ Both relay sides; the device may arrive first.
    let mut device_relay = ws(&relay_url).await;
    send(&mut device_relay, codec::request_relay(&uuid, &[], "", false)).await;
    let mut browser_relay = ws(&url).await;
    send(&mut browser_relay, rendezvous_with_id(REQUEST_RELAY, "113668456")).await;
    send(&mut browser_relay, b"hello device".to_vec()).await;
    assert_eq!(recv(&mut device_relay).await.unwrap(), b"hello device");
    send(&mut device_relay, b"hello browser".to_vec()).await;
    assert_eq!(recv(&mut browser_relay).await.unwrap(), b"hello browser");
    let r = app.get("/api/rustdesk/devices", Some(&bob)).await;
    assert_eq!(r.json["devices"][0]["in_use"], 1);

    // 瀏覽器關掉 → 裝置那條也關。事件寫在 Logs（沒有隧道 = 管理員看得到）。/ Closing one side closes the other.
    browser_relay.close(None).await.unwrap();
    assert!(recv(&mut device_relay).await.is_err());
    tokio::time::sleep(Duration::from_millis(200)).await;
    let ev = app.get("/api/log/ssh/events", Some(&admin)).await;
    let kinds: Vec<String> = ev.json.as_array().unwrap().iter().map(|e| e["event"].as_str().unwrap_or("").to_string()).collect();
    for k in ["rustdesk_enrolled", "rustdesk_open", "rustdesk_close"] {
        assert!(kinds.iter().any(|x| x == k), "{k} in {kinds:?}");
    }
    let open = ev.json.as_array().unwrap().iter().find(|e| e["event"] == "rustdesk_open").unwrap();
    assert!(open["message"].as_str().unwrap().contains("Office PC (113668456) through Telepy's RustDesk server"), "{open}");

    // 原生 app 想經 Telepy 連：拒絕。/ A native app's punch through Telepy is refused.
    let mut native = ws(&format!("ws://{host}/ws/id")).await;
    send(&mut native, rendezvous_with_id(PUNCH_HOLE_REQUEST, "113668456")).await;
    assert_eq!(rendezvous(&recv(&mut native).await.unwrap()).unwrap().0, PUNCH_HOLE_RESPONSE);

    // 別人看不到也用不了。/ Someone else can neither see nor use it.
    let carol = app.login("carol", "pw").await;
    assert_eq!(app.get("/api/rustdesk/devices", Some(&carol)).await.json["devices"], json!([]));
    assert_eq!(app.post(&format!("/api/rustdesk/devices/{device_id}/start"), Some(&carol), json!({})).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.delete(&format!("/api/rustdesk/devices/{device_id}"), Some(&carol)).await.status, StatusCode::NOT_FOUND);

    // 另一台登記了但沒連上：start = 502 device_offline。/ Enrolled but not connected.
    let r = app.post("/api/rustdesk/enroll", Some(&bob), json!({})).await;
    let other = FakeDevice::new("777000111");
    assert_eq!(deploy(&app, r.json["token"].as_str().unwrap(), other.deploy_body()).await, "OK");
    let other_id = app.get("/api/rustdesk/devices", Some(&bob)).await.json["devices"].as_array().unwrap().iter().find(|d| d["rustdesk_id"] == "777000111").unwrap()["id"].as_i64().unwrap();
    let r = app.post(&format!("/api/rustdesk/devices/{other_id}/start"), Some(&bob), json!({})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_GATEWAY, Some("device_offline")));
    // 同一個 RustDesk ID 換了公鑰（重裝）→ 不接受，要重新登記。/ A different key for the same ID needs re-enrolment.
    let mut imposter = ws(&format!("ws://{host}/")).await;
    send(&mut imposter, register_pk("777000111", &other.uuid, &[9u8; 32])).await;
    assert_eq!(register_result(&recv(&mut imposter).await.unwrap()), codec::register_result::NOT_DEPLOYED, "the root path takes registrations too (RustDesk by IP)");

    // 移除：註冊連線被踢掉，之後回 NOT_DEPLOYED。/ Removal kicks the device and refuses it afterwards.
    let r = app.delete(&format!("/api/rustdesk/devices/{device_id}"), Some(&bob)).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
    assert!(recv(&mut reg).await.is_err(), "kicked");
    let mut again = ws(&format!("ws://{host}/ws/id")).await;
    assert_eq!(dev.register(&mut again).await, codec::register_result::NOT_DEPLOYED);

    // 總開關關掉：不能登記、註冊被拒。/ The site switch off: no enrolment, no registration.
    let r = app.post("/api/site/settings", Some(&admin), json!({"desktop_rustdesk_server": false})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = app.post("/api/rustdesk/enroll", Some(&bob), json!({})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("rustdesk_server_disabled")));
    let mut off = ws(&format!("ws://{host}/ws/id")).await;
    assert_eq!(other.register(&mut off).await, codec::register_result::NOT_DEPLOYED);
}

#[tokio::test]
async fn a_rustdesk_id_belongs_to_one_account() {
    let app = common::spawn().await;
    let (admin, bob) = app.admin_and_user("alice", "bob").await;
    let dev = FakeDevice::new("555666777");
    let r = app.post("/api/rustdesk/enroll", Some(&bob), json!({})).await;
    assert_eq!(deploy(&app, r.json["token"].as_str().unwrap(), dev.deploy_body()).await, "OK");
    // 名稱沒給：預設，等裝置回報主機名稱就換成它。/ No name: a default until the device reports its hostname.
    let r = app.get("/api/rustdesk/devices", Some(&bob)).await;
    assert_eq!(r.json["devices"][0]["name"], "RustDesk 555666777");
    app.post("/api/sysinfo", None, json!({"id": dev.id, "uuid": B64.encode(&dev.uuid), "hostname": "kiosk-3", "os": "Windows 11", "version": "1.5.0"})).await;
    let r = app.get("/api/rustdesk/devices", Some(&bob)).await;
    assert_eq!(r.json["devices"][0]["name"], "kiosk-3");
    let id = r.json["devices"][0]["id"].as_i64().unwrap();
    let r = app.patch(&format!("/api/rustdesk/devices/{id}"), Some(&bob), json!({"name": "  "})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = app.patch(&format!("/api/rustdesk/devices/{id}"), Some(&bob), json!({"name": "前台電腦"})).await;
    assert_eq!(r.json["name"], "前台電腦");

    // 別的帳號拿同一個 RustDesk ID 來登記：拒絕（指令也還能再用）。/ Another account cannot take the ID.
    let r = app.post("/api/rustdesk/enroll", Some(&admin), json!({})).await;
    let token = r.json["token"].as_str().unwrap().to_string();
    assert_eq!(deploy(&app, &token, dev.deploy_body()).await, "ID_TAKEN", "RustDesk prints: Id `…` is already used by another machine");
    assert_eq!(deploy(&app, &token, FakeDevice::new("888999000").deploy_body()).await, "OK", "the refused command was released");

    // 同一個擁有者重新登記（重裝 RustDesk、新金鑰）：同一列，換新金鑰。/ The owner re-enrols: same row, new key.
    let r = app.post("/api/rustdesk/enroll", Some(&bob), json!({})).await;
    let mut renewed = FakeDevice::new("555666777");
    renewed.pk = vec![42u8; 32];
    assert_eq!(deploy(&app, r.json["token"].as_str().unwrap(), renewed.deploy_body()).await, "OK");
    let r = app.get("/api/rustdesk/devices", Some(&bob)).await;
    assert_eq!(r.json["devices"].as_array().unwrap().len(), 1);
    assert_eq!(r.json["devices"][0]["id"], id);
}
