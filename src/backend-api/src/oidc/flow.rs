//! 進行中的 OIDC 登入、一次性票券、登入後要做的事（連結帳號 / 測試）——都只在記憶體，單次使用、有時效、有上限
//! （`start` 是公開的，不能讓人灌爆記憶體）。每一次登入綁一個 HttpOnly cookie（名字帶 state 的前幾碼，兩個分頁同時
//! 登入不會互蓋）：callback 與兌換票券都要同一個瀏覽器帶著它，別人把 callback 網址丟給你也登不進他的帳號（login CSRF）。
//!
//! Pending OIDC sign-ins, one-time tickets and what a sign-in is for (link an account / test) — memory only, single
//! use, with a TTL and a cap (`start` is public). Each sign-in is bound to an HttpOnly cookie named after the start of
//! its state (two tabs don't clobber each other): the callback and the ticket redemption need the same browser, so a
//! callback URL handed to someone else signs nobody in (login CSRF).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

/// 進行中的登入可以等多久（使用者在身分提供者那邊打密碼、做 MFA）。/ How long a sign-in may take at the provider.
pub const PENDING_TTL: Duration = Duration::from_secs(10 * 60);
/// 票券、意圖要多快用掉。/ How soon a ticket or an intent must be used.
pub const TICKET_TTL: Duration = Duration::from_secs(2 * 60);
/// 每一種最多存幾筆（超過就丟最舊的）。/ At most this many of each (the oldest go first).
pub const CAP: usize = 5000;

/// 綁定 cookie 的名字前綴。/ The binding cookie's name prefix.
pub const COOKIE_PREFIX: &str = "telepy_oidc_";

/// 這次登入要做什麼。/ What a sign-in is for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Purpose {
    Login,
    /// 已登入的人把這個身分提供者的帳號連到自己。/ A signed-in person links their account at this provider.
    Link { user_id: i64 },
    /// 管理員試登入：只看拿到什麼 claim，不建帳號、不登入。/ An admin's test: see the claims, sign nobody in.
    Test { user_id: i64 },
}

#[derive(Debug, Clone)]
pub struct Pending {
    pub provider_id: i64,
    pub slug: String,
    pub nonce: String,
    pub verifier: String,
    pub next: Option<String>,
    pub purpose: Purpose,
    /// start 時用的 redirect_uri（換 code 時必須一字不差）。/ The redirect_uri sent at start (the exchange repeats it).
    pub redirect_uri: String,
    /// 綁定 cookie 值的 SHA-256。/ SHA-256 of the binding cookie's value.
    pub binding: String,
    pub created: Instant,
}

/// callback 之後交給網頁的東西。/ What the callback hands to the web page.
#[derive(Debug, Clone)]
pub enum Outcome {
    /// 跟密碼登入一樣的 JSON（token，或 2FA 挑戰）。/ The same JSON as a password sign-in (tokens or a 2FA challenge).
    Login(serde_json::Value),
    /// 測試登入拿到的 claim（只給那位管理員看）。/ The claims a test sign-in got (for that admin only).
    Test { user_id: i64, claims: serde_json::Value },
}

#[derive(Debug, Clone)]
struct Ticket {
    outcome: Outcome,
    binding: String,
    created: Instant,
}

#[derive(Debug, Clone)]
struct Intent {
    provider_id: i64,
    purpose: Purpose,
    binding: String,
    created: Instant,
}

/// 要先過兩步驟驗證的單一登入：mfa_token → (提供者, id_token)，通過時才掛到新的網頁登入上。
/// An SSO sign-in waiting for the second step: mfa_token → (provider, id_token), attached once it passes.
#[derive(Debug, Clone)]
struct AwaitingMfa {
    provider_id: i64,
    id_token: String,
    created: Instant,
}

#[derive(Default)]
pub struct Flows {
    pending: Mutex<HashMap<String, Pending>>,
    awaiting_mfa: Mutex<HashMap<String, AwaitingMfa>>,
    tickets: Mutex<HashMap<String, Ticket>>,
    intents: Mutex<HashMap<String, Intent>>,
}

