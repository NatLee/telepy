//! 推播的內容與目的地（純函式）：哪些事件推、推什麼（標題 = App 名稱、內文 = webhook 那套三語句子、`tag` 跟網頁的桌面
//! 通知一樣所以同一件事只留一則）、指令內容藏不藏，以及訂閱網址只收認得的推播服務（Google / Apple / Mozilla /
//! Microsoft）——網址是瀏覽器給、經過我們的 API 存起來的，不限制的話任何人都能叫伺服器去連內網（SSRF）。
//! What a push says and where it may go (pure): which events are pushed, the message (title = the app name, body =
//! the webhooks' three-language sentence, a `tag` equal to the web's desktop notification so one event leaves one
//! notification), whether the command is hidden, and subscription URLs limited to known push services (Google /
//! Apple / Mozilla / Microsoft) — the URL comes from the browser through our API, so without a limit anyone could
//! make the server connect into the internal network (SSRF).

use serde_json::{json, Value};

use crate::notify_prefs::{channels, Channel};
use crate::webhooks::text::{sentence, Lang};
use crate::webhooks::{Kind, TunnelRef};

/// 認得的推播服務（主機名稱本身或它的子網域）。Chrome 的網址不只 `fcm.googleapis.com`，新一點的是 `jmt17.google.com`
/// 這類，所以收 Google 自己的兩個網域。/ Known push services (the host or a subdomain). Chrome's endpoints are not only
/// `fcm.googleapis.com`; newer ones look like `jmt17.google.com`, so Google's own two domains are accepted.
const SERVICES: &[(&str, &str)] = &[
    ("googleapis.com", "google"),
    ("google.com", "google"),
    ("push.apple.com", "apple"),
    ("push.services.mozilla.com", "mozilla"),
    ("notify.windows.com", "microsoft"),
];

pub const ENDPOINT_MAX: usize = 1024;

/// 訂閱網址：https、沒有帳密、預設埠，主機是認得的推播服務。/ A subscription URL: https, no credentials, default port, a known push service.
pub fn check_endpoint(s: &str) -> Result<url::Url, &'static str> {
    if s.len() > ENDPOINT_MAX {
        return Err("The subscription URL is too long.");
    }
    let u = url::Url::parse(s).map_err(|_| "The subscription URL is not a URL.")?;
    if u.scheme() != "https" || !u.username().is_empty() || u.password().is_some() || u.port().is_some_and(|p| p != 443) {
        return Err("The subscription URL must be a plain https:// address.");
    }
    if service_of(&u).is_none() {
        return Err("This browser's push service isn't one Telepy knows (Google, Apple, Mozilla or Microsoft).");
    }
    Ok(u)
}

/// 推播服務的名字（說明圖用）。/ The push service's name (for the diagram).
pub fn service_of(u: &url::Url) -> Option<&'static str> {
    let host = u.host_str()?.to_ascii_lowercase();
    SERVICES.iter().find(|(suffix, _)| host == *suffix || host.ends_with(&format!(".{suffix}"))).map(|(_, name)| *name)
}

/// 會推播的事件：有「桌面通知」這個管道、而且不是上線 / 離線這類狀態（狀態要有延遲與上限，下一步再接）。
/// Pushed events: those with a desktop channel, except the status ones (they need a delay and limits; next step).
pub fn pushed(kind: Kind) -> bool {
    channels(kind).contains(&Channel::Desktop) && !kind.is_status()
}

#[derive(Debug, Clone, PartialEq)]
pub struct Notice {
    pub title: String,
    pub body: String,
    /// 同一件事同一個 tag：新的取代舊的，也跟網頁自己跳的桌面通知對上。/ One tag per thing: replaces, and matches the page's own.
    pub tag: String,
    /// 點下去打開的頁面。/ The page a click opens.
    pub path: String,
    pub urgent: bool,
    /// 推播服務最多替我們留多久（秒）。/ How long the push service may hold it (seconds).
    pub ttl: u32,
}

