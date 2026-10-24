//! 裝置 SSH host key 釘選（每條隧道一組，第一次使用時記下 = TOFU）。
//!
//! 後端到裝置的每條連線（終端機、檔案、遠端瀏覽器、遠端桌面、AI、區網掃描…）都經 `ssh::device::connect`，
//! 握手時在 `check_server_key` 比對：
//! - 這條隧道還沒有釘選 → 記下這把（`host_key_pinned` 事件），放行。第一次連線通常就是加入時後端自己的驗證登入。
//! - 是釘選的那把（或其中一把） → 放行。
//! - 不一樣 → 拒絕這次連線、記成 rejected（`host_key_mismatch` 事件；第一次見到時通知擁有者與分享者）。
//!   擁有者 / ADMIN 在隧道詳細資訊確認後（`POST …/host-key/accept`）才改信任新的那把。
//! 為什麼要做：拿到隧道金鑰的人可以把 `-R` 指到自己的 sshd 冒充裝置，接住終端機的輸入、上傳的檔案與遠端桌面的密碼。
//! Device SSH host-key pinning (TOFU per tunnel); a changed key blocks every backend connection until the owner
//! reviews it, so a stolen tunnel key cannot impersonate the device's sshd.

use std::sync::Arc;

use dashmap::DashMap;
use russh::keys::ssh_key::public::KeyData;
use russh::keys::{HashAlg, PublicKey, PublicKeyOrCertificate};
use tokio::sync::Mutex;

use crate::db;
use crate::state::AppState;

/// 錯誤訊息的開頭（API 層據此辨識，給 `host_key_changed` 錯誤碼）。/ Prefix the API layers match on.
pub const CHANGED: &str = "device host key changed";

/// 一把金鑰的展示形式。/ How a key is shown and stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyInfo {
    /// `type base64`（沒有註解）。/ `type base64`, no comment.
    pub line: String,
    pub key_type: String,
    /// `SHA256:…`
    pub fingerprint: String,
}

pub fn key_info(key: &PublicKeyOrCertificate) -> KeyInfo {
    let data: KeyData = match key {
        PublicKeyOrCertificate::PublicKey { key, .. } => key.key_data().clone(),
        PublicKeyOrCertificate::Certificate(c) => c.public_key().clone(),
    };
    info_from_data(data)
}

fn info_from_data(data: KeyData) -> KeyInfo {
    let pk = PublicKey::new(data, "");
    let full = pk.to_openssh().unwrap_or_default();
    let line = full.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
    KeyInfo { key_type: pk.algorithm().as_str().to_string(), fingerprint: pk.fingerprint(HashAlg::Sha256).to_string(), line }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// 第一次使用（還沒有釘選）。/ Nothing pinned yet.
    FirstUse,
    Trusted,
    Mismatch,
}

/// 純函式：比對釘選與這次看到的金鑰。/ Pure comparison of the pinned keys and the presented one.
pub fn judge(pinned: &[String], presented: &str) -> Verdict {
    if pinned.is_empty() {
        Verdict::FirstUse
    } else if pinned.iter().any(|p| p == presented) {
        Verdict::Trusted
    } else {
        Verdict::Mismatch
    }
}

/// 釘選的記憶體快取（每條連線都要比對，不必每次讀 DB）＋寫入時的鎖（同時第一次連線只記一把）。
/// Cache of pinned keys plus a lock so concurrent first connections pin only one key.
#[derive(Default)]
pub struct HostKeyPins {
    cache: DashMap<i64, Arc<Vec<String>>>,
    write: Mutex<()>,
}

impl HostKeyPins {
    pub fn invalidate(&self, tunnel_id: i64) {
        self.cache.remove(&tunnel_id);
    }

    async fn pinned(&self, state: &AppState, tunnel_id: i64) -> sqlx::Result<Arc<Vec<String>>> {
        if let Some(v) = self.cache.get(&tunnel_id) {
            return Ok(v.clone());
        }
        let v = Arc::new(db::host_keys::pinned_lines(&state.db, tunnel_id).await?);
        self.cache.insert(tunnel_id, v.clone());
        Ok(v)
    }
}