pub fn hash(value: &str) -> String {
    Sha256::digest(value.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// 綁定 cookie 的名字：前綴 + state 的前 16 碼（state 是 base64url，可以放進 cookie 名字）。
/// The binding cookie's name: the prefix + the state's first 16 characters (base64url is cookie-name safe).
pub fn cookie_name(state: &str) -> String {
    format!("{COOKIE_PREFIX}{}", state.chars().take(16).collect::<String>())
}

/// 票券 / 意圖的綁定 cookie 名字（`t_` / `i_` 開頭，跟 state 的分開）。/ Binding cookies of tickets / intents.
pub fn ticket_cookie(id: &str) -> String {
    cookie_name(&format!("t_{id}"))
}

pub fn intent_cookie(id: &str) -> String {
    cookie_name(&format!("i_{id}"))
}

/// 從 Cookie 標頭讀一個 cookie。/ One cookie from a Cookie header.
pub fn read_cookie(header: Option<&str>, name: &str) -> Option<String> {
    header?.split(';').filter_map(|p| p.trim().split_once('=')).find(|(k, _)| *k == name).map(|(_, v)| v.trim().to_string())
}

fn prune<V>(map: &mut HashMap<String, V>, ttl: Duration, created: impl Fn(&V) -> Instant) {
    map.retain(|_, v| created(v).elapsed() < ttl);
    if map.len() >= CAP {
        if let Some(oldest) = map.iter().min_by_key(|(_, v)| created(v)).map(|(k, _)| k.clone()) {
            map.remove(&oldest);
        }
    }
}

impl Flows {
    pub fn put_pending(&self, state: String, p: Pending) {
        let mut m = self.pending.lock().unwrap();
        prune(&mut m, PENDING_TTL, |v| v.created);
        m.insert(state, p);
    }

    /// 拿走（單次）。過期的當作沒有。/ Take it (once). An expired one counts as missing.
    pub fn take_pending(&self, state: &str) -> Option<Pending> {
        let p = self.pending.lock().unwrap().remove(state)?;
        (p.created.elapsed() < PENDING_TTL).then_some(p)
    }

    /// 存一張票券，回它的代號。/ Store a ticket; returns its id.
    pub fn put_ticket(&self, outcome: Outcome, binding: String) -> String {
        let id = super::random_token(24);
        let mut m = self.tickets.lock().unwrap();
        prune(&mut m, TICKET_TTL, |v| v.created);
        m.insert(id.clone(), Ticket { outcome, binding, created: Instant::now() });
        id
    }

    /// 兌換票券：同一個瀏覽器（綁定的雜湊對得上）才給，給了就沒了。綁定對不上時票券不作廢（不讓別人拿來亂試）。
    /// Redeem a ticket: only for the same browser (binding hash), once. A wrong binding doesn't burn the ticket.
    pub fn take_ticket(&self, id: &str, binding: &str) -> Option<Outcome> {
        let mut m = self.tickets.lock().unwrap();
        let t = m.get(id)?;
        if t.created.elapsed() >= TICKET_TTL {
            m.remove(id);
            return None;
        }
        if t.binding != binding {
            return None;
        }
        m.remove(id).map(|t| t.outcome)
    }

    /// 已登入的人要連結 / 測試：先存意圖（綁定建立它的瀏覽器），再整頁導向 start。
    /// A signed-in person's link / test: store the intent (bound to the browser that made it), then navigate to start.
    pub fn put_intent(&self, provider_id: i64, purpose: Purpose, binding: String) -> String {
        let id = super::random_token(24);
        let mut m = self.intents.lock().unwrap();
        prune(&mut m, TICKET_TTL, |v| v.created);
        m.insert(id.clone(), Intent { provider_id, purpose, binding, created: Instant::now() });
        id
    }

    /// 拿走意圖：同一個身分提供者、同一個瀏覽器（別人丟來的連結網址連不到他的帳號）。
    /// Take an intent: same provider, same browser (a link URL sent by someone else links nothing to their account).
    pub fn take_intent(&self, id: &str, provider_id: i64, binding: &str) -> Option<Purpose> {
        let mut m = self.intents.lock().unwrap();
        let i = m.get(id)?;
        if i.binding != binding {
            return None;
        }
        let i = m.remove(id)?;
        (i.provider_id == provider_id && i.created.elapsed() < TICKET_TTL).then_some(i.purpose)
    }

    pub fn put_awaiting_mfa(&self, mfa_token: String, provider_id: i64, id_token: String) {
        let mut m = self.awaiting_mfa.lock().unwrap();
        prune(&mut m, PENDING_TTL, |v| v.created);
        m.insert(mfa_token, AwaitingMfa { provider_id, id_token, created: Instant::now() });
    }

    /// (provider_id, id_token)；過期的當作沒有。/ (provider id, id_token); an expired one counts as missing.
    pub fn take_awaiting_mfa(&self, mfa_token: &str) -> Option<(i64, String)> {
        let a = self.awaiting_mfa.lock().unwrap().remove(mfa_token)?;
        (a.created.elapsed() < PENDING_TTL).then_some((a.provider_id, a.id_token))
    }

    /// 測試用：有幾筆進行中。/ For tests: how many are pending.
    pub fn pending_len(&self) -> usize {
        self.pending.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(binding: &str) -> Pending {
        Pending { provider_id: 1, slug: "okta".into(), nonce: "n".into(), verifier: "v".into(), next: None, purpose: Purpose::Login, redirect_uri: "https://t/cb".into(), binding: hash(binding), created: Instant::now() }
    }

    #[test]
    fn everything_is_single_use_and_bound_to_its_browser() {
        let f = Flows::default();
        f.put_pending("state-1".into(), pending("b1"));
        assert!(f.take_pending("state-1").is_some());
        assert!(f.take_pending("state-1").is_none(), "single use");
        let t = f.put_ticket(Outcome::Login(serde_json::json!({"access": "x"})), hash("b1"));
        assert!(f.take_ticket(&t, &hash("someone else")).is_none(), "another browser");
        assert!(f.take_ticket(&t, &hash("b1")).is_some(), "a wrong binding didn't burn it");
        assert!(f.take_ticket(&t, &hash("b1")).is_none(), "single use");
        let i = f.put_intent(7, Purpose::Link { user_id: 3 }, hash("me"));
        assert_eq!(f.take_intent(&i, 8, &hash("me")), None, "another provider");
        let i = f.put_intent(7, Purpose::Test { user_id: 3 }, hash("me"));
        assert_eq!(f.take_intent(&i, 7, &hash("victim")), None, "another browser");
        assert_eq!(f.take_intent(&i, 7, &hash("me")), Some(Purpose::Test { user_id: 3 }));
    }

    #[test]
    fn expired_entries_are_gone_and_the_store_is_capped() {
        let f = Flows::default();
        let mut old = pending("b");
        old.created = Instant::now() - PENDING_TTL - Duration::from_secs(1);
        f.put_pending("old".into(), old);
        assert!(f.take_pending("old").is_none(), "expired");
        for i in 0..CAP + 10 {
            f.put_pending(format!("s{i}"), pending("b"));
        }
        assert!(f.pending_len() <= CAP);
    }

    #[test]
    fn cookies_are_read_by_name() {
        assert_eq!(cookie_name("abcdefghijklmnopqrstuvwxyz"), "telepy_oidc_abcdefghijklmnop");
        let h = "theme=dark; telepy_oidc_abc=v1; other=2";
        assert_eq!(read_cookie(Some(h), "telepy_oidc_abc").as_deref(), Some("v1"));
        assert_eq!(read_cookie(Some(h), "telepy_oidc_x"), None);
        assert_eq!(read_cookie(None, "a"), None);
    }
}
