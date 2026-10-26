//! 每種接收端要的格式：Slack（Mattermost / Rocket.Chat 也吃）、Discord、Google Chat、Microsoft Teams（Workflows）、
//! Telegram、ntfy，以及 Telepy 自己的完整 JSON。`auto` 依網址判斷，認不出來就送 JSON（裡面也有 `text`）。
//! 名稱、指令這些是使用者打的字：Slack 跳脫 `& < >`、Discord 關掉 mention、Google Chat 讓 `<users/all>` 失效，
//! 所以 webhook 不能被拿來 @所有人。
//! The body each receiver expects. `auto` picks one from the URL and falls back to Telepy's JSON (which has `text`
//! too). Names and commands are user input, so mentions are neutralised per service.

use serde_json::{json, Value};

use super::catalog::{Kind, Severity};
use super::TunnelRef;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Auto,
    Json,
    Slack,
    Discord,
    GoogleChat,
    Teams,
    Telegram,
    Ntfy,
}

impl Format {
    pub const ALL: &'static [Format] = &[Format::Auto, Format::Json, Format::Slack, Format::Discord, Format::GoogleChat, Format::Teams, Format::Telegram, Format::Ntfy];

    pub fn as_str(self) -> &'static str {
        match self {
            Format::Auto => "auto",
            Format::Json => "json",
            Format::Slack => "slack",
            Format::Discord => "discord",
            Format::GoogleChat => "google_chat",
            Format::Teams => "teams",
            Format::Telegram => "telegram",
            Format::Ntfy => "ntfy",
        }
    }

    pub fn parse(s: &str) -> Option<Format> {
        Self::ALL.iter().copied().find(|f| f.as_str() == s)
    }

    /// `auto` → 依網址判斷的格式；其他原樣。/ `auto` becomes the detected format.
    pub fn resolve(self, url: &url::Url) -> Format {
        match self {
            Format::Auto => detect(url),
            f => f,
        }
    }
}

/// 從網址認出服務。/ Recognise the service from the URL.
pub fn detect(url: &url::Url) -> Format {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let path = url.path();
    let is = |domain: &str| host == domain || host.ends_with(&format!(".{domain}"));
    if is("hooks.slack.com") {
        Format::Slack
    } else if (is("discord.com") || is("discordapp.com")) && path.starts_with("/api/webhooks/") {
        Format::Discord
    } else if host == "chat.googleapis.com" {
        Format::GoogleChat
    } else if is("webhook.office.com") || is("logic.azure.com") || is("powerplatform.com") || is("powerautomate.com") {
        Format::Teams
    } else if host == "api.telegram.org" {
        Format::Telegram
    } else if host == "ntfy.sh" || host.starts_with("ntfy.") {
        Format::Ntfy
    } else {
        Format::Json
    }
}

/// 一則要送出的訊息（句子已經依 webhook 的語言組好）。/ One message, the sentence already in the webhook's language.
pub struct Message<'a> {
    pub id: &'a str,
    pub kind: Kind,
    pub at: &'a str,
    pub title: &'a str,
    pub text: &'a str,
    pub server: Option<&'a str>,
    pub link: Option<&'a str>,
    pub link_label: &'a str,
    pub tunnel: Option<&'a TunnelRef>,
    pub data: &'a Value,
}

