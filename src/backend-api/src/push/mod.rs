//! 推播通知（Web Push）：把網頁上本來就會跳的通知，在 Telepy 沒開著時也送到裝置上。
//!
//! - 每件事走 `Webhooks::emit`（收件人跟站內通知同一份），這裡挑出會推播的事件（[`notice::pushed`]），每個收件人再照
//!   自己「桌面通知」那一欄的偏好（全站預設 → 我的 → 這條隧道靜音、管理員強制）決定要不要送。
//! - 每台裝置一筆訂閱（`db::push`），綁在開它的網頁登入上：登出 / 被登出 / 停用帳號就刪掉；推播服務回 404 / 410 也刪。
//! - 內容用 RFC 8291 加密（[`crypto`]），VAPID 金鑰在 `<DATA_DIR>/push/vapid.key`（[`vapid`]）；推播服務只看得到密文。
//! - 只連認得的推播服務（[`notice::check_endpoint`]），連線再經 webhook 的「只連公網位址」解析器。每台裝置每分鐘最多
//!   [`PER_MINUTE`] 則。
//!
//! Push notifications (Web Push): the notifications the web already shows, delivered to a device while Telepy is closed.
//! Events come through `Webhooks::emit` (the in-app notification's audience); the pushed ones ([`notice::pushed`]) go to
//! each recipient whose "desktop" preference allows it (site default → mine → tunnel mute, enforced by admins). One
//! subscription per device (`db::push`), bound to the sign-in that made it: signing out, being signed out or a disabled
//! account removes it, and so does a 404 / 410 from the push service. Messages are encrypted per RFC 8291 ([`crypto`]);
//! the VAPID key lives in `<DATA_DIR>/push/vapid.key` ([`vapid`]); the push service sees ciphertext only. Only known
//! push services are contacted ([`notice::check_endpoint`]), through the webhooks' public-address resolver; at most
//! [`PER_MINUTE`] pushes per device per minute.

pub mod crypto;
pub mod notice;
pub mod vapid;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::config::Config;
use crate::db::{self, push::Subscription, settings::SiteSettings, Db};
use crate::notify_prefs::{layers_for, resolve, Channel};
use crate::webhooks::text::Lang;
use crate::webhooks::Event;
use notice::Notice;
use vapid::VapidKey;

/// 每台裝置每分鐘最多幾則。/ Pushes per device per minute.
pub const PER_MINUTE: usize = 30;
/// 「離線多久才推」可以選的（秒）；預設 1 分鐘。/ The offline waits one may pick (seconds); 1 minute by default.
pub const STATUS_DELAYS: [i64; 8] = [0, 60, 120, 300, 600, 900, 1800, 3600];
pub const DEFAULT_STATUS_DELAY: i64 = 60;

/// 實際等多久：自己選的，但不超過站台上限。/ The wait in effect: one's choice, capped by the site.
pub fn status_delay(choice: i64, site_max: i64) -> Duration {
    Duration::from_secs(choice.clamp(0, site_max.max(0)) as u64)
}

/// 一個人這一小時的上線 / 離線推播。/ One person's status pushes in the current hour.
#[derive(Default)]
pub struct StatusCap {
    sent: VecDeque<Instant>,
    held: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapOutcome {
    Send,
    /// 剛好到上限：送一則「還有更多」。/ Just hit the cap: send one "more are waiting".
    Hold,
    Skip,
}

impl StatusCap {
    /// 過去一小時送了幾則決定這則：沒到上限 = 送；到了 = 第一次送「還有更多」，之後不送，直到視窗空出來。
    /// The past hour decides: below the cap = send; at the cap = one "more are waiting", then nothing until room frees up.
    pub fn admit(&mut self, now: Instant, per_hour: i64) -> CapOutcome {
        while self.sent.front().is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(3600)) {
            self.sent.pop_front();
        }
        if (self.sent.len() as i64) < per_hour.max(1) {
            self.held = false;
            self.sent.push_back(now);
            return CapOutcome::Send;
        }
        if self.held {
            CapOutcome::Skip
        } else {
            self.held = true;
            CapOutcome::Hold
        }
    }
}
const TIMEOUT: Duration = Duration::from_secs(10);
/// 沒有 https 公開網址時給推播服務的聯絡方式。/ The contact given to push services without an https public URL.
const FALLBACK_SUB: &str = "https://github.com/NatLee/telepy";

/// 一次送出的結果。/ The outcome of one delivery.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Sent,
    /// 推播服務說這個訂閱不在了（404 / 410），已經刪掉。/ The push service says the subscription is gone (404 / 410); deleted.
    Gone,
    /// 這分鐘送太多了，這則沒送。/ Too many this minute; this one was skipped.
    Skipped,
    Failed(String),
}

