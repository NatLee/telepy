//! webhook 訊息的句子：依每個 webhook 選的語言（English / 繁體中文 / 日本語）從事件的結構化欄位組出來。
//! 這些訊息直接進 Slack / Discord…，沒有前端可以翻譯，所以在這裡做。純函式，欄位缺了就留空白，不會失敗。
//! Webhook sentences in the webhook's language, built from the event's structured fields. Messages go straight
//! into chat apps with no frontend to translate them, so it happens here. Pure; missing fields render empty.

use serde_json::Value;

use super::catalog::Kind;
use super::TunnelRef;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    ZhTw,
    Ja,
}

impl Lang {
    pub const ALL: &'static [Lang] = &[Lang::En, Lang::ZhTw, Lang::Ja];

    pub fn as_str(self) -> &'static str {
        match self {
            Lang::En => "en",
            Lang::ZhTw => "zh-TW",
            Lang::Ja => "ja",
        }
    }

    pub fn parse(s: &str) -> Option<Lang> {
        Self::ALL.iter().copied().find(|l| l.as_str() == s)
    }

    /// 使用者的介面語言（`auto` / 沒設 → English）。/ From a UI language preference.
    pub fn from_pref(s: Option<&str>) -> Lang {
        s.and_then(Lang::parse).unwrap_or(Lang::En)
    }

    /// 「在 Telepy 打開」連結的字。/ The link label.
    pub fn open_label(self) -> &'static str {
        match self {
            Lang::En => "Open in Telepy",
            Lang::ZhTw => "在 Telepy 開啟",
            Lang::Ja => "Telepy で開く",
        }
    }
}

fn s<'a>(data: &'a Value, key: &str) -> &'a str {
    data.get(key).and_then(Value::as_str).unwrap_or("")
}

fn tri(lang: Lang, en: String, zh: String, ja: String) -> String {
    match lang {
        Lang::En => en,
        Lang::ZhTw => zh,
        Lang::Ja => ja,
    }
}

/// 指令只取一行、最多 120 字。/ One line of a command, at most 120 characters.
fn cmd(data: &Value) -> String {
    let one = s(data, "command").replace('\n', " ⏎ ");
    match one.char_indices().nth(120) {
        Some((i, _)) => format!("{}…", &one[..i]),
        None => one,
    }
}

/// 登入方式與失敗原因的說法（不認得的照原樣）。/ Sign-in methods and failure reasons in words (unknown ones as they are).
fn sign_in_word(lang: Lang, code: &str) -> String {
    let (en, zh, ja) = match code {
        "password" => ("password", "密碼", "パスワード"),
        "google" => ("Google", "Google", "Google"),
        "passkey" => ("passkey", "passkey", "パスキー"),
        "bad_password" => ("wrong password", "密碼錯誤", "パスワードが違います"),
        "mfa_failed" => ("wrong second factor", "第二步驟驗證錯誤", "2 段階目の認証に失敗"),
        "inactive" => ("account disabled", "帳號已停用", "アカウントが無効"),
        "google_account_conflict" => ("username taken by a password account", "帳號名稱已被密碼帳號使用", "ユーザー名がパスワードのアカウントと重複"),
        other => (other, other, other),
    };
    tri(lang, en.to_string(), zh.to_string(), ja.to_string())
}

