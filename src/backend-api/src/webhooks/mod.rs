//! Webhook：每個人自己設的（收他在網頁上本來就會收到的那些通知），加上管理員共管的全站 webhook（精選的重要事件）。
//! 發事件的地方呼叫 [`Webhooks::emit`]，帶上「這件事的站內通知會給誰」；這裡挑出要收的 webhook、依各自的語言與格式
//! 組訊息、簽章（Standard Webhooks）、送出（失敗重試兩次）、記紀錄。連續失敗 [`PAUSE_AFTER`] 次就暫停並通知擁有者。
//! 隧道狀態（離線 / 恢復 / 降級）不走 emit：監控迴圈依每個 webhook 自己的延遲計時，再用 [`Webhooks::send_to`] 直接送。
//! Webhooks: personal ones (each person gets the notifications the web already gives them) and the admins'
//! site-wide ones (a curated set of important events). Event sources call [`Webhooks::emit`] with the audience
//! of the matching in-app notification; this module picks the webhooks that want it, renders the message in each
//! webhook's language and format, signs it (Standard Webhooks), sends it (two retries) and records the delivery.
//! After [`PAUSE_AFTER`] failures in a row a webhook is paused and its owner told. Tunnel status does not go
//! through `emit`: the monitor times it per webhook and calls [`Webhooks::send_to`].

pub mod catalog;
pub mod format;
pub mod sign;
pub mod target;
pub mod text;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

pub use catalog::Kind;
use format::Format;
use text::Lang;

use crate::config::Config;
use crate::db::{self, webhooks::WebhookRow, Db};
use crate::hub::Hub;
use crate::vault::Vault;

/// 連續失敗幾次就暫停。/ Consecutive failed deliveries before a webhook is paused.
pub const PAUSE_AFTER: i64 = 20;
/// 每個 webhook 一分鐘最多送幾則（超過的跳過，免得洗版或被對方限流）。/ Deliveries per webhook per minute.
pub const PER_MINUTE: usize = 30;
const TIMEOUT: Duration = Duration::from_secs(10);
/// 記錄裡留多少內容。/ How much of the body a delivery record keeps.
const BODY_KEPT: usize = 16 * 1024;
/// 快取多久重讀一次（使用者被停用之類不經 API 的變化）。/ Cache lifetime for changes that bypass the API.
const CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq)]
pub struct TunnelRef {
    pub id: i64,
    pub name: String,
    pub reverse_port: i64,
}

impl TunnelRef {
    pub fn of(t: &db::tunnels::Tunnel) -> Self {
        Self { id: t.id, name: t.host_friendly_name.clone(), reverse_port: t.reverse_port }
    }
}

/// 一件要通知的事。`audience` = 個人 webhook 能收的人（就是同一件事站內通知的對象）。
/// One event. `audience` = whose personal webhooks may get it (the in-app notification's audience).
#[derive(Debug, Clone)]
pub struct Event {
    pub kind: Kind,
    pub tunnel: Option<TunnelRef>,
    pub audience: Vec<i64>,
    pub data: Value,
    /// 網頁裡的路徑（`/tunnels/...`），有公開網址時變成訊息裡的連結。/ A web path, linked when the public URL is known.
    pub link: Option<String>,
}

impl Event {
    pub fn new(kind: Kind) -> Self {
        Self { kind, tunnel: None, audience: Vec::new(), data: json!({}), link: None }
    }
    /// 這件事的隧道；連結預設是那條隧道的 Logs（記著剛剛發生的事）。/ The tunnel; links default to its Logs.
    pub fn tunnel(self, t: &db::tunnels::Tunnel) -> Self {
        self.tunnel_ref(TunnelRef::of(t))
    }
    pub fn tunnel_ref(mut self, t: TunnelRef) -> Self {
        self.link.get_or_insert_with(|| format!("/tunnels/logs?tunnel={}", t.id));
        self.tunnel = Some(t);
        self
    }
    /// 收件人；`except` 拿掉（通常是做這件事的人）。/ Recipients, minus `except` (usually whoever did it).
    pub fn to(mut self, users: impl IntoIterator<Item = i64>, except: Option<i64>) -> Self {
        let mut v: Vec<i64> = users.into_iter().filter(|u| Some(*u) != except).collect();
        v.sort_unstable();
        v.dedup();
        self.audience = v;
        self
    }
    pub fn data(mut self, data: Value) -> Self {
        self.data = data;
        self
    }
    pub fn link(mut self, path: impl Into<String>) -> Self {
        self.link = Some(path.into());
        self
    }
}