pub struct Push {
    db: Db,
    config: Config,
    client: reqwest::Client,
    key_path: PathBuf,
    key: Mutex<Option<Arc<VapidKey>>>,
    flood: Mutex<HashMap<i64, VecDeque<Instant>>>,
    /// 每個人這一小時的上線 / 離線推播。/ Each person's status pushes this hour.
    status_caps: Mutex<HashMap<i64, StatusCap>>,
    /// 測試用：這個前綴的網址也算推播服務，而且直接連（不經公網解析器）。/ For tests: URLs with this prefix count as a push service, connected directly.
    test_service: Mutex<Option<String>>,
}

impl Push {
    pub fn new(config: &Config, db: Db) -> Self {
        let client = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("Telepy-Push/1")
            .no_proxy()
            .dns_resolver(Arc::new(crate::webhooks::target::PublicResolver))
            .build()
            .expect("reqwest client");
        Self {
            db,
            config: config.clone(),
            client,
            key_path: key_path(config),
            key: Mutex::new(None),
            flood: Mutex::new(HashMap::new()),
            status_caps: Mutex::new(HashMap::new()),
            test_service: Mutex::new(None),
        }
    }

    /// 測試用：把一個本機的假推播服務當成認得的。/ For tests: accept a local fake push service.
    pub fn set_test_service(&self, prefix: &str) {
        *self.test_service.lock().unwrap() = Some(prefix.to_string());
    }

