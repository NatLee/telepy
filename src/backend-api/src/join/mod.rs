//! 一行指令加入裝置（#14）：網頁發一張短效的 join 票，裝置上跑 `install.sh --token …` 自己產生金鑰、
//! 註冊隧道、授權 Telepy 的服務金鑰、裝好反向隧道服務，再請伺服器驗證一次真的登入。
//! 票只放記憶體（重開機就失效），token 只存 SHA-256；同一張票只能註冊一次，之後在 [`STATUS_TTL`] 內可查進度。
//! One-command device join: a short-lived ticket minted on the web; the device registers itself with it and
//! the server verifies a real login through the new tunnel. Tickets live in memory, tokens are kept hashed.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;

use crate::oauth::{hash_token, random_token};

/// 還沒用的票多久失效。/ How long an unused ticket stays valid.
pub const TICKET_TTL: Duration = Duration::from_secs(30 * 60);
/// 註冊後還能查進度多久。/ How long the progress stays readable after registration.
pub const STATUS_TTL: Duration = Duration::from_secs(30 * 60);
/// 每人同時有效的票上限。/ Open tickets per user.
pub const MAX_OPEN_PER_USER: usize = 10;
/// token 前綴（方便祕密掃描辨識）。/ Token prefix (helps secret scanners).
pub const TOKEN_PREFIX: &str = "tpj_";

/// waiting → registered → connected → verified | failed
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// 等裝置來註冊。/ Waiting for the device.
    Waiting,
    /// 隧道建好了，等裝置連上。/ Tunnel created; waiting for the device to connect.
    Registered,
    /// 連上了，正在驗證登入。/ Connected; verifying a login.
    Connected,
    Verified,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct Ticket {
    /// 公開 id（網頁查進度 / 撤銷用；不是 token）。/ Public id for the owner's UI (not the secret).
    pub id: String,
    #[serde(skip)]
    pub token_hash: String,
    #[serde(skip)]
    pub user_id: i64,
    /// 指定的隧道名稱（沒指定就用裝置的 hostname）。/ Requested tunnel name.
    pub name: Option<String>,
    /// 建立時把我的金鑰放進裝置的金鑰清單。/ Seed the device key list with my keys.
    pub key_list_mine: bool,
    /// 裝置怎麼連 gateway：`ssh`（24242）或 `websocket`（只開網頁 port 的網路）。/ How the device reaches the gateway.
    pub transport: String,
    pub phase: Phase,
    /// 失敗原因或補充說明。/ Failure reason or a note.
    pub detail: Option<String>,
    pub tunnel_id: Option<i64>,
    pub tunnel_name: Option<String>,
    pub reverse_port: Option<i64>,
    /// Telepy 登入裝置用的帳號。/ The device account Telepy logs in to.
    pub username: Option<String>,
    /// 裝置自己的 SSH port（隧道另一端接到這裡）。/ The device's own SSH port.
    pub ssh_port: Option<i64>,
    pub hostname: Option<String>,
    pub os: Option<String>,
    /// 這台機器已經是擁有者的另一條隧道（同一組 SSH host key）。/ The owner's other tunnel on this very machine.
    pub same_machine_as: Option<SameMachine>,
    /// 腳本偵測到的環境（shell、SSH client / server、服務管理器、keepalive 模式…；[`parse_facts`]）。
    /// What the install script found on the device (shell, SSH client / server, init, keepalive mode…).
    pub facts: Option<Value>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    #[serde(skip)]
    pub deadline: Instant,
    /// 驗證中（避免同時跑兩次）。/ A login check is running.
    #[serde(skip)]
    pub verifying: bool,
}

impl Ticket {
    pub fn open(&self) -> bool {
        self.phase == Phase::Waiting
    }
}

/// 註冊時裝置送來的資料（已驗證）。/ What the device sent, validated.
#[derive(Debug, Clone)]
pub struct Registration {
    pub tunnel_id: i64,
    pub tunnel_name: String,
    pub reverse_port: i64,
    pub username: String,
    pub ssh_port: i64,
    pub hostname: String,
    pub os: String,
    pub same_machine_as: Option<SameMachine>,
    pub facts: Option<Value>,
}

/// 同一台機器上、同一個擁有者的另一條隧道。/ The same owner's other tunnel on the same machine.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SameMachine {
    pub id: i64,
    pub name: String,
}