impl Notice {
    pub fn payload(&self) -> Vec<u8> {
        json!({ "title": self.title, "body": self.body, "tag": self.tag, "path": self.path }).to_string().into_bytes()
    }
    /// `Topic`：推播服務只留同一個 topic 最新的那則（base64url 字元、≤ 32）。/ The `Topic` header: the push service keeps only the latest per topic.
    pub fn topic(&self) -> String {
        self.tag.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(32).collect()
    }
}

fn s<'a>(d: &'a Value, k: &str) -> &'a str {
    d.get(k).and_then(Value::as_str).unwrap_or("")
}

/// 一件事的推播；不推的事件 = None。`details` = 這台裝置要不要看到指令內容。
/// The push for one event; None for events that are not pushed. `details` = whether this device shows the command.
pub fn notice(kind: Kind, lang: Lang, tunnel: Option<&TunnelRef>, data: &Value, link: Option<&str>, details: bool, app_name: &str) -> Option<Notice> {
    if !pushed(kind) {
        return None;
    }
    let tid = tunnel.map(|t| t.id).unwrap_or(0);
    let tag = match kind {
        Kind::CommandApprovalRequested => format!("command-{}", data.get("request_id").and_then(Value::as_i64).unwrap_or(0)),
        Kind::TunnelIpChanged => format!("ip-{tid}"),
        Kind::TunnelHostKeyChanged => format!("hostkey-{tid}"),
        Kind::DeviceClaimAttempt => format!("claim-{tid}"),
        Kind::DeviceWarning => format!("warning-{tid}"),
        Kind::ShareReceived | Kind::ShareEnded => format!("share-{tid}"),
        Kind::AccessRequested | Kind::AccessDecided => format!("access-{tid}"),
        Kind::McpSessionOpened | Kind::McpSessionClosed => format!("ai-{tid}"),
        Kind::SessionWatched => format!("watch-{tid}"),
        Kind::AccountSignInNewDevice => "sign-in".to_string(),
        other => other.name().to_string(),
    };
    let body = if kind == Kind::CommandApprovalRequested && !details { hidden_command(lang, tunnel, data) } else { sentence(kind, lang, tunnel, data) };
    let urgent = matches!(kind, Kind::CommandApprovalRequested | Kind::AccountSignInNewDevice | Kind::DeviceClaimAttempt | Kind::TunnelHostKeyChanged);
    Some(Notice {
        title: app_name.to_string(),
        body,
        tag,
        path: link.filter(|l| l.starts_with('/') && !l.starts_with("//")).unwrap_or("/tunnels").to_string(),
        urgent,
        // 等核准的指令過幾分鐘就失效，晚到沒有用。/ A pending command expires within minutes; a late one is useless.
        ttl: if kind == Kind::CommandApprovalRequested { 600 } else { 86_400 },
    })
}

