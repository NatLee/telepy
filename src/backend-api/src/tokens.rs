//! 短期 token 儲存（取代 Django cache）：
//! - reverse-key 建立 token（10 分鐘，值 = user_id）
//! - 一次性腳本 token（10 分鐘，值 = payload；取用即刪）
//! - OAuth authorization code（10 分鐘，值 = 同意內容；換 token 時取用即刪）
//! TTL in-memory stores replacing the Redis-backed Django cache for short-lived tokens.

use std::time::Duration;

use moka::sync::Cache;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptTokenPayload {
    pub user_id: i64,
    pub server_id: i64,
    pub ssh_port: i64,
    pub script_type: String,
    pub key_path: Option<String>,
    pub username_id: Option<i64>,
    /// `websocket` = 腳本經 /ws/gateway/ 連（只開網頁 port 的網路）。/ `websocket` = the script dials /ws/gateway/.
    pub transport: Option<String>,
}

/// 使用者在同意頁核可後、換成 token 之前的授權內容。/ What the user approved, until the code is redeemed.
#[derive(Debug, Clone)]
pub struct OAuthCode {
    pub client_id: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub user_id: i64,
    pub scope: String,
    pub tunnel_ids: Option<Vec<i64>>,
    pub resource: String,
    /// 兌換成功後要撤銷的舊 grant（同意頁的「取代先前的連線」）。/ Earlier grants to revoke once redeemed.
    pub replaces: Vec<i64>,
}

pub struct TokenStores {
    issue: Cache<String, i64>,
    script: Cache<String, ScriptTokenPayload>,
    oauth_code: Cache<String, OAuthCode>,
}

impl TokenStores {
    pub fn new() -> Self {
        Self {
            issue: Cache::builder().time_to_live(Duration::from_secs(600)).max_capacity(10_000).build(),
            script: Cache::builder().time_to_live(Duration::from_secs(600)).max_capacity(10_000).build(),
            oauth_code: Cache::builder().time_to_live(Duration::from_secs(600)).max_capacity(10_000).build(),
        }
    }

    /// `reverse_keys.utils.issue_token`
    pub fn issue_token(&self, user_id: i64) -> String {
        let token = crate::util::uuid_hex();
        self.issue.insert(token.clone(), user_id);
        token
    }

    pub fn issue_token_user(&self, token: &str) -> Option<i64> {
        self.issue.get(token)
    }

    pub fn remove_issue_token(&self, token: &str) {
        self.issue.invalidate(token);
    }

    /// `tunnels.utils.issue_script_token`
    pub fn issue_script_token(&self, payload: ScriptTokenPayload) -> String {
        let token = crate::util::uuid_hex();
        self.script.insert(token.clone(), payload);
        token
    }

    /// `pop_script_payload`：讀取並刪除（一次性）。
    pub fn pop_script_token(&self, token: &str) -> Option<ScriptTokenPayload> {
        let p = self.script.get(token)?;
        self.script.invalidate(token);
        Some(p)
    }

    /// 存一個 authorization code（值只存在記憶體；重啟即失效，客戶端會重跑授權）。
    pub fn issue_oauth_code(&self, payload: OAuthCode) -> String {
        let code = crate::oauth::random_token("");
        self.oauth_code.insert(code.clone(), payload);
        code
    }

    /// 一次性取用：moka 的 `remove` 是原子的，同一個 code 兩次並行兌換只會有一次拿到值。
    /// Single use: `remove` is atomic, so two concurrent redemptions cannot both get the payload.
    pub fn pop_oauth_code(&self, code: &str) -> Option<OAuthCode> {
        self.oauth_code.remove(code)
    }
}

impl Default for TokenStores {
    fn default() -> Self {
        Self::new()
    }
}