/// 發送端看到的 webhook。/ A webhook as the dispatcher sees it.
#[derive(Debug, Clone)]
pub struct Hook {
    pub row: WebhookRow,
    pub events: Vec<Kind>,
    pub tunnels: Vec<i64>,
    pub format: Format,
    pub lang: Lang,
}

impl Hook {
    pub fn new(row: WebhookRow, tunnels: Vec<i64>) -> Self {
        let events = catalog::parse_list(&row.events);
        let format = Format::parse(&row.format).unwrap_or(Format::Auto);
        let lang = Lang::parse(&row.language).unwrap_or(Lang::En);
        Self { row, events, tunnels, format, lang }
    }

    pub fn wants(&self, kind: Kind) -> bool {
        self.events.contains(&kind) && if self.row.is_site() { kind.site() } else { kind.personal() }
    }

    pub fn covers_tunnel(&self, tunnel_id: i64) -> bool {
        self.row.all_tunnels || self.tunnels.contains(&tunnel_id)
    }

    /// 狀態事件：這個 webhook 能收這條隧道的嗎（全站 = 每條；個人 = 擁有者看得到的）。
    /// Status events: whether this webhook may hear about a tunnel (site = any; personal = its owner can see it).
    pub fn receives_status_of(&self, tunnel_id: i64, viewers: &[i64]) -> bool {
        self.covers_tunnel(tunnel_id) && (self.row.is_site() || self.row.user_id.is_some_and(|u| viewers.contains(&u)))
    }
}

/// 一個 webhook 要不要收這件事（純函式）。/ Whether a webhook gets an event (pure).
pub fn matches(hook: &Hook, event: &Event, personal_on: bool) -> bool {
    if !hook.row.enabled || !hook.wants(event.kind) {
        return false;
    }
    if !hook.row.is_site() {
        if !personal_on {
            return false;
        }
        match hook.row.user_id {
            Some(owner) if event.audience.contains(&owner) => {}
            _ => return false,
        }
    }
    match (&event.tunnel, event.kind.about_tunnel()) {
        (Some(t), true) => hook.covers_tunnel(t.id),
        _ => true,
    }
}

/// 一次送出的結果。/ The outcome of one delivery.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub ok: bool,
    pub skipped: bool,
    pub status: Option<u16>,
    pub error: String,
    pub attempts: u32,
    pub duration_ms: u64,
}

enum Admit {
    Yes,
    /// 太多了：跳過，這一波第一次跳過要記一筆。/ Too many: skip, recording the first skip of the burst.
    SkipNote,
    Skip,
}

#[derive(Default)]
struct Flood {
    sent: VecDeque<Instant>,
    noted: bool,
}

pub struct Webhooks {
    db: Db,
    hub: Arc<Hub>,
    vault: Vault,
    base_url: Option<String>,
    /// 只連公網位址（個人 webhook）。/ Public addresses only (personal webhooks).
    strict: reqwest::Client,
    /// 什麼都能連（全站 webhook、或管理員放行內網時）。/ Anything (site webhooks, or when private targets are allowed).
    open: reqwest::Client,
    cache: Mutex<Option<(Instant, Arc<Vec<Hook>>)>>,
    gate: tokio::sync::Semaphore,
    flood: Mutex<HashMap<i64, Flood>>,
    retries: Mutex<Vec<Duration>>,
}

fn client(strict: bool) -> reqwest::Client {
    let b = reqwest::Client::builder().timeout(TIMEOUT).connect_timeout(Duration::from_secs(5)).redirect(reqwest::redirect::Policy::none()).user_agent("Telepy-Webhooks/1");
    let b = if strict { b.no_proxy().dns_resolver(Arc::new(target::PublicResolver)) } else { b };
    b.build().expect("reqwest client")
}