#[derive(Default)]
pub struct JoinTickets {
    inner: Mutex<HashMap<String, Ticket>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TakeError {
    /// 不存在、過期或已撤銷。/ Unknown, expired or revoked.
    Invalid,
    /// 已經用過。/ Already used.
    Used,
}

impl JoinTickets {
    fn sweep(map: &mut HashMap<String, Ticket>) {
        let now = Instant::now();
        map.retain(|_, t| t.deadline > now);
    }

    /// 發一張票；回傳 (token 原文, 票)。超過每人上限回 None。/ Mint a ticket; None when the user has too many open.
    pub fn mint(&self, user_id: i64, name: Option<String>, key_list_mine: bool, transport: &str) -> Option<(String, Ticket)> {
        let mut map = self.inner.lock().unwrap();
        Self::sweep(&mut map);
        if map.values().filter(|t| t.user_id == user_id && t.open()).count() >= MAX_OPEN_PER_USER {
            return None;
        }
        let token = random_token(TOKEN_PREFIX);
        let now = Utc::now();
        let ticket = Ticket {
            id: crate::util::random_alnum(12),
            token_hash: hash_token(&token),
            user_id,
            name,
            key_list_mine,
            transport: transport.to_string(),
            phase: Phase::Waiting,
            detail: None,
            tunnel_id: None,
            tunnel_name: None,
            reverse_port: None,
            username: None,
            ssh_port: None,
            hostname: None,
            os: None,
            same_machine_as: None,
            facts: None,
            created_at: now,
            expires_at: now + chrono::Duration::from_std(TICKET_TTL).unwrap(),
            deadline: Instant::now() + TICKET_TTL,
            verifying: false,
        };
        map.insert(ticket.token_hash.clone(), ticket.clone());
        Some((token, ticket))
    }

    /// 裝置要註冊：把票標成使用中並交回（原子；同一張票只能拿一次）。失敗時呼叫 [`Self::release`] 放回去。
    /// Claim a waiting ticket for registration (atomic, once). Put it back with [`Self::release`] on failure.
    pub fn claim(&self, token: &str) -> Result<Ticket, TakeError> {
        let mut map = self.inner.lock().unwrap();
        Self::sweep(&mut map);
        let t = map.get_mut(&hash_token(token)).ok_or(TakeError::Invalid)?;
        if !t.open() {
            return Err(TakeError::Used);
        }
        t.phase = Phase::Registered;
        Ok(t.clone())
    }

    /// 註冊失敗：票回到等待狀態，裝置可以修正後重試。/ Registration failed: the ticket waits again.
    pub fn release(&self, token_hash: &str) {
        if let Some(t) = self.inner.lock().unwrap().get_mut(token_hash) {
            if t.phase == Phase::Registered && t.tunnel_id.is_none() {
                t.phase = Phase::Waiting;
            }
        }
    }

    /// 註冊成功：記下隧道，期限改成 [`STATUS_TTL`]。/ Registered: remember the tunnel and extend the deadline.
    pub fn registered(&self, token_hash: &str, r: Registration) -> Option<Ticket> {
        let mut map = self.inner.lock().unwrap();
        let t = map.get_mut(token_hash)?;
        t.phase = Phase::Registered;
        t.tunnel_id = Some(r.tunnel_id);
        t.tunnel_name = Some(r.tunnel_name);
        t.reverse_port = Some(r.reverse_port);
        t.username = Some(r.username);
        t.ssh_port = Some(r.ssh_port);
        t.hostname = Some(r.hostname);
        t.os = Some(r.os);
        t.same_machine_as = r.same_machine_as;
        t.facts = r.facts;
        t.deadline = Instant::now() + STATUS_TTL;
        t.expires_at = Utc::now() + chrono::Duration::from_std(STATUS_TTL).unwrap();
        Some(t.clone())
    }

    pub fn by_token(&self, token: &str) -> Option<Ticket> {
        let mut map = self.inner.lock().unwrap();
        Self::sweep(&mut map);
        map.get(&hash_token(token)).cloned()
    }

    pub fn by_id(&self, user_id: i64, id: &str) -> Option<Ticket> {
        let mut map = self.inner.lock().unwrap();
        Self::sweep(&mut map);
        map.values().find(|t| t.id == id && t.user_id == user_id).cloned()
    }

    /// 改階段；回傳更新後的票（階段沒變回 None，避免重複通知）。/ Move to a phase; None when unchanged.
    pub fn set_phase(&self, token_hash: &str, phase: Phase, detail: Option<String>) -> Option<Ticket> {
        let mut map = self.inner.lock().unwrap();
        let t = map.get_mut(token_hash)?;
        if t.phase == phase && t.detail == detail {
            return None;
        }
        t.phase = phase;
        t.detail = detail;
        Some(t.clone())
    }