/// 短標題（ntfy 標題、Teams 卡片標題、JSON 的 `title`）。/ The short title.
pub fn title(kind: Kind, lang: Lang) -> String {
    let (zh, ja) = match kind {
        Kind::TunnelOffline => ("通道離線", "トンネルがオフライン"),
        Kind::TunnelOnline => ("通道恢復連線", "トンネルが再接続"),
        Kind::TunnelDegraded => ("SSH 沒有回應", "SSH が応答しない"),
        Kind::TunnelRecovered => ("SSH 恢復回應", "SSH が復旧"),
        Kind::TunnelIpChanged => ("裝置換了 IP", "デバイスの IP が変更"),
        Kind::TunnelHostKeyChanged => ("裝置的 host key 變了", "ホストキーが変更"),
        Kind::DeviceClaimAttempt => ("別的帳號想接管裝置", "別アカウントによるデバイスの登録"),
        Kind::ShareReceived => ("有通道分享給你", "トンネルが共有されました"),
        Kind::ShareEnded => ("分享結束", "共有の終了"),
        Kind::AccessRequested => ("存取申請", "アクセス申請"),
        Kind::AccessDecided => ("存取申請有結果了", "アクセス申請の結果"),
        Kind::CommandApprovalRequested => ("指令等待核准", "コマンドの承認待ち"),
        Kind::CommandApprovalDecided => ("指令申請有結果了", "コマンド申請の結果"),
        Kind::CommandBlocked => ("指令被擋下", "コマンドをブロック"),
        Kind::SessionStarted => ("有人開了連線", "セッション開始"),
        Kind::McpSessionOpened => ("MCP agent 開了 session", "MCP エージェントのセッション開始"),
        Kind::McpSessionClosed => ("MCP agent 的 session 關閉", "MCP エージェントのセッション終了"),
        Kind::AccountSignIn => ("新的登入", "新しいサインイン"),
        Kind::AccountSignInFailed => ("登入失敗", "サインイン失敗"),
        Kind::KeyExpiring => ("SSH 金鑰快到期", "SSH 鍵の期限が近い"),
        Kind::KeyExpired => ("SSH 金鑰已到期", "SSH 鍵の期限切れ"),
        Kind::UserCreated => ("新帳號", "新しいアカウント"),
        Kind::Test => ("測試", "テスト"),
    };
    tri(lang, kind.title().to_string(), zh.to_string(), ja.to_string())
}

fn session_what(lang: Lang, kind: &str, account: &str) -> String {
    let acc = |en: &str, zh: &str, ja: &str| -> String {
        if account.is_empty() {
            tri(lang, en.to_string(), zh.to_string(), ja.to_string())
        } else {
            tri(lang, format!("{en} as {account}"), format!("{zh}（帳號 {account}）"), format!("{ja}（アカウント {account}）"))
        }
    };
    match kind {
        "terminal" => acc("a web terminal", "網頁終端機", "Web ターミナル"),
        "lan_terminal" => acc("a terminal to a LAN host", "到區網主機的終端機", "LAN ホストへのターミナル"),
        "files" => acc("the file manager", "檔案管理", "ファイルマネージャー"),
        "browser" => acc("a remote browser", "遠端瀏覽器", "リモートブラウザー"),
        "desktop" => acc("a remote desktop", "遠端桌面", "リモートデスクトップ"),
        "rustdesk" => acc("a RustDesk session", "RustDesk 連線", "RustDesk セッション"),
        other => acc(other, other, other),
    }
}