/// reqwest 的錯誤 → 一行說明（拿掉網址：網址裡常有 token），附上底層原因。
/// A reqwest error as one line, without the URL (URLs often carry tokens), with the underlying cause.
fn error_line(e: reqwest::Error) -> String {
    let timeout = e.is_timeout();
    let e = e.without_url();
    let mut parts = vec![e.to_string()];
    let mut src = std::error::Error::source(&e);
    while let Some(s) = src {
        let line = s.to_string();
        if !parts.contains(&line) {
            parts.push(line);
        }
        src = s.source();
    }
    if timeout {
        parts.push(format!("no answer within {} s", TIMEOUT.as_secs()));
    }
    parts.join(": ")
}

fn clip_body(body: &[u8]) -> String {
    let s = String::from_utf8_lossy(body);
    match s.char_indices().nth(BODY_KEPT) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.into_owned(),
    }
}

impl Webhooks {
    pub fn new(config: &Config, db: Db, hub: Arc<Hub>) -> Self {
        let base_url = config.public_url.clone().or_else(|| config.server_domain.as_ref().filter(|d| !d.is_empty() && *d != "localhost").map(|d| format!("https://{d}")));
        Self {
            db,
            hub,
            vault: Vault::new(&config.secret_key),
            base_url: base_url.map(|u| u.trim_end_matches('/').to_string()),
            strict: client(true),
            open: client(false),
            cache: Mutex::new(None),
            gate: tokio::sync::Semaphore::new(16),
            flood: Mutex::new(HashMap::new()),
            retries: Mutex::new(vec![Duration::from_secs(10), Duration::from_secs(60)]),
        }
    }

    /// 測試用：重試間隔。/ For tests: the retry delays.
    pub fn set_retry_delays(&self, delays: Vec<Duration>) {
        *self.retries.lock().unwrap() = delays;
    }

    /// webhook 改了：下次重讀。/ Webhooks changed: reload next time.
    pub fn invalidate(&self) {
        *self.cache.lock().unwrap() = None;
    }

    /// 現在會送的 webhook（快取 30 秒）。/ The webhooks that deliver now (cached for 30 s).
    pub async fn hooks(&self) -> Arc<Vec<Hook>> {
        if let Some((at, hooks)) = self.cache.lock().unwrap().as_ref() {
            if at.elapsed() < CACHE_TTL {
                return hooks.clone();
            }
        }
        let loaded: sqlx::Result<Vec<Hook>> = async {
            let rows = db::webhooks::active(&self.db).await?;
            let mut tunnels = db::webhooks::tunnel_map(&self.db).await?;
            Ok(rows
                .into_iter()
                .map(|r| {
                    let t = tunnels.remove(&r.id).unwrap_or_default();
                    Hook::new(r, t)
                })
                .collect())
        }
        .await;
        match loaded {
            Ok(v) => {
                let v = Arc::new(v);
                *self.cache.lock().unwrap() = Some((Instant::now(), v.clone()));
                v
            }
            Err(e) => {
                tracing::warn!(error = %e, "webhooks: cannot load");
                Arc::new(Vec::new())
            }
        }
    }

    /// 訊息裡的連結。/ A link for messages.
    pub fn link(&self, path: &str) -> Option<String> {
        self.base_url.as_ref().map(|b| format!("{b}{path}"))
    }

    pub fn base_url(&self) -> Option<&str> {
        self.base_url.as_deref()
    }