pub struct Rendered {
    pub body: Vec<u8>,
    pub content_type: &'static str,
    /// 加在網址後面的參數（ntfy 的標題、優先順序…）。/ Query parameters to add (ntfy's title, priority, …).
    pub query: Vec<(&'static str, String)>,
}

/// 聊天訊息的長度上限（Discord 2000 字）。/ Keep chat messages well under Discord's 2000 characters.
const CHAT_MAX: usize = 1500;

fn clip(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

fn severity_str(s: Severity) -> &'static str {
    match s {
        Severity::Info => "info",
        Severity::Ok => "ok",
        Severity::Warning => "warning",
    }
}

fn slack_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Google Chat 的 `<users/all>` 這類語法：在 `<` 後面插一個零寬空白讓它失效。/ Defuse Google Chat's `<…>` syntax.
fn gchat_defuse(s: &str) -> String {
    s.replace('<', "<\u{200B}")
}

fn json_body(v: &Value) -> Vec<u8> {
    serde_json::to_vec(v).unwrap_or_default()
}

pub fn render(format: Format, m: &Message) -> Rendered {
    let text = clip(m.text, CHAT_MAX);
    let json_ct = "application/json";
    match format {
        Format::Auto | Format::Json => Rendered {
            body: json_body(&json!({
                "id": m.id,
                "event": m.kind.name(),
                "title": m.title,
                "severity": severity_str(m.kind.severity()),
                "at": m.at,
                "text": format!("[Telepy] {}", m.text),
                "server": m.server,
                "url": m.link,
                "tunnel": m.tunnel.map(|t| json!({ "id": t.id, "name": t.name, "reverse_port": t.reverse_port })),
                "data": m.data,
            })),
            content_type: json_ct,
            query: Vec::new(),
        },
        Format::Slack => {
            let mut s = format!("[Telepy] {}", slack_escape(&text));
            if let Some(link) = m.link {
                s.push_str(&format!(" <{link}|{}>", slack_escape(m.link_label)));
            }
            Rendered { body: json_body(&json!({ "text": s })), content_type: json_ct, query: Vec::new() }
        }
        Format::Discord => {
            let mut s = format!("**[Telepy]** {text}");
            if let Some(link) = m.link {
                s.push_str(&format!("\n[{}](<{link}>)", m.link_label));
            }
            Rendered { body: json_body(&json!({ "content": s, "allowed_mentions": { "parse": [] } })), content_type: json_ct, query: Vec::new() }
        }
        Format::GoogleChat => {
            let mut s = format!("*[Telepy]* {}", gchat_defuse(&text));
            if let Some(link) = m.link {
                s.push_str(&format!(" <{link}|{}>", gchat_defuse(m.link_label)));
            }
            Rendered { body: json_body(&json!({ "text": s })), content_type: json_ct, query: Vec::new() }
        }
        Format::Teams => {
            let colour = match m.kind.severity() {
                Severity::Warning => "Warning",
                Severity::Ok => "Good",
                Severity::Info => "Default",
            };
            let mut card = json!({
                "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                "type": "AdaptiveCard",
                "version": "1.4",
                "body": [
                    { "type": "TextBlock", "text": format!("Telepy · {}", m.title), "weight": "Bolder", "color": colour, "wrap": true },
                    { "type": "TextBlock", "text": text, "wrap": true },
                ],
            });
            if let Some(link) = m.link {
                card["actions"] = json!([{ "type": "Action.OpenUrl", "title": m.link_label, "url": link }]);
            }
            Rendered {
                body: json_body(&json!({ "type": "message", "attachments": [{ "contentType": "application/vnd.microsoft.card.adaptive", "contentUrl": null, "content": card }] })),
                content_type: json_ct,
                query: Vec::new(),
            }
        }
        Format::Telegram => {
            let mut s = format!("[Telepy] {text}");
            if let Some(link) = m.link {
                s.push_str(&format!("\n{link}"));
            }
            Rendered { body: json_body(&json!({ "text": s, "disable_web_page_preview": true })), content_type: json_ct, query: Vec::new() }
        }
        Format::Ntfy => {
            let (tag, priority) = match m.kind.severity() {
                Severity::Warning => ("warning", "4"),
                Severity::Ok => ("white_check_mark", "3"),
                Severity::Info => ("information_source", "3"),
            };
            let mut query = vec![("title", format!("Telepy: {}", m.title)), ("tags", tag.to_string()), ("priority", priority.to_string())];
            if let Some(link) = m.link {
                query.push(("click", link.to_string()));
            }
            Rendered { body: text.into_bytes(), content_type: "text/plain; charset=utf-8", query }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> url::Url {
        url::Url::parse(s).unwrap()
    }

    #[test]
    fn detects_services() {
        assert_eq!(detect(&u("https://hooks.slack.com/services/T0/B0/x")), Format::Slack);
        assert_eq!(detect(&u("https://discord.com/api/webhooks/1/abc")), Format::Discord);
        assert_eq!(detect(&u("https://ptb.discord.com/api/webhooks/1/abc")), Format::Discord);
        assert_eq!(detect(&u("https://discord.com/channels/1")), Format::Json, "not a webhook path");
        assert_eq!(detect(&u("https://chat.googleapis.com/v1/spaces/X/messages?key=k")), Format::GoogleChat);
        assert_eq!(detect(&u("https://prod-01.westus.logic.azure.com/workflows/x")), Format::Teams);
        assert_eq!(detect(&u("https://api.telegram.org/bot1:x/sendMessage?chat_id=1")), Format::Telegram);
        assert_eq!(detect(&u("https://ntfy.sh/my-topic")), Format::Ntfy);
        assert_eq!(detect(&u("https://ntfy.example.org/alerts")), Format::Ntfy);
        assert_eq!(detect(&u("https://example.com/hook")), Format::Json);
        assert_eq!(detect(&u("https://evilhooks.slack.com.example.com/x")), Format::Json);
        assert_eq!(Format::Auto.resolve(&u("https://hooks.slack.com/x")), Format::Slack);
        assert_eq!(Format::Discord.resolve(&u("https://example.com")), Format::Discord);
    }

    fn msg<'a>(text: &'a str, data: &'a Value, tunnel: Option<&'a TunnelRef>) -> Message<'a> {
        Message {
            id: "msg_1",
            kind: Kind::TunnelOffline,
            at: "2026-10-26T00:00:00Z",
            title: "Tunnel offline",
            text,
            server: Some("https://telepy.example"),
            link: Some("https://telepy.example/tunnels"),
            link_label: "Open in Telepy",
            tunnel,
            data,
        }
    }

    fn body(r: &Rendered) -> Value {
        serde_json::from_slice(&r.body).unwrap()
    }

    #[test]
    fn json_has_everything() {
        let t = TunnelRef { id: 4, name: "office-pi".into(), reverse_port: 1025 };
        let data = json!({"x": 1});
        let v = body(&render(Format::Json, &msg("office-pi is offline", &data, Some(&t))));
        assert_eq!(v["event"], "tunnel.offline");
        assert_eq!(v["severity"], "warning");
        assert_eq!(v["text"], "[Telepy] office-pi is offline");
        assert_eq!(v["tunnel"]["reverse_port"], 1025);
        assert_eq!(v["data"]["x"], 1);
        assert_eq!(v["id"], "msg_1");
    }

    #[test]
    fn mentions_are_neutralised() {
        let data = json!({});
        let slack = body(&render(Format::Slack, &msg("<!channel> & co", &data, None)));
        assert!(slack["text"].as_str().unwrap().starts_with("[Telepy] &lt;!channel&gt; &amp; co <https://telepy.example/tunnels|Open in Telepy>"));
        let discord = body(&render(Format::Discord, &msg("@everyone", &data, None)));
        assert_eq!(discord["allowed_mentions"]["parse"], json!([]));
        let gchat = body(&render(Format::GoogleChat, &msg("<users/all>", &data, None)));
        assert!(!gchat["text"].as_str().unwrap().contains("<users/all>"));
    }

    #[test]
    fn ntfy_is_plain_text_with_query() {
        let data = json!({});
        let r = render(Format::Ntfy, &msg("office-pi is offline", &data, None));
        assert_eq!(r.content_type, "text/plain; charset=utf-8");
        assert_eq!(r.body, b"office-pi is offline");
        assert!(r.query.contains(&("priority", "4".into())));
        assert!(r.query.contains(&("click", "https://telepy.example/tunnels".into())));
    }

    #[test]
    fn teams_is_an_adaptive_card() {
        let data = json!({});
        let v = body(&render(Format::Teams, &msg("hello", &data, None)));
        assert_eq!(v["type"], "message");
        let card = &v["attachments"][0]["content"];
        assert_eq!(card["type"], "AdaptiveCard");
        assert_eq!(card["body"][1]["text"], "hello");
        assert_eq!(card["actions"][0]["url"], "https://telepy.example/tunnels");
    }

    #[test]
    fn long_text_is_clipped_for_chat() {
        let data = json!({});
        let long = "x".repeat(5000);
        let v = body(&render(Format::Discord, &msg(&long, &data, None)));
        assert!(v["content"].as_str().unwrap().chars().count() < 2000);
        let full = body(&render(Format::Json, &msg(&long, &data, None)));
        assert!(full["text"].as_str().unwrap().len() > 5000, "JSON keeps the whole text");
    }
}