/// 握手時的檢查：回傳是否信任。/ The handshake check: whether to trust the presented key.
pub async fn verify(state: &AppState, tunnel_id: i64, reverse_port: u16, key: &KeyInfo) -> anyhow::Result<bool> {
    let pins = &state.host_keys;
    match judge(&pins.pinned(state, tunnel_id).await?, &key.line) {
        Verdict::Trusted => Ok(true),
        Verdict::FirstUse => {
            let _w = pins.write.lock().await;
            // 鎖住後再看一次：同時的第一次連線，前一個可能剛記好。/ Re-check under the lock.
            pins.invalidate(tunnel_id);
            match judge(&pins.pinned(state, tunnel_id).await?, &key.line) {
                Verdict::Trusted => return Ok(true),
                Verdict::Mismatch => return reject(state, tunnel_id, reverse_port, key).await.map(|_| false),
                Verdict::FirstUse => {}
            }
            db::host_keys::pin(&state.db, tunnel_id, &key.key_type, &key.fingerprint, &key.line, "first_use").await?;
            pins.invalidate(tunnel_id);
            let name = tunnel_name(state, tunnel_id).await;
            state
                .gateway
                .event("host_key_pinned", None, Some(reverse_port), Some(tunnel_id), format!("Pinned the device host key {} {} of '{name}' (first use)", key.key_type, key.fingerprint))
                .await;
            Ok(true)
        }
        Verdict::Mismatch => reject(state, tunnel_id, reverse_port, key).await.map(|_| false),
    }
}

async fn reject(state: &AppState, tunnel_id: i64, reverse_port: u16, key: &KeyInfo) -> anyhow::Result<()> {
    let attempts = db::host_keys::reject(&state.db, tunnel_id, &key.key_type, &key.fingerprint, &key.line).await?;
    // 第一次見到這把才寫事件與通知，免得每次重試都洗版。/ Event + notification only on the first sighting.
    if attempts == 1 {
        let name = tunnel_name(state, tunnel_id).await;
        state
            .gateway
            .event("host_key_mismatch", None, Some(reverse_port), Some(tunnel_id), format!("Refused to connect to '{name}': the device presented host key {} {}, which is not the pinned one", key.key_type, key.fingerprint))
            .await;
        if let Ok(Some(t)) = db::tunnels::by_id(&state.db, tunnel_id).await {
            let _ = crate::api::notify::tunnel_users(state, &t, "HOST-KEY-CHANGED", &format!("The device '{name}' presented a different SSH host key ({}). Connections are blocked until the owner reviews it.", key.fingerprint)).await;
        }
    }
    tracing::warn!(tunnel_id, fingerprint = %key.fingerprint, attempts, "device host key mismatch; connection refused");
    Ok(())
}

async fn tunnel_name(state: &AppState, tunnel_id: i64) -> String {
    db::tunnels::by_id(&state.db, tunnel_id).await.ok().flatten().map(|t| t.host_friendly_name).unwrap_or_else(|| format!("#{tunnel_id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn judging() {
        let a = "ssh-ed25519 AAAA1".to_string();
        let b = "ssh-ed25519 AAAA2".to_string();
        assert_eq!(judge(&[], &a), Verdict::FirstUse);
        assert_eq!(judge(&[a.clone()], &a), Verdict::Trusted);
        assert_eq!(judge(&[b.clone(), a.clone()], &a), Verdict::Trusted);
        assert_eq!(judge(&[b], &a), Verdict::Mismatch);
    }

    #[test]
    fn key_info_drops_the_comment_and_fingerprints_like_ssh_keygen() {
        let pk: PublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHEFltoMG4X8MG60ALp7MCsyv9mKKK1QjxImZr4QVzQ1 some comment".parse().unwrap();
        let info = info_from_data(pk.key_data().clone());
        assert_eq!(info.line, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHEFltoMG4X8MG60ALp7MCsyv9mKKK1QjxImZr4QVzQ1");
        assert_eq!(info.key_type, "ssh-ed25519");
        assert!(info.fingerprint.starts_with("SHA256:"), "{}", info.fingerprint);
    }
}