/// 事件的完整句子。/ The event's sentence.
pub fn sentence(kind: Kind, lang: Lang, tunnel: Option<&TunnelRef>, d: &Value) -> String {
    let t = tunnel.map(|t| t.name.as_str()).unwrap_or("");
    let port = tunnel.map(|t| t.reverse_port).unwrap_or(0);
    let by = s(d, "by");
    match kind {
        Kind::TunnelOffline => tri(lang, format!("{t} is offline (port {port})"), format!("{t} 離線了（port {port}）"), format!("{t} がオフラインになりました（ポート {port}）")),
        Kind::TunnelOnline => tri(lang, format!("{t} is back online (port {port})"), format!("{t} 恢復連線了（port {port}）"), format!("{t} が再接続しました（ポート {port}）")),
        Kind::TunnelDegraded => tri(
            lang,
            format!("{t} is connected, but its SSH server is not answering (port {port})"),
            format!("{t} 的通道還連著，但 SSH 沒有回應（port {port}）"),
            format!("{t} のトンネルは接続中ですが、SSH が応答しません（ポート {port}）"),
        ),
        Kind::TunnelRecovered => tri(lang, format!("{t} answers SSH again (port {port})"), format!("{t} 的 SSH 恢復回應了（port {port}）"), format!("{t} の SSH が再び応答しています（ポート {port}）")),
        Kind::TunnelIpChanged => {
            let (ip, prev) = (s(d, "ip"), s(d, "previous_ip"));
            tri(lang, format!("{t} connected from a new IP address: {ip} (was {prev})"), format!("{t} 從新的 IP 連上來：{ip}（之前是 {prev}）"), format!("{t} が新しい IP アドレスから接続しました：{ip}（以前は {prev}）"))
        }
        Kind::TunnelHostKeyChanged => {
            let fp = s(d, "fingerprint");
            tri(
                lang,
                format!("{t} presented a different SSH host key ({fp}). Connections are blocked until the owner reviews it."),
                format!("{t} 出示了不同的 SSH host key（{fp}），擁有者確認之前連線都會被擋下。"),
                format!("{t} が別の SSH ホストキー（{fp}）を提示しました。所有者が確認するまで接続はブロックされます。"),
            )
        }
        Kind::DeviceClaimAttempt => {
            let other = s(d, "by_tunnel");
            tri(
                lang,
                format!("Tunnel {other} of {by} pointed at the SSH server of {t} and was refused"),
                format!("{by} 的通道 {other} 指向 {t} 的 SSH 伺服器，已被拒絕"),
                format!("{by} のトンネル {other} が {t} の SSH サーバーを指していたため拒否されました"),
            )
        }
        Kind::ShareReceived => {
            let perm = s(d, "permission").to_uppercase();
            tri(lang, format!("{by} shared {t} with you ({perm})"), format!("{by} 把 {t} 分享給你（{perm}）"), format!("{by} が {t} をあなたと共有しました（{perm}）"))
        }
        Kind::ShareEnded => {
            let user = s(d, "user");
            match s(d, "reason") {
                "left" => tri(lang, format!("{user} left {t}"), format!("{user} 離開了 {t}"), format!("{user} が {t} の共有から抜けました")),
                "expired" => tri(lang, format!("{user}'s access to {t} expired"), format!("{user} 對 {t} 的分享到期了"), format!("{user} の {t} への共有が期限切れになりました")),
                _ => tri(lang, format!("{by} revoked {user}'s access to {t}"), format!("{by} 撤銷了 {user} 對 {t} 的存取"), format!("{by} が {user} の {t} へのアクセスを取り消しました")),
            }
        }
        Kind::AccessRequested => {
            let reason = s(d, "reason");
            let base = tri(lang, format!("{by} asks for more access to {t}"), format!("{by} 申請 {t} 更多的存取權限"), format!("{by} が {t} へのアクセス追加を申請しています"));
            if reason.is_empty() {
                base
            } else {
                format!("{base}: {reason}")
            }
        }
        Kind::AccessDecided => match s(d, "status") {
            "approved" => tri(lang, format!("{by} approved your access request on {t}"), format!("{by} 核准了你在 {t} 的存取申請"), format!("{by} が {t} へのアクセス申請を承認しました")),
            _ => tri(lang, format!("{by} declined your access request on {t}"), format!("{by} 拒絕了你在 {t} 的存取申請"), format!("{by} が {t} へのアクセス申請を却下しました")),
        },
        Kind::CommandApprovalRequested => {
            let (c, account) = (cmd(d), s(d, "account"));
            tri(lang, format!("{by} wants to run `{c}` on {t} as {account}"), format!("{by} 想在 {t} 以 {account} 執行 `{c}`"), format!("{by} が {t} で {account} として `{c}` を実行しようとしています"))
        }
        Kind::CommandApprovalDecided => {
            let c = cmd(d);
            let reason = s(d, "reason");
            let tail = if reason.is_empty() { String::new() } else { format!(": {reason}") };
            match s(d, "status") {
                "approved" => tri(lang, format!("{by} approved your command `{c}` on {t}"), format!("{by} 核准了你在 {t} 的指令 `{c}`"), format!("{by} が {t} でのコマンド `{c}` を承認しました")),
                "denied" => tri(lang, format!("{by} denied your command `{c}` on {t}{tail}"), format!("{by} 拒絕了你在 {t} 的指令 `{c}`{tail}"), format!("{by} が {t} でのコマンド `{c}` を却下しました{tail}")),
                "expired" => tri(lang, format!("Nobody decided on your command `{c}` on {t} in time"), format!("你在 {t} 的指令 `{c}` 逾時沒有人核准"), format!("{t} でのコマンド `{c}` は時間内に承認されませんでした")),
                _ => tri(lang, format!("Your command `{c}` on {t} was cancelled{tail}"), format!("你在 {t} 的指令 `{c}` 已取消{tail}"), format!("{t} でのコマンド `{c}` はキャンセルされました{tail}")),
            }
        }
        Kind::CommandBlocked => {
            let (c, rule) = (cmd(d), s(d, "rule"));
            tri(
                lang,
                format!("The rule `{rule}` blocked a command by {by} on {t}: `{c}`"),
                format!("規則 `{rule}` 擋下了 {by} 在 {t} 的指令：`{c}`"),
                format!("ルール `{rule}` が {t} での {by} のコマンドをブロックしました：`{c}`"),
            )
        }
        Kind::SessionStarted => {
            let what = session_what(lang, s(d, "kind"), s(d, "account"));
            tri(lang, format!("{by} opened {what} on {t}"), format!("{by} 在 {t} 開了{what}"), format!("{by} が {t} で{what}を開きました"))
        }
        Kind::McpSessionOpened => {
            let (client, account) = (s(d, "client"), s(d, "account"));
            tri(
                lang,
                format!("{client} ({by}) opened an SSH session to {t} as {account}"),
                format!("{client}（{by}）以 {account} 開了到 {t} 的 SSH session"),
                format!("{client}（{by}）が {account} として {t} への SSH セッションを開きました"),
            )
        }
        Kind::McpSessionClosed => {
            let (client, reason) = (s(d, "client"), s(d, "reason"));
            tri(
                lang,
                format!("The SSH session of {client} ({by}) on {t} was closed ({reason})"),
                format!("{client}（{by}）在 {t} 的 SSH session 已關閉（{reason}）"),
                format!("{client}（{by}）の {t} への SSH セッションが終了しました（{reason}）"),
            )
        }
        Kind::AccountSignIn | Kind::AccountSignInFailed => {
            let user = s(d, "user");
            let ip = s(d, "ip");
            let place = match (ip, s(d, "country")) {
                ("", _) => String::new(),
                (ip, "") => ip.to_string(),
                (ip, c) => format!("{ip}, {c}"),
            };
            let method = sign_in_word(lang, s(d, "method"));
            if kind == Kind::AccountSignIn {
                tri(lang, format!("{user} signed in ({method}) from {place}"), format!("{user} 從 {place} 登入（{method}）"), format!("{user} が {place} からサインインしました（{method}）"))
            } else {
                let reason = sign_in_word(lang, s(d, "reason"));
                tri(lang, format!("Failed sign-in to {user} ({method}, {reason}) from {place}"), format!("有人從 {place} 登入 {user} 失敗（{method}，{reason}）"), format!("{place} から {user} へのサインインに失敗しました（{method}、{reason}）"))
            }
        }
        Kind::KeyExpiring => {
            let (name, when) = (s(d, "name"), s(d, "expires_label"));
            match d.get("days_left").and_then(Value::as_i64).unwrap_or(1) {
                n if n <= 1 => tri(lang, format!("Your SSH key {name} expires within a day ({when})"), format!("你的 SSH 金鑰 {name} 一天內就會到期（{when}）"), format!("SSH 鍵 {name} は 1 日以内に期限切れになります（{when}）")),
                n => tri(lang, format!("Your SSH key {name} expires in {n} days ({when})"), format!("你的 SSH 金鑰 {name} 會在 {n} 天內到期（{when}）"), format!("SSH 鍵 {name} は {n} 日以内に期限切れになります（{when}）")),
            }
        }
        Kind::KeyExpired => {
            let name = s(d, "name");
            tri(
                lang,
                format!("Your SSH key {name} has expired: Telepy no longer accepts it and removes it from devices. Renew it on the Keys page."),
                format!("你的 SSH 金鑰 {name} 已到期：Telepy 不再接受它，也會把它從裝置上移除。請到金鑰頁續期。"),
                format!("SSH 鍵 {name} の期限が切れました。Telepy はこの鍵を受け付けず、デバイスからも削除します。鍵ページで更新してください。"),
            )
        }
        Kind::UserCreated => {
            let (user, via) = (s(d, "user"), s(d, "via"));
            tri(lang, format!("New account {user} ({via})"), format!("新帳號 {user}（{via}）"), format!("新しいアカウント {user}（{via}）"))
        }
        Kind::Test => tri(lang, format!("Test message from {by}: this webhook works."), format!("{by} 送的測試訊息：這個 webhook 可以用。"), format!("{by} からのテストメッセージ：この webhook は動作しています。")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tunnel() -> TunnelRef {
        TunnelRef { id: 1, name: "office-pi".into(), reverse_port: 1025 }
    }

    #[test]
    fn every_kind_renders_in_every_language() {
        let data = json!({"by": "bob", "command": "rm -rf /tmp/x", "user": "alice", "ip": "203.0.113.9", "status": "approved", "kind": "terminal"});
        let mut kinds = super::super::catalog::ALL.to_vec();
        kinds.push(Kind::Test);
        for k in kinds {
            for l in Lang::ALL {
                let s = sentence(k, *l, Some(&tunnel()), &data);
                assert!(!s.trim().is_empty(), "{} {:?}", k.name(), l);
                assert!(!title(k, *l).is_empty());
            }
        }
    }

    #[test]
    fn sentences_use_the_fields() {
        let s = sentence(Kind::TunnelIpChanged, Lang::En, Some(&tunnel()), &json!({"ip": "203.0.113.9", "previous_ip": "198.51.100.1"}));
        assert_eq!(s, "office-pi connected from a new IP address: 203.0.113.9 (was 198.51.100.1)");
        let s = sentence(Kind::TunnelOffline, Lang::ZhTw, Some(&tunnel()), &json!({}));
        assert_eq!(s, "office-pi 離線了（port 1025）");
        let s = sentence(Kind::ShareEnded, Lang::En, Some(&tunnel()), &json!({"user": "carol", "reason": "expired"}));
        assert_eq!(s, "carol's access to office-pi expired");
        let s = sentence(Kind::SessionStarted, Lang::Ja, Some(&tunnel()), &json!({"by": "bob", "kind": "files", "account": "pi"}));
        assert_eq!(s, "bob が office-pi でファイルマネージャー（アカウント pi）を開きました");
    }

    #[test]
    fn sign_in_codes_become_words() {
        let d = json!({"user": "alice", "method": "password", "reason": "bad_password", "ip": "203.0.113.9", "country": "TW"});
        assert_eq!(sentence(Kind::AccountSignInFailed, Lang::En, None, &d), "Failed sign-in to alice (password, wrong password) from 203.0.113.9, TW");
        assert_eq!(sentence(Kind::AccountSignInFailed, Lang::ZhTw, None, &d), "有人從 203.0.113.9, TW 登入 alice 失敗（密碼，密碼錯誤）");
    }

    #[test]
    fn long_commands_are_one_short_line() {
        let long = format!("echo {}\nrm x", "a".repeat(300));
        let s = sentence(Kind::CommandBlocked, Lang::En, Some(&tunnel()), &json!({"command": long, "by": "bob", "rule": "rm"}));
        assert!(!s.contains('\n') && s.contains('…'));
    }

    #[test]
    fn languages() {
        assert_eq!(Lang::parse("zh-TW"), Some(Lang::ZhTw));
        assert_eq!(Lang::from_pref(Some("auto")), Lang::En);
        assert_eq!(Lang::from_pref(None), Lang::En);
        assert_eq!(Lang::from_pref(Some("ja")), Lang::Ja);
    }
}