    /// 訂閱網址檢查（測試的假服務也算）。/ Check a subscription URL (the test service counts too).
    pub fn check_endpoint(&self, s: &str) -> Result<url::Url, &'static str> {
        if let Some(prefix) = self.test_service.lock().unwrap().as_deref() {
            if s.starts_with(prefix) {
                return url::Url::parse(s).map_err(|_| "The subscription URL is not a URL.");
            }
        }
        notice::check_endpoint(s)
    }

    /// VAPID 金鑰：第一次用時讀檔，沒有就產生。/ The VAPID key: read on first use, created when missing.
    pub fn key(&self) -> Result<Arc<VapidKey>, String> {
        let mut slot = self.key.lock().unwrap();
        if let Some(k) = slot.as_ref() {
            return Ok(k.clone());
        }
        let k = Arc::new(vapid::load_or_create(&self.key_path)?);
        *slot = Some(k.clone());
        Ok(k)
    }

    /// 一件事發生了：背景挑出要推給誰。上線 / 離線這類狀態不走這裡（監控迴圈照每個人的延遲送，`status`）。
    /// An event happened: push it in the background to whoever should get it. Status events don't come here (the
    /// monitor sends them after each person's delay, `status`).
    pub fn event(self: &Arc<Self>, event: &Event) {
        if !notice::pushed(event.kind) || event.kind.is_status() || event.audience.is_empty() {
            return;
        }
        let (me, event) = (self.clone(), event.clone());
        tokio::spawn(async move {
            if let Err(e) = me.dispatch(&event).await {
                tracing::warn!(error = %e, event = event.kind.name(), "push: cannot dispatch");
            }
        });
    }

    async fn dispatch(&self, event: &Event) -> sqlx::Result<()> {
        let settings = db::settings::get_solo(&self.db).await?;
        if !settings.notify_push {
            return Ok(());
        }
        let app_name = app_name(&self.config, &settings);
        let defaults = db::notify_prefs::defaults(&self.db).await?;
        let tunnel_id = event.tunnel.as_ref().map(|t| t.id).filter(|_| event.kind.about_tunnel());
        for &user in &event.audience {
            let subs = db::push::live_for_user(&self.db, user).await?;
            if subs.is_empty() {
                continue;
            }
            if !self.allowed(user, event.kind, tunnel_id, &defaults).await? {
                continue;
            }
            for sub in subs {
                let lang = Lang::from_pref(Some(&sub.lang));
                if let Some(n) = notice::notice(event.kind, lang, event.tunnel.as_ref(), &event.data, event.link.as_deref(), sub.details, &app_name) {
                    self.deliver(&sub, &n).await;
                }
            }
        }
        Ok(())
    }

    /// 這個人「桌面通知」那一欄允許這件事（恢復跟著降級）。/ This person's desktop preference allows it (recovered follows degraded).
    async fn allowed(&self, user: i64, kind: crate::webhooks::Kind, tunnel_id: Option<i64>, defaults: &[db::notify_prefs::DefaultRow]) -> sqlx::Result<bool> {
        let decide = notice::pref_kind(kind);
        let mine = db::notify_prefs::prefs(&self.db, user).await?;
        let mutes = db::notify_prefs::mutes(&self.db, user).await?;
        Ok(resolve(decide, layers_for(defaults, &mine, &mutes, decide, Channel::Desktop, tunnel_id)).0)
    }

    /// 誰在收上線 / 離線推播、各等多久（有活著的訂閱的人；站台關掉 = 沒有）。/ Who gets status pushes, and each one's wait.
    pub async fn status_listeners(&self) -> sqlx::Result<HashMap<i64, Duration>> {
        let settings = db::settings::get_solo(&self.db).await?;
        if !settings.notify_push {
            return Ok(HashMap::new());
        }
        Ok(db::push::status_listeners(&self.db).await?.into_iter().map(|(user, choice)| (user, status_delay(choice, settings.notify_push_max_delay))).collect())
    }

    /// 一條隧道的狀態變化已經持續超過這個人的延遲（或發過的結束了）：照偏好與每小時上限推給他的裝置。
    /// A status change outlasted this person's delay (or an announced one ended): push it per their preferences and the
    /// hourly cap.
    pub fn status(self: &Arc<Self>, user: i64, tunnel: crate::webhooks::TunnelRef, kind: crate::webhooks::Kind) {
        let me = self.clone();
        tokio::spawn(async move {
            if let Err(e) = me.send_status(user, &tunnel, kind).await {
                tracing::warn!(error = %e, user, tunnel = tunnel.id, "push: cannot send a status change");
            }
        });
    }

    async fn send_status(&self, user: i64, tunnel: &crate::webhooks::TunnelRef, kind: crate::webhooks::Kind) -> sqlx::Result<()> {
        let settings = db::settings::get_solo(&self.db).await?;
        if !settings.notify_push {
            return Ok(());
        }
        let defaults = db::notify_prefs::defaults(&self.db).await?;
        if !self.allowed(user, kind, Some(tunnel.id), &defaults).await? {
            return Ok(());
        }
        let subs = db::push::live_for_user(&self.db, user).await?;
        if subs.is_empty() {
            return Ok(());
        }
        let outcome = self.status_caps.lock().unwrap().entry(user).or_default().admit(Instant::now(), settings.notify_push_per_hour);
        let app_name = app_name(&self.config, &settings);
        for sub in subs {
            let lang = Lang::from_pref(Some(&sub.lang));
            let n = match outcome {
                CapOutcome::Send => notice::notice(kind, lang, Some(tunnel), &serde_json::json!({}), Some(&format!("/tunnels/{}", tunnel.id)), sub.details, &app_name),
                CapOutcome::Hold => Some(notice::held(lang, &app_name, settings.notify_push_per_hour)),
                CapOutcome::Skip => None,
            };
            if let Some(n) = n {
                self.deliver(&sub, &n).await;
            }
        }
        Ok(())
    }

    /// 送一則測試推播給這台裝置。/ Send this device a test push.
    pub async fn test(&self, sub: &Subscription) -> Outcome {
        let settings = db::settings::get_solo(&self.db).await.ok();
        let name = settings.as_ref().map(|s| app_name(&self.config, s)).unwrap_or_else(|| crate::app_manifest::DEFAULT_NAME.to_string());
        let body = match Lang::from_pref(Some(&sub.lang)) {
            Lang::En => "Push notifications work on this device.",
            Lang::ZhTw => "這台裝置收得到推播通知了。",
            Lang::Ja => "このデバイスでプッシュ通知を受け取れます。",
        };
        let n = Notice { title: name, body: body.to_string(), tag: "push-test".into(), path: "/tunnels".into(), urgent: true, ttl: 600 };
        self.deliver(&sub.clone(), &n).await
    }

    fn admit(&self, id: i64) -> bool {
        let mut map = self.flood.lock().unwrap();
        let q = map.entry(id).or_default();
        let now = Instant::now();
        while q.front().is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(60)) {
            q.pop_front();
        }
        if q.len() >= PER_MINUTE {
            return false;
        }
        q.push_back(now);
        true
    }

    /// 加密、簽 VAPID、送出，記下結果。/ Encrypt, sign VAPID, send, and record the outcome.
    pub async fn deliver(&self, sub: &Subscription, n: &Notice) -> Outcome {
        if !self.admit(sub.id) {
            tracing::debug!(subscription = sub.id, "push: rate limited");
            return Outcome::Skipped;
        }
        let outcome = self.send(sub, n).await;
        let recorded = match &outcome {
            Outcome::Sent => db::push::record_success(&self.db, sub.id).await,
            Outcome::Gone => db::push::delete(&self.db, sub.id).await,
            Outcome::Failed(e) => {
                tracing::info!(subscription = sub.id, error = %e, "push: delivery failed");
                db::push::record_error(&self.db, sub.id, e).await
            }
            Outcome::Skipped => Ok(()),
        };
        if let Err(e) = recorded {
            tracing::warn!(error = %e, "push: cannot record the outcome");
        }
        outcome
    }

    async fn send(&self, sub: &Subscription, n: &Notice) -> Outcome {
        let endpoint = match self.check_endpoint(&sub.endpoint) {
            Ok(u) => u,
            Err(e) => return Outcome::Failed(e.to_string()),
        };
        let key = match self.key() {
            Ok(k) => k,
            Err(e) => return Outcome::Failed(format!("VAPID key: {e}")),
        };
        let body = match crypto::b64(&sub.p256dh).and_then(|p| crypto::b64(&sub.auth).map(|a| (p, a))).and_then(|(p, a)| crypto::encrypt(&p, &a, &n.payload())) {
            Ok(b) => b,
            Err(e) => return Outcome::Failed(e.to_string()),
        };
        let authorization = match key.authorization(&endpoint, &self.contact(), chrono::Utc::now().timestamp()) {
            Ok(a) => a,
            Err(e) => return Outcome::Failed(e),
        };
        let direct = self.test_service.lock().unwrap().as_deref().is_some_and(|p| sub.endpoint.starts_with(p));
        let client = if direct { reqwest::Client::new() } else { self.client.clone() };
        let res = client
            .post(endpoint)
            .header("TTL", n.ttl.to_string())
            .header("Content-Encoding", "aes128gcm")
            .header("Content-Type", "application/octet-stream")
            .header("Urgency", if n.urgent { "high" } else { "normal" })
            .header("Topic", n.topic())
            .header("Authorization", authorization)
            .body(body)
            .timeout(TIMEOUT)
            .send()
            .await;
        match res {
            Ok(r) if r.status().is_success() => Outcome::Sent,
            Ok(r) if matches!(r.status().as_u16(), 404 | 410) => Outcome::Gone,
            Ok(r) => {
                let status = r.status().as_u16();
                let text: String = r.text().await.unwrap_or_default().chars().take(200).collect();
                Outcome::Failed(format!("HTTP {status}{}", if text.trim().is_empty() { String::new() } else { format!(": {}", text.trim()) }))
            }
            Err(e) => Outcome::Failed(e.without_url().to_string()),
        }
    }

    /// VAPID 的 `sub`：https 的公開網址，否則 Telepy 的專案頁。/ The VAPID `sub`: the https public URL, else Telepy's project page.
    fn contact(&self) -> String {
        self.config.public_base().filter(|u| u.starts_with("https://")).unwrap_or_else(|| FALLBACK_SUB.to_string())
    }
}