    /// 開始驗證（已在驗證中回 false）。/ Start verifying; false when one is already running.
    pub fn begin_verify(&self, token_hash: &str) -> bool {
        let mut map = self.inner.lock().unwrap();
        match map.get_mut(token_hash) {
            Some(t) if !t.verifying && matches!(t.phase, Phase::Registered | Phase::Connected) => {
                t.verifying = true;
                true
            }
            _ => false,
        }
    }

    pub fn end_verify(&self, token_hash: &str) {
        if let Some(t) = self.inner.lock().unwrap().get_mut(token_hash) {
            t.verifying = false;
        }
    }

    /// 撤銷還沒用的票。/ Revoke an unused ticket.
    pub fn revoke(&self, user_id: i64, id: &str) -> bool {
        let mut map = self.inner.lock().unwrap();
        let before = map.len();
        map.retain(|_, t| !(t.id == id && t.user_id == user_id && t.open()));
        map.len() != before
    }
}

/// 從主機名稱得到隧道名稱：英數與 `._-`、字母或數字開頭、最多 63 字（建立隧道的規則）。
/// A tunnel name from a hostname: `[A-Za-z0-9._-]`, starting with a letter or digit, ≤ 63 (the create rule).
pub fn tunnel_name_from(raw: &str) -> String {
    // 與網頁建立隧道同一套規則（[`crate::tunnel_name`]）。/ The same rule as creating a tunnel in the web.
    crate::tunnel_name::suggest(raw)
}

/// 名稱撞到就加 `-2`、`-3`…（全站唯一）。/ `name`, then `name-2`, `name-3`… (names are globally unique).
pub fn name_candidates(base: &str) -> impl Iterator<Item = String> + '_ {
    std::iter::once(base.to_string()).chain((2..=99).map(move |i| {
        let suffix = format!("-{i}");
        let keep = crate::tunnel_name::MAX_LEN.saturating_sub(suffix.len());
        format!("{}{suffix}", base.chars().take(keep).collect::<String>())
    }))
}

/// 主機名稱只留安全字元。/ Keep a hostname to safe characters.
pub fn clean_hostname(raw: &str) -> String {
    raw.trim().chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')).take(64).collect()
}

/// 腳本送來的環境資料裡接受的欄位（其他一律丟掉）。/ The fields accepted from the script; anything else is dropped.
pub const FACT_KEYS: &[&str] = &["shell", "os", "arch", "http", "client", "server", "init", "keepalive", "key_format", "authorized_keys", "ssh_host", "transport", "carrier", "compat"];
const FACT_MAX_LEN: usize = 120;

/// 腳本偵測到的環境：只留白名單欄位、可印 ASCII、每值 ≤ 120 字；`compat` 是字串陣列（≤ 8）。空的回 None。
/// Validate what the script found: allow-listed keys, printable ASCII, ≤ 120 chars each; `compat` = up to 8 strings.
pub fn parse_facts(v: Option<&Value>) -> Option<Value> {
    let obj = v?.as_object()?;
    let clean = |s: &str| -> Option<String> {
        let s: String = s.chars().filter(|c| c.is_ascii_graphic() || *c == ' ').take(FACT_MAX_LEN).collect::<String>().trim().to_string();
        (!s.is_empty()).then_some(s)
    };
    let mut out = serde_json::Map::new();
    for k in FACT_KEYS {
        let Some(val) = obj.get(*k) else { continue };
        if *k == "compat" {
            let list: Vec<Value> = val.as_array().map(|a| a.iter().filter_map(Value::as_str).filter_map(clean).take(8).map(Value::String).collect()).unwrap_or_default();
            if !list.is_empty() {
                out.insert(k.to_string(), Value::Array(list));
            }
        } else if let Some(s) = val.as_str().and_then(clean) {
            out.insert(k.to_string(), Value::String(s));
        }
    }
    (!out.is_empty()).then(|| Value::Object(out))
}

