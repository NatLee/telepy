//! 每條隧道自己的服務金鑰。
//!
//! 以前全站只有一把服務金鑰（`SSH_IDENTITY`），每台裝置都信它：裝置分不出是哪條隧道的後端在登入，誰能把隧道指到
//! 一台機器的 sshd，誰就能用那把金鑰登入它（#182 用 host key 擋下了「別人的機器」，這裡把根拔掉）。現在每條隧道
//! 第一次需要時產生一把 ed25519 金鑰對（`ensure`）：公鑰給腳本 / 一鍵加入 / 精靈寫進 `authorized_keys`，私鑰以
//! vault（`SECRET_KEY` 衍生）密封存在 `telepy_tunnel_service_key`。後端登入裝置先用它（`ssh::device`），裝置還沒裝它
//! 才退回共用金鑰；登入成功記為該帳號「已驗證」（`telepy_tunnel_key_account`），`device_keys` 的同步把隧道金鑰裝進
//! 每個登入帳號，並在同一台機器上的每條隧道都驗證過後把共用金鑰從那個帳號移掉。
//! 換掉 `SECRET_KEY` 之後舊的私鑰解不開（和 TOTP、憑證庫一樣）：退回共用金鑰；`doctor` 會指出。
//! One ed25519 service key pair per tunnel, created on first use, private key sealed with the vault. Devices
//! authorize only that key; the backend tries it first and falls back to the shared key for devices not migrated yet.

use std::sync::Arc;

use dashmap::DashMap;
use russh::keys::ssh_key::LineEnding;
use russh::keys::{Algorithm, HashAlg, PrivateKey};
use tokio::sync::Mutex;

use crate::db;
use crate::state::AppState;

/// vault 的 AAD：綁定隧道，密文搬到別條隧道就解不開。/ Vault AAD bound to the tunnel.
pub fn aad(tunnel_id: i64) -> String {
    format!("telepy-tunnel-key:{tunnel_id}")
}

/// 寫進裝置 `authorized_keys` 的註解。/ The comment written into the device's authorized_keys.
pub fn comment(tunnel_id: i64) -> String {
    format!("telepy-tunnel-{tunnel_id}")
}

/// `type base64`（去掉註解）。/ `type base64` without the comment.
pub fn bare(public_line: &str) -> String {
    public_line.split_whitespace().take(2).collect::<Vec<_>>().join(" ")
}

#[derive(Default)]
pub struct TunnelKeys {
    cache: DashMap<i64, Arc<PrivateKey>>,
    /// 同時第一次需要同一條隧道的金鑰時只產一把。/ Concurrent first uses create one key.
    create: Mutex<()>,
    /// 解不開的（SECRET_KEY 換過）：只警告一次。/ Undecryptable keys, warned about once.
    broken: DashMap<i64, ()>,
}

impl TunnelKeys {
    pub fn forget(&self, tunnel_id: i64) {
        self.cache.remove(&tunnel_id);
        self.broken.remove(&tunnel_id);
    }
}

/// 這條隧道的公鑰（`type base64 comment`）；還沒有就產生。/ The tunnel's public key line, created on first use.
pub async fn ensure(state: &AppState, tunnel_id: i64) -> anyhow::Result<String> {
    if let Some(row) = db::tunnel_keys::get(&state.db, tunnel_id).await? {
        return Ok(row.public_key);
    }
    let _creating = state.tunnel_keys.create.lock().await;
    if let Some(row) = db::tunnel_keys::get(&state.db, tunnel_id).await? {
        return Ok(row.public_key);
    }
    let key = PrivateKey::random(&mut rand10::rng(), Algorithm::Ed25519).map_err(|e| anyhow::anyhow!("generate tunnel key: {e}"))?;
    let pem = key.to_openssh(LineEnding::LF).map_err(|e| anyhow::anyhow!("serialise tunnel key: {e}"))?;
    let public = format!("{} {}", bare(&key.public_key().to_openssh().map_err(|e| anyhow::anyhow!("serialise tunnel key: {e}"))?), comment(tunnel_id));
    let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
    let sealed = state.vault.seal(&aad(tunnel_id), pem.as_bytes());
    let row = db::tunnel_keys::insert(&state.db, tunnel_id, &public, &sealed, &fingerprint).await?;
    state.tunnel_keys.cache.insert(tunnel_id, Arc::new(key));
    tracing::info!(tunnel_id, %fingerprint, "created the tunnel's service key");
    Ok(row.public_key)
}

