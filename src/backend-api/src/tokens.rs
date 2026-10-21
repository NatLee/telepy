//! 短期 token 儲存（取代 Django cache）：
//! - reverse-key 建立 token（10 分鐘，值 = user_id）
//! - 一次性腳本 token（10 分鐘，值 = payload；取用即刪）
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
}

pub struct TokenStores {
    issue: Cache<String, i64>,
    script: Cache<String, ScriptTokenPayload>,
}

impl TokenStores {
    pub fn new() -> Self {
        Self {
            issue: Cache::builder().time_to_live(Duration::from_secs(600)).max_capacity(10_000).build(),
            script: Cache::builder().time_to_live(Duration::from_secs(600)).max_capacity(10_000).build(),
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
}

impl Default for TokenStores {
    fn default() -> Self {
        Self::new()
    }
}