/// 事件與日誌用的一句話（例如 `ash, dbclient 2022.82 → Dropbear 2022.82, procd, keepalive tcp (compat: no_server_alive)`）。
/// One line for events and logs.
pub fn facts_summary(f: &Value) -> String {
    let s = |k: &str| f.get(k).and_then(Value::as_str);
    let mut parts: Vec<String> = Vec::new();
    if let Some(v) = s("shell") {
        parts.push(v.to_string());
    }
    match (s("client"), s("server")) {
        (Some(c), Some(sv)) => parts.push(format!("{c} → {sv}")),
        (Some(c), None) => parts.push(c.to_string()),
        (None, Some(sv)) => parts.push(format!("server {sv}")),
        (None, None) => {}
    }
    if let Some(v) = s("init") {
        parts.push(v.to_string());
    }
    if let Some(v) = s("keepalive") {
        parts.push(format!("keepalive {v}"));
    }
    if let Some(c) = f.get("compat").and_then(Value::as_array).filter(|a| !a.is_empty()) {
        let names: Vec<&str> = c.iter().filter_map(Value::as_str).collect();
        parts.push(format!("compat: {}", names.join(", ")));
    }
    parts.join(", ")
}

/// 給裝置的回應：`soft` 時一律 200，第一行 `STATUS=<原本的狀態碼>`（uclient-fetch / BusyBox wget 看不到狀態碼，
/// 錯誤時連 body 都不存）。/ Device answers: with `soft` always 200 and a first line `STATUS=<code>`, because
/// uclient-fetch / BusyBox wget neither show the status code nor keep an error body.
pub fn soft_body(status: u16, body: &str) -> String {
    format!("STATUS={status}\n{body}")
}

/// `?soft=1`（或 `soft=yes` / `soft=true`）。
pub fn wants_soft(query: &std::collections::HashMap<String, String>) -> bool {
    matches!(query.get("soft").map(|s| s.trim()), Some("1" | "yes" | "true"))
}

/// 腳本最後一行的校驗碼：`# telepy-sha256: <hex>`，算的是它前面的全部內容。腳本從檔案執行時自己核對
/// （貼上或下載時少了幾個字元就會被抓到，而不是在 ash 裡報一個莫名的語法錯誤）。
/// Append the checksum trailer the script verifies when run from a file (a damaged paste / download is caught
/// as such, not as a baffling ash syntax error).
pub const CHECKSUM_PREFIX: &str = "# telepy-sha256: ";

