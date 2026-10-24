//! 網頁主控台 session 的開始 / 結束事件（含持續時間），寫進 gateway 事件表（該隧道的 Logs）。
//! 終端機、檔案管理、遠端瀏覽器用這個；遠端桌面（`desktop_open` / `desktop_close`）與 AI session 各自記。
//! 開始時記 `<kind>_open`，結束時記 `<kind>_close`（「… closed after 12m03s」），同一個 session 代號串起兩筆。
//! Open / close events (with the duration) for web console sessions, in the tunnel's gateway event log.

use std::time::Instant;

use crate::db;
use crate::state::AppState;
use crate::util::fmt_duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsoleKind {
    Terminal,
    /// 經裝置跳到區網主機的終端機（開始事件沿用 `lan_terminal`）。/ Terminal to a LAN host (open event stays `lan_terminal`).
    LanTerminal,
    Files,
    Browser,
}

impl ConsoleKind {
    pub fn open_event(self) -> &'static str {
        match self {
            Self::Terminal => "terminal_open",
            Self::LanTerminal => "lan_terminal",
            Self::Files => "files_open",
            Self::Browser => "browser_open",
        }
    }
    pub fn close_event(self) -> &'static str {
        match self {
            Self::Terminal | Self::LanTerminal => "terminal_close",
            Self::Files => "files_close",
            Self::Browser => "browser_close",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Terminal | Self::LanTerminal => "Web terminal",
            Self::Files => "File manager",
            Self::Browser => "Remote browser",
        }
    }
}

/// 一個 session 的稽核；`close` 記結束（沒呼叫就不記，例如連線半途失敗）。/ Audit of one session.
pub struct ConsoleSession {
    kind: ConsoleKind,
    tunnel_id: i64,
    port: Option<u16>,
    what: String,
    id: String,
    started: Instant,
}

/// 開始事件的訊息：`Web terminal by alice as ubuntu@office-pi`。/ The open message.
pub fn describe(kind: ConsoleKind, user: &str, account: Option<&str>, tunnel_name: &str) -> String {
    match account {
        Some(a) => format!("{} by {user} as {a}@{tunnel_name}", kind.label()),
        None => format!("{} by {user} on {tunnel_name}", kind.label()),
    }
}

/// 結束事件的訊息。/ The close message.
pub fn closed_message(what: &str, secs: u64, id: &str) -> String {
    format!("{what} closed after {} (session {id})", fmt_duration(std::time::Duration::from_secs(secs)))
}

impl ConsoleSession {
    /// 記開始。`what` = 給 [`describe`] 的說明（區網終端機傳完整的那句）。/ Record the start.
    pub async fn open(state: &AppState, kind: ConsoleKind, tunnel_id: i64, what: String) -> Self {
        let id = crate::util::random_alnum(8).to_lowercase();
        let port = db::tunnels::by_id(&state.db, tunnel_id).await.ok().flatten().and_then(|t| u16::try_from(t.reverse_port).ok());
        state.gateway.event(kind.open_event(), None, port, Some(tunnel_id), format!("{what} (session {id})")).await;
        Self { kind, tunnel_id, port, what, id, started: Instant::now() }
    }

    /// 開始事件的說明 + 隧道名稱（呼叫端只有 id 時）。/ Convenience: look up the tunnel name and describe.
    pub async fn open_for(state: &AppState, kind: ConsoleKind, tunnel_id: i64, user: &str, account: Option<&str>) -> Self {
        let name = db::tunnels::by_id(&state.db, tunnel_id).await.ok().flatten().map(|t| t.host_friendly_name).unwrap_or_else(|| format!("#{tunnel_id}"));
        Self::open(state, kind, tunnel_id, describe(kind, user, account, &name)).await
    }

    /// 記結束（含持續時間）。/ Record the end with the duration.
    pub async fn close(self, state: &AppState) {
        let msg = closed_message(&self.what, self.started.elapsed().as_secs(), &self.id);
        state.gateway.event(self.kind.close_event(), None, self.port, Some(self.tunnel_id), msg).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages() {
        assert_eq!(describe(ConsoleKind::Terminal, "alice", Some("ubuntu"), "office-pi"), "Web terminal by alice as ubuntu@office-pi");
        assert_eq!(describe(ConsoleKind::Browser, "bob", None, "nas"), "Remote browser by bob on nas");
        assert_eq!(closed_message("File manager by a as u@t", 125, "abcd1234"), "File manager by a as u@t closed after 2m05s (session abcd1234)");
        assert_eq!(ConsoleKind::LanTerminal.open_event(), "lan_terminal");
        assert_eq!(ConsoleKind::LanTerminal.close_event(), "terminal_close");
    }
}