    /// 發一件事：背景挑出要收的 webhook 送出。/ Emit an event; matching webhooks get it in the background.
    pub fn emit(self: &Arc<Self>, event: Event) {
        let me = self.clone();
        tokio::spawn(async move {
            let settings = match db::settings::get_solo(&me.db).await {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(error = %e, "webhooks: cannot read settings");
                    return;
                }
            };
            let hooks = me.hooks().await;
            for hook in hooks.iter().filter(|h| matches(h, &event, settings.notify_user_webhooks)) {
                me.send_to(hook.clone(), event.clone());
            }
        });
    }

    /// 直接送給一個 webhook（背景）。/ Send to one webhook in the background.
    pub fn send_to(self: &Arc<Self>, hook: Hook, event: Event) {
        let me = self.clone();
        tokio::spawn(async move {
            let allow_private = me.allow_private(&hook).await;
            me.deliver(&hook, &event, false, allow_private).await;
        });
    }

    pub async fn allow_private(&self, hook: &Hook) -> bool {
        hook.row.is_site() || db::settings::get_solo(&self.db).await.map(|s| s.notify_private_targets).unwrap_or(false)
    }

    fn admit(&self, id: i64) -> Admit {
        let mut map = self.flood.lock().unwrap();
        let f = map.entry(id).or_default();
        let now = Instant::now();
        while f.sent.front().is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(60)) {
            f.sent.pop_front();
        }
        if f.sent.len() >= PER_MINUTE {
            if f.noted {
                Admit::Skip
            } else {
                f.noted = true;
                Admit::SkipNote
            }
        } else {
            f.noted = false;
            f.sent.push_back(now);
            Admit::Yes
        }
    }

    fn aad(id: i64) -> String {
        format!("telepy-webhook:{id}")
    }

    /// 簽章密鑰；還沒有就產生一把存起來。解不開（換了 SECRET_KEY）回 None。
    /// The signing secret, created on first use; None when it cannot be opened (SECRET_KEY changed).
    pub async fn secret(&self, row: &WebhookRow) -> Option<String> {
        if row.secret.is_empty() {
            return self.rotate_secret(row.id).await.ok();
        }
        self.vault.open(&Self::aad(row.id), &row.secret).and_then(|b| String::from_utf8(b).ok())
    }

    /// 換一把新的簽章密鑰。/ Replace the signing secret.
    pub async fn rotate_secret(&self, id: i64) -> sqlx::Result<String> {
        let secret = sign::new_secret();
        db::webhooks::set_secret(&self.db, id, &self.vault.seal(&Self::aad(id), secret.as_bytes())).await?;
        Ok(secret)
    }

    /// 送一則（含重試）並記錄。`test` = 「送測試」：不受流量限制、不算進連續失敗。
    /// Deliver one message (with retries) and record it. `test` skips the rate limit and the failure count.
    pub async fn deliver(&self, hook: &Hook, event: &Event, test: bool, allow_private: bool) -> Outcome {
        let _permit = self.gate.acquire().await;
        let row = &hook.row;
        let msg_id = format!("msg_{}", crate::util::random_alnum(24));
        if !test {
            match self.admit(row.id) {
                Admit::Yes => {}
                admit => {
                    let error = format!("More than {PER_MINUTE} events in a minute: skipped until it calms down.");
                    if matches!(admit, Admit::SkipNote) {
                        let rec = db::webhooks::NewDelivery { webhook_id: row.id, event: event.kind.name(), message_id: &msg_id, status: "skipped", http_status: None, error: &error, attempts: 0, duration_ms: 0, test, body: "" };
                        if let Err(e) = db::webhooks::insert_delivery(&self.db, &rec).await {
                            tracing::warn!(webhook = row.id, error = %e, "webhooks: cannot record a delivery");
                        }
                    }
                    return Outcome { ok: false, skipped: true, status: None, error, attempts: 0, duration_ms: 0 };
                }
            }
        }
        let started = Instant::now();
        let (outcome, body) = self.attempt_all(hook, event, test, allow_private, &msg_id).await;
        let outcome = Outcome { duration_ms: started.elapsed().as_millis() as u64, ..outcome };
        let rec = db::webhooks::NewDelivery {
            webhook_id: row.id,
            event: event.kind.name(),
            message_id: &msg_id,
            status: if outcome.ok { "ok" } else { "failed" },
            http_status: outcome.status.map(i64::from),
            error: &outcome.error,
            attempts: i64::from(outcome.attempts),
            duration_ms: outcome.duration_ms as i64,
            test,
            body: &body,
        };
        if let Err(e) = db::webhooks::insert_delivery(&self.db, &rec).await {
            tracing::warn!(webhook = row.id, error = %e, "webhooks: cannot record a delivery");
        }
        let failures = db::webhooks::record_result(&self.db, row.id, outcome.ok, outcome.status.map(i64::from), &outcome.error, !test).await.unwrap_or(0);
        if outcome.ok {
            tracing::info!(webhook = row.id, event = event.kind.name(), "webhook delivered");
        } else {
            tracing::warn!(webhook = row.id, event = event.kind.name(), error = %outcome.error, "webhook delivery failed");
            if !test && failures >= PAUSE_AFTER {
                self.pause(row).await;
            }
        }
        outcome
    }

    /// 組訊息、送出、失敗就照間隔重試。回傳結果與送出的內容（記錄用）。
    /// Render, send and retry. Returns the outcome and the body sent (for the record).
    async fn attempt_all(&self, hook: &Hook, event: &Event, test: bool, allow_private: bool, msg_id: &str) -> (Outcome, String) {
        let fail = |error: String, attempts: u32| Outcome { ok: false, skipped: false, status: None, error, attempts, duration_ms: 0 };
        let mut url = match target::parse(&hook.row.url) {
            Ok(u) => u,
            Err(p) => return (fail(p.message().to_string(), 0), String::new()),
        };
        let format = hook.format.resolve(&url);
        let at = crate::util::db_to_iso_utc_z(&crate::util::now_db());
        let title = text::title(event.kind, hook.lang);
        let sentence = text::sentence(event.kind, hook.lang, event.tunnel.as_ref(), &event.data);
        let link = event.link.as_deref().and_then(|p| self.link(p));
        let msg = format::Message {
            id: msg_id,
            kind: event.kind,
            at: &at,
            title: &title,
            text: &sentence,
            server: self.base_url.as_deref(),
            link: link.as_deref(),
            link_label: hook.lang.open_label(),
            tunnel: event.tunnel.as_ref(),
            data: &event.data,
        };
        let rendered = format::render(format, &msg);
        let body = clip_body(&rendered.body);
        if !rendered.query.is_empty() {
            let mut q = url.query_pairs_mut();
            for (k, v) in &rendered.query {
                q.append_pair(k, v);
            }
        }
        if !allow_private && !target::literal_allowed(&url) {
            return (fail(target::Problem::Private.message().to_string(), 0), body);
        }
        let client = if allow_private { &self.open } else { &self.strict };
        let secret = self.secret(&hook.row).await;
        let delays: Vec<Duration> = if test { Vec::new() } else { self.retries.lock().unwrap().clone() };
        let mut attempts = 0u32;
        let mut last = fail(String::new(), 0);
        for wait in std::iter::once(Duration::ZERO).chain(delays) {
            if attempts > 0 {
                let wait = match last.status {
                    Some(429) => wait.max(Duration::from_secs(1)),
                    _ => wait,
                };
                tokio::time::sleep(wait).await;
            }
            attempts += 1;
            let ts = chrono::Utc::now().timestamp();
            let mut req = client
                .post(url.clone())
                .header(reqwest::header::CONTENT_TYPE, rendered.content_type)
                .header("webhook-id", msg_id)
                .header("webhook-timestamp", ts.to_string())
                .header("x-telepy-event", event.kind.name())
                .body(rendered.body.clone());
            if let Some(sig) = secret.as_deref().and_then(|s| sign::signature(s, msg_id, ts, &rendered.body)) {
                req = req.header("webhook-signature", sig);
            }
            let retryable = match req.send().await {
                Ok(res) if res.status().is_success() => {
                    return (Outcome { ok: true, skipped: false, status: Some(res.status().as_u16()), error: String::new(), attempts, duration_ms: 0 }, body);
                }
                Ok(res) => {
                    let code = res.status().as_u16();
                    let redirect = res.status().is_redirection();
                    last = Outcome {
                        ok: false,
                        skipped: false,
                        status: Some(code),
                        error: if redirect { format!("HTTP {code}: redirects are not followed; use the final URL") } else { format!("HTTP {code}") },
                        attempts,
                        duration_ms: 0,
                    };
                    code == 408 || code == 429 || code >= 500
                }
                Err(e) => {
                    let line = error_line(e);
                    let private = line.contains("public address");
                    last = fail(if private { target::Problem::Private.message().to_string() } else { line }, attempts);
                    !private
                }
            };
            if !retryable {
                break;
            }
        }
        (Outcome { attempts, ..last }, body)
    }

    /// 暫停並通知擁有者（全站的通知每個管理員）。/ Pause, and tell the owner (every admin for a site webhook).
    async fn pause(&self, row: &WebhookRow) {
        match db::webhooks::pause(&self.db, row.id, "failing").await {
            Ok(true) => {}
            Ok(false) => return,
            Err(e) => {
                tracing::warn!(webhook = row.id, error = %e, "webhooks: cannot pause");
                return;
            }
        }
        self.invalidate();
        tracing::warn!(webhook = row.id, failures = PAUSE_AFTER, "webhook paused after repeated failures");
        let users: Vec<i64> = if row.is_site() {
            sqlx::query_scalar("SELECT id FROM auth_user WHERE is_superuser = 1 AND is_active = 1").fetch_all(&self.db.read).await.unwrap_or_default()
        } else {
            row.user_id.into_iter().collect()
        };
        self.hub.notify_users(
            users,
            &json!({
                "action": "WEBHOOK-PAUSED",
                "webhook_id": row.id,
                "name": row.name,
                "scope": row.scope,
                "details": format!("Webhook \"{}\" was paused after {PAUSE_AFTER} failed deliveries in a row", row.name),
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(scope: &str, user_id: Option<i64>, events: &str, all_tunnels: bool) -> WebhookRow {
        WebhookRow {
            id: 1,
            user_id,
            scope: scope.into(),
            name: "x".into(),
            url: "https://example.com/h".into(),
            format: "auto".into(),
            language: "en".into(),
            events: events.into(),
            all_tunnels,
            delay: 60,
            secret: String::new(),
            enabled: true,
            paused_reason: String::new(),
            failures: 0,
            last_status: String::new(),
            last_at: None,
            last_code: None,
            last_error: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn tunnel(id: i64) -> TunnelRef {
        TunnelRef { id, name: format!("t{id}"), reverse_port: 1000 + id }
    }

    fn ev(kind: Kind, tunnel_id: Option<i64>, audience: &[i64]) -> Event {
        let mut e = Event::new(kind).to(audience.iter().copied(), None);
        e.tunnel = tunnel_id.map(tunnel);
        e
    }

    #[test]
    fn personal_hooks_follow_the_audience() {
        let mine = Hook::new(row("user", Some(7), "share.received,tunnel.ip_changed", true), vec![]);
        assert!(matches(&mine, &ev(Kind::ShareReceived, Some(1), &[7]), true));
        assert!(!matches(&mine, &ev(Kind::ShareReceived, Some(1), &[8]), true), "not in the audience");
        assert!(!matches(&mine, &ev(Kind::ShareEnded, Some(1), &[7]), true), "not subscribed");
        assert!(!matches(&mine, &ev(Kind::ShareReceived, Some(1), &[7]), false), "personal webhooks switched off by the admin");
    }

    #[test]
    fn site_hooks_ignore_the_audience_but_only_take_site_events() {
        let site = Hook::new(row("site", None, "tunnel.ip_changed,share.received,user.created", true), vec![]);
        assert!(matches(&site, &ev(Kind::TunnelIpChanged, Some(3), &[]), false), "site webhooks don't depend on the personal switch");
        assert!(matches(&site, &ev(Kind::UserCreated, None, &[]), true));
        assert!(!matches(&site, &ev(Kind::ShareReceived, Some(3), &[1]), true), "not a site event even if stored");
    }

    #[test]
    fn tunnel_filter_applies_to_tunnel_events_only() {
        let limited = Hook::new(row("user", Some(7), "tunnel.ip_changed,account.sign_in", false), vec![2]);
        assert!(matches(&limited, &ev(Kind::TunnelIpChanged, Some(2), &[7]), true));
        assert!(!matches(&limited, &ev(Kind::TunnelIpChanged, Some(3), &[7]), true));
        assert!(matches(&limited, &ev(Kind::AccountSignIn, None, &[7]), true), "account events have no tunnel");
    }

    #[test]
    fn disabled_hooks_get_nothing() {
        let mut r = row("user", Some(7), "share.received", true);
        r.enabled = false;
        assert!(!matches(&Hook::new(r, vec![]), &ev(Kind::ShareReceived, Some(1), &[7]), true));
    }

    #[test]
    fn status_receivers() {
        let personal = Hook::new(row("user", Some(7), "tunnel.offline", true), vec![]);
        assert!(personal.receives_status_of(1, &[3, 7]));
        assert!(!personal.receives_status_of(1, &[3]), "owner can no longer see it");
        let site = Hook::new(row("site", None, "tunnel.offline", false), vec![5]);
        assert!(site.receives_status_of(5, &[]));
        assert!(!site.receives_status_of(6, &[]));
    }

    #[test]
    fn event_builder_drops_the_actor() {
        let e = Event::new(Kind::SessionStarted).to([3, 1, 3, 2], Some(2));
        assert_eq!(e.audience, vec![1, 3]);
    }
}