pub fn with_checksum(script: &str) -> String {
    use sha2::{Digest, Sha256};
    let body = if script.ends_with('\n') { script.to_string() } else { format!("{script}\n") };
    let hex = Sha256::digest(body.as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>();
    format!("{body}{CHECKSUM_PREFIX}{hex}\n")
}

/// 給腳本讀的 `KEY=value` 行（值不能換行）。/ `KEY=value` lines for the script (values are single-line).
pub fn kv_lines(pairs: &[(&str, String)]) -> String {
    let mut out = String::new();
    for (k, v) in pairs {
        let v: String = v.chars().filter(|c| *c != '\n' && *c != '\r').collect();
        out.push_str(k);
        out.push('=');
        out.push_str(&v);
        out.push('\n');
    }
    out
}

/// 「伺服器能不能登入裝置」失敗時給人看的說明。/ Explain a failed login check.
pub fn explain_login_error(err: &str, username: &str) -> String {
    let e = err.to_ascii_lowercase();
    if e.contains("device auth") {
        format!("The tunnel is up, but this machine's SSH server did not accept Telepy's key for {username}. Check that sshd reads ~/.ssh/authorized_keys (AuthorizedKeysFile) and allows public keys for {username}.")
    } else if e.contains("connect") || e.contains("timed out") || e.contains("refused") {
        format!("The tunnel is up, but nothing answered on this machine's SSH port. Is the SSH server running? ({err})")
    } else {
        format!("The tunnel is up, but the test login as {username} failed: {err}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_from_hostnames() {
        assert_eq!(tunnel_name_from("office-pi.local"), "office-pi.local");
        assert_eq!(tunnel_name_from("123box"), "123box", "a digit may start a name");
        assert_eq!(tunnel_name_from("  my host!  "), "my-host");
        assert_eq!(tunnel_name_from("---"), "device");
        assert_eq!(tunnel_name_from(&"a".repeat(80)).len(), 63);
        let c: Vec<String> = name_candidates("pi").take(3).collect();
        assert_eq!(c, vec!["pi", "pi-2", "pi-3"]);
        assert_eq!(name_candidates(&"b".repeat(63)).nth(1).unwrap().len(), 63);
        assert_eq!(clean_hostname("pi;rm -rf /\n"), "pirm-rf");
    }

    #[test]
    fn kv_output_is_line_safe() {
        assert_eq!(kv_lines(&[("A", "1".into()), ("B", "x\ny".into())]), "A=1\nB=xy\n");
        assert_eq!(soft_body(409, "ERROR=used\n"), "STATUS=409\nERROR=used\n");
        let q: std::collections::HashMap<String, String> = [("soft".to_string(), "1".to_string())].into_iter().collect();
        assert!(wants_soft(&q));
        assert!(!wants_soft(&std::collections::HashMap::new()));
    }

    #[test]
    fn checksum_trailer_matches_sha256sum_of_the_body() {
        // `printf 'hello\n' | sha256sum` — the script does the same with `sed '$d' "$0" | sha256sum`.
        let out = with_checksum("hello\n");
        assert_eq!(out, "hello\n# telepy-sha256: 5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03\n");
        assert_eq!(with_checksum("hello"), out, "a missing final newline is added before hashing");
    }

    #[test]
    fn facts_are_allow_listed_and_trimmed() {
        assert!(parse_facts(None).is_none());
        assert!(parse_facts(Some(&json!("x"))).is_none());
        assert!(parse_facts(Some(&json!({"bogus": "1"}))).is_none(), "unknown keys only = nothing");
        let f = parse_facts(Some(&json!({
            "shell": "ash (BusyBox 1.36.1)", "client": "dbclient 2022.82", "server": "Dropbear 2022.82", "init": "procd",
            "keepalive": "tcp", "compat": ["no_server_alive", 5, "x\ny"], "token": "tpj_secret", "os": "中文\u{7}OpenWrt 23.05"
        })))
        .unwrap();
        assert_eq!(f["client"], "dbclient 2022.82");
        assert!(f.get("token").is_none(), "unknown keys are dropped");
        assert_eq!(f["compat"], json!(["no_server_alive", "xy"]), "non-strings dropped, control chars stripped");
        assert_eq!(f["os"], "OpenWrt 23.05", "non-ASCII and control characters are stripped");
        assert_eq!(facts_summary(&f), "ash (BusyBox 1.36.1), dbclient 2022.82 → Dropbear 2022.82, procd, keepalive tcp, compat: no_server_alive, xy");
        let long = "a".repeat(500);
        assert_eq!(parse_facts(Some(&json!({"client": long}))).unwrap()["client"].as_str().unwrap().len(), FACT_MAX_LEN);
        assert_eq!(facts_summary(&json!({"server": "OpenSSH_9.6"})), "server OpenSSH_9.6");
    }

    #[test]
    fn tickets_are_single_use_and_scoped() {
        let s = JoinTickets::default();
        let (token, t) = s.mint(1, None, false, "ssh").unwrap();
        assert!(token.starts_with(TOKEN_PREFIX));
        assert_eq!(s.by_id(1, &t.id).unwrap().phase, Phase::Waiting);
        assert!(s.by_id(2, &t.id).is_none(), "another user cannot see it");
        assert_eq!(s.claim("tpj_nope").unwrap_err(), TakeError::Invalid);
        let claimed = s.claim(&token).unwrap();
        assert_eq!(s.claim(&token).unwrap_err(), TakeError::Used, "one registration per ticket");
        s.release(&claimed.token_hash);
        assert!(s.claim(&token).is_ok(), "a failed registration can be retried");
        s.registered(&claimed.token_hash, Registration { same_machine_as: None, facts: None, tunnel_id: 7, tunnel_name: "pi".into(), reverse_port: 40001, username: "pi".into(), ssh_port: 22, hostname: "pi".into(), os: "Linux".into() });
        assert_eq!(s.by_token(&token).unwrap().tunnel_id, Some(7));
        assert!(s.begin_verify(&claimed.token_hash));
        assert!(!s.begin_verify(&claimed.token_hash), "one check at a time");
        s.end_verify(&claimed.token_hash);
        assert!(s.set_phase(&claimed.token_hash, Phase::Verified, None).is_some());
        assert!(s.set_phase(&claimed.token_hash, Phase::Verified, None).is_none(), "no duplicate updates");
        assert!(!s.revoke(1, &t.id), "a used ticket is not revoked");
        for _ in 0..MAX_OPEN_PER_USER {
            s.mint(3, None, false, "ssh").unwrap();
        }
        assert!(s.mint(3, None, false, "ssh").is_none(), "per-user cap");
        let (_, open) = s.mint(4, Some("x".into()), true, "websocket").unwrap();
        assert!(s.revoke(4, &open.id));
        assert!(s.by_id(4, &open.id).is_none());
    }
}