/// 不寫指令內容的核准請求（鎖定畫面別人看得到）。/ An approval request without the command (lock screens are visible).
fn hidden_command(lang: Lang, tunnel: Option<&TunnelRef>, d: &Value) -> String {
    let (by, t) = (s(d, "by"), tunnel.map(|t| t.name.as_str()).unwrap_or(""));
    match lang {
        Lang::En => format!("{by} wants to run a command on {t}. Open Telepy to see it."),
        Lang::ZhTw => format!("{by} 想在 {t} 上執行一個指令，打開 Telepy 查看。"),
        Lang::Ja => format!("{by} が {t} でコマンドを実行しようとしています。内容は Telepy で確認できます。"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t() -> TunnelRef {
        TunnelRef { id: 7, name: "lab-pi".into(), reverse_port: 2201 }
    }

    #[test]
    fn only_known_push_services_over_https() {
        for ok in [
            "https://fcm.googleapis.com/fcm/send/abc",
            "https://jmt17.google.com/fcm/send/dUcUa2VuvA",
            "https://web.push.apple.com/QGx",
            "https://updates.push.services.mozilla.com/wpush/v2/gAAA",
            "https://wns2-par02p.notify.windows.com/w/?token=x",
            "https://fcm.googleapis.com:443/x",
        ] {
            assert!(check_endpoint(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://fcm.googleapis.com/x",
            "https://evilfcm.googleapis.com.attacker.example/x",
            "https://notgoogle.com/x",
            "https://google.com.attacker.example/x",
            "https://notfcm.googleapis.com.example/x",
            "https://127.0.0.1/x",
            "https://user:pw@fcm.googleapis.com/x",
            "https://fcm.googleapis.com:8443/x",
            "https://example.com/push",
            "not a url",
        ] {
            assert!(check_endpoint(bad).is_err(), "{bad}");
        }
        assert!(check_endpoint(&format!("https://fcm.googleapis.com/{}", "a".repeat(ENDPOINT_MAX))).is_err());
        assert_eq!(service_of(&url::Url::parse("https://web.push.apple.com/x").unwrap()), Some("apple"));
    }

    #[test]
    fn status_events_wait_for_their_delay_and_limits() {
        assert!(pushed(Kind::CommandApprovalRequested));
        assert!(pushed(Kind::AccountSignInNewDevice));
        assert!(pushed(Kind::TunnelIpChanged));
        assert!(!pushed(Kind::TunnelOffline), "status events come with their own delay");
        assert!(!pushed(Kind::TunnelDegraded));
        assert!(!pushed(Kind::UserCreated), "no in-app notification, no push");
    }

    #[test]
    fn the_command_stays_off_the_lock_screen_unless_this_device_wants_it() {
        let d = json!({ "request_id": 42, "by": "alice", "account": "root", "command": "rm -rf /tmp/x" });
        let hidden = notice(Kind::CommandApprovalRequested, Lang::En, Some(&t()), &d, Some("/tunnels/commands?tunnel=7"), false, "Lab").unwrap();
        assert_eq!(hidden.title, "Lab");
        assert_eq!(hidden.body, "alice wants to run a command on lab-pi. Open Telepy to see it.");
        assert!(!hidden.body.contains("rm -rf"));
        assert_eq!((hidden.tag.as_str(), hidden.path.as_str(), hidden.urgent, hidden.ttl), ("command-42", "/tunnels/commands?tunnel=7", true, 600));
        let shown = notice(Kind::CommandApprovalRequested, Lang::ZhTw, Some(&t()), &d, None, true, "Lab").unwrap();
        assert!(shown.body.contains("rm -rf /tmp/x"), "{}", shown.body);
        assert_eq!(shown.path, "/tunnels");
        let ja = notice(Kind::CommandApprovalRequested, Lang::Ja, Some(&t()), &d, None, false, "Lab").unwrap();
        assert!(!ja.body.contains("rm -rf") && ja.body.contains("alice"));
    }

    #[test]
    fn tags_match_the_pages_own_desktop_notifications() {
        let tag = |k: Kind| notice(k, Lang::En, Some(&t()), &json!({}), None, true, "Telepy").unwrap().tag;
        assert_eq!(tag(Kind::TunnelIpChanged), "ip-7");
        assert_eq!(tag(Kind::TunnelHostKeyChanged), "hostkey-7");
        assert_eq!(tag(Kind::ShareEnded), "share-7");
        assert_eq!(tag(Kind::McpSessionOpened), "ai-7");
        assert_eq!(tag(Kind::SessionWatched), "watch-7");
        assert_eq!(notice(Kind::AccountSignInNewDevice, Lang::En, None, &json!({}), None, true, "Telepy").unwrap().tag, "sign-in");
        assert!(notice(Kind::TunnelOffline, Lang::En, Some(&t()), &json!({}), None, true, "Telepy").is_none());
    }

    #[test]
    fn the_payload_fits_and_links_stay_on_this_site() {
        let d = json!({ "by": "alice", "command": "x".repeat(4000), "request_id": 1 });
        let n = notice(Kind::CommandApprovalRequested, Lang::En, Some(&t()), &d, Some("//evil.example/x"), true, "Telepy").unwrap();
        assert_eq!(n.path, "/tunnels", "a protocol-relative link is not followed");
        assert!(n.payload().len() <= crate::push::crypto::PLAINTEXT_MAX, "the webhook sentence clips long commands");
        assert_eq!(Notice { tag: "command-12 é!".into(), ..n }.topic(), "command-12");
    }
}
