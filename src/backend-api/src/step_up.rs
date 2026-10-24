//! 敏感隧道的「再確認一次是你」（step-up）：隧道設了 `require_step_up` 時，開終端機 / 檔案 / 遠端瀏覽器 / 遠端桌面
//! / 區網掃描前，要有 15 分鐘內用第二因素（TOTP / passkey / 復原碼）換來的 step-up。
//! - 網頁：`POST /api/auth/step-up` 回一個只屬於這個瀏覽器的 token（`X-Telepy-Step-Up` header 或 WebSocket auth 的
//!   `step_up` 欄位），存 SHA-256；被偷的 JWT 在別的瀏覽器用不了。
//! - 筆電的 SSH（gateway `direct-tcpip`）帶不了 token：這個人 15 分鐘內在網頁確認過才放行（像 Tailscale SSH 的 check
//!   mode），沒有就拒絕、記一筆 `step_up_required` 事件並通知他的網頁。
//! - AI agent 不能互動，所以這種隧道上不能開 session。
//! 只放記憶體：重啟後大家重新確認一次。
//! Step-up for sensitive tunnels: with `require_step_up`, opening a terminal / files / remote browser / desktop / LAN
//! scan needs a second-factor confirmation from the last 15 minutes. The web gets a browser-bound token (header or
//! WebSocket auth field, stored hashed); laptop SSH through the gateway is let through while the user confirmed in the
//! web recently (like Tailscale SSH check mode); AI agents can't open sessions there. In memory only.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rand::RngCore;
use sha2::{Digest, Sha256};

/// 確認一次管多久。/ How long one confirmation lasts.
pub const WINDOW: Duration = Duration::from_secs(15 * 60);
/// REST 用的 header。/ The REST header carrying the token.
pub const HEADER: &str = "x-telepy-step-up";
/// WebSocket 被拒的關閉碼。/ WebSocket close code when step-up is missing.
pub const CLOSE_CODE: u16 = 4008;

fn hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

#[derive(Default)]
pub struct StepUps {
    /// token 的雜湊 → (使用者, 到期)。/ Token hash → (user, end).
    tokens: Mutex<HashMap<[u8; 32], (i64, Instant)>>,
    /// 使用者最近一次確認到什麼時候（給 gateway）。/ The user's latest confirmation (for the gateway).
    users: Mutex<HashMap<i64, Instant>>,
}

impl StepUps {
    /// 記一次確認，回 (token, 到期)。順手清掉過期的。/ Record a confirmation; returns (token, end).
    pub fn grant(&self, user_id: i64) -> (String, Instant) {
        self.grant_for(user_id, WINDOW)
    }

    pub fn grant_for(&self, user_id: i64, window: Duration) -> (String, Instant) {
        let mut raw = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut raw);
        let token = format!("tps_{}", raw.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let now = Instant::now();
        let until = now + window;
        let mut tokens = self.tokens.lock().unwrap();
        tokens.retain(|_, (_, end)| *end > now);
        tokens.insert(hash(&token), (user_id, until));
        let mut users = self.users.lock().unwrap();
        users.retain(|_, end| *end > now);
        users.insert(user_id, until);
        (token, until)
    }

    /// 這個 token 屬於這個人而且還有效。/ The token is this user's and still valid.
    pub fn valid(&self, user_id: i64, token: &str) -> bool {
        self.tokens.lock().unwrap().get(&hash(token)).is_some_and(|(u, end)| *u == user_id && *end > Instant::now())
    }

    /// 這個人最近（窗口內）確認過（給帶不了 token 的 SSH）。/ The user confirmed within the window (SSH can't carry a token).
    pub fn recent(&self, user_id: i64) -> bool {
        self.users.lock().unwrap().get(&user_id).is_some_and(|end| *end > Instant::now())
    }

    /// 收回某人所有的確認（測試、登出全部用）。/ Drop every confirmation of a user.
    pub fn revoke(&self, user_id: i64) {
        self.tokens.lock().unwrap().retain(|_, (u, _)| *u != user_id);
        self.users.lock().unwrap().remove(&user_id);
    }
}

/// 隧道要不要 step-up、有沒有有效的 token。/ Whether the tunnel lets this session open.
pub fn allows(required: bool, ups: &StepUps, user_id: i64, token: Option<&str>) -> bool {
    !required || token.is_some_and(|t| ups.valid(user_id, t))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_per_user_and_expire() {
        let ups = StepUps::default();
        let (t, _) = ups.grant(1);
        assert!(t.starts_with("tps_"));
        assert!(ups.valid(1, &t));
        assert!(!ups.valid(2, &t), "someone else's token");
        assert!(!ups.valid(1, "tps_forged"));
        assert!(ups.recent(1) && !ups.recent(2));
        assert!(allows(false, &ups, 2, None), "not required");
        assert!(!allows(true, &ups, 1, None));
        assert!(allows(true, &ups, 1, Some(&t)));

        let (short, _) = ups.grant_for(3, Duration::from_millis(1));
        std::thread::sleep(Duration::from_millis(5));
        assert!(!ups.valid(3, &short) && !ups.recent(3), "expired");

        ups.revoke(1);
        assert!(!ups.valid(1, &t) && !ups.recent(1));
    }
}