/// `<DATA_DIR>/push/vapid.key`
pub fn key_path(config: &Config) -> PathBuf {
    config.data_dir.join("push").join("vapid.key")
}

/// 推播的標題 = App 名稱（沒有請求可看，網域用 PUBLIC_URL 或 SERVER_DOMAIN）。/ The title = the app name (no request here, so the domain is PUBLIC_URL's or SERVER_DOMAIN).
pub fn app_name(config: &Config, s: &SiteSettings) -> String {
    let host = crate::ssh_host::web_host(config.public_base().as_deref()).or_else(|| config.server_domain.clone());
    crate::app_manifest::effective_name(&s.app_name_mode, &s.app_name, host.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wait_is_ones_choice_within_the_sites_limit() {
        assert_eq!(status_delay(60, 3600), Duration::from_secs(60));
        assert_eq!(status_delay(3600, 600), Duration::from_secs(600), "the site's limit wins");
        assert_eq!(status_delay(300, 0), Duration::ZERO);
        assert_eq!(status_delay(-5, 3600), Duration::ZERO);
        assert!(STATUS_DELAYS.contains(&DEFAULT_STATUS_DELAY));
    }

    #[test]
    fn the_hourly_cap_sends_one_notice_then_waits_for_room() {
        let mut cap = StatusCap::default();
        let t0 = Instant::now();
        assert_eq!(cap.admit(t0, 2), CapOutcome::Send);
        assert_eq!(cap.admit(t0 + Duration::from_secs(10), 2), CapOutcome::Send);
        assert_eq!(cap.admit(t0 + Duration::from_secs(20), 2), CapOutcome::Hold, "one notice says more are waiting");
        assert_eq!(cap.admit(t0 + Duration::from_secs(30), 2), CapOutcome::Skip);
        assert_eq!(cap.admit(t0 + Duration::from_secs(3599), 2), CapOutcome::Skip);
        // 第一則滿一小時：空出一格，可以再送，之後到上限又會有一則提醒。/ The first leaves the window: room again, and a new notice at the cap.
        assert_eq!(cap.admit(t0 + Duration::from_secs(3600), 2), CapOutcome::Send);
        assert_eq!(cap.admit(t0 + Duration::from_secs(3601), 2), CapOutcome::Hold);
        assert_eq!(StatusCap::default().admit(t0, 0), CapOutcome::Send, "a cap below 1 still lets one through");
    }
}