/// 公鑰（已存在的才回）。/ The public key line when one exists.
pub async fn public_line(state: &AppState, tunnel_id: i64) -> anyhow::Result<Option<String>> {
    Ok(db::tunnel_keys::get(&state.db, tunnel_id).await?.map(|r| r.public_key))
}

/// 解開的私鑰（快取）；沒有、或解不開（SECRET_KEY 換過）→ None。/ The decrypted private key; None when missing or undecryptable.
pub async fn private(state: &AppState, tunnel_id: i64) -> Option<Arc<PrivateKey>> {
    if let Some(k) = state.tunnel_keys.cache.get(&tunnel_id) {
        return Some(k.clone());
    }
    let row = match db::tunnel_keys::get(&state.db, tunnel_id).await {
        Ok(Some(r)) => r,
        Ok(None) => return None,
        Err(e) => {
            tracing::warn!(tunnel_id, error = %e, "cannot read the tunnel's service key");
            return None;
        }
    };
    let key = state.vault.open(&aad(tunnel_id), &row.private_key).and_then(|pem| PrivateKey::from_openssh(&pem).ok());
    match key {
        Some(k) => {
            let k = Arc::new(k);
            state.tunnel_keys.cache.insert(tunnel_id, k.clone());
            Some(k)
        }
        None => {
            if state.tunnel_keys.broken.insert(tunnel_id, ()).is_none() {
                tracing::warn!(tunnel_id, "the tunnel's service key cannot be decrypted (SECRET_KEY changed?); using the shared key");
            }
            None
        }
    }
}

/// 用隧道金鑰登入 `username` 成功：記下來；第一次驗證這個帳號時叫金鑰同步去收共用金鑰。
/// A login with the tunnel key succeeded: record it; the first time per account, schedule the shared-key cleanup.
pub async fn verified(state: &AppState, tunnel_id: i64, username: &str) {
    match db::tunnel_keys::mark_verified(&state.db, tunnel_id, username).await {
        Ok(true) => {
            let _ = db::tunnel_keys::set_verified(&state.db, tunnel_id).await;
            tracing::info!(tunnel_id, account = %username, "the device accepts the tunnel's own service key");
            state.device_keys.kick(tunnel_id);
        }
        Ok(false) => {}
        Err(e) => tracing::warn!(tunnel_id, error = %e, "cannot record the tunnel key login"),
    }
}

/// 隧道刪除：金鑰列與快取都丟掉。/ Tunnel deleted: drop the row and the cache.
pub async fn forget(state: &AppState, tunnel_id: i64) {
    if let Err(e) = db::tunnel_keys::delete(&state.db, tunnel_id).await {
        tracing::warn!(tunnel_id, error = %e, "cannot delete the tunnel's service key");
    }
    state.tunnel_keys.forget(tunnel_id);
}

/// 共用金鑰可以從這台機器的 `account` 移掉了嗎：這條隧道與同一台機器上的每條隧道，只要列了這個帳號，都要用自己的
/// 金鑰登入過它。/ May the shared key leave this account: every tunnel on the machine that lists it has verified its own key there.
pub async fn shared_removable(state: &AppState, tunnel_id: i64, account: &str) -> anyhow::Result<bool> {
    let mut mates = vec![tunnel_id];
    mates.extend(db::host_keys::same_machine(&state.db, tunnel_id).await?.into_iter().map(|c| c.tunnel_id));
    for mate in mates {
        let lists_it = db::tunnels::usernames_for_tunnel(&state.db, mate).await?.iter().any(|u| u.username == account);
        if !lists_it && mate != tunnel_id {
            continue;
        }
        if db::tunnel_keys::account(&state.db, mate, account).await?.and_then(|a| a.verified_at).is_none() {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_and_comment() {
        assert_eq!(bare("ssh-ed25519 AAAA telepy-tunnel-7"), "ssh-ed25519 AAAA");
        assert_eq!(comment(7), "telepy-tunnel-7");
        assert_eq!(aad(7), "telepy-tunnel-key:7");
    }

    #[test]
    fn generated_keys_round_trip_through_openssh_text() {
        let key = PrivateKey::random(&mut rand10::rng(), Algorithm::Ed25519).unwrap();
        let pem = key.to_openssh(LineEnding::LF).unwrap();
        let back = PrivateKey::from_openssh(pem.as_bytes()).unwrap();
        assert_eq!(back.public_key().to_openssh().unwrap(), key.public_key().to_openssh().unwrap());
        assert!(bare(&key.public_key().to_openssh().unwrap()).starts_with("ssh-ed25519 AAAA"));
    }
}
