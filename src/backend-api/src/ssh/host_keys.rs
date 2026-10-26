//! 裝置 SSH host key 釘選（每條隧道一組，第一次使用時記下 = TOFU）。
//!
//! 後端到裝置的每條連線（終端機、檔案、遠端瀏覽器、遠端桌面、AI、區網掃描…）都經 `ssh::device::connect`，
//! 握手時在 `check_server_key` 比對：
//! - 這條隧道還沒有釘選 → 記下這把（`host_key_pinned` 事件），放行。第一次連線通常就是加入時後端自己的驗證登入。
//! - 是釘選的那把（或其中一把） → 放行。
//! - 不一樣 → 拒絕這次連線、記成 rejected（`host_key_mismatch` 事件；第一次見到時通知擁有者與分享者）。
//!   擁有者 / ADMIN 在隧道詳細資訊確認後（`POST …/host-key/accept`）才改信任新的那把。
//! 為什麼要做：拿到隧道金鑰的人可以把 `-R` 指到自己的 sshd 冒充裝置，接住終端機的輸入、上傳的檔案與遠端桌面的密碼。
//!
//! 釘選的金鑰同時是「這台機器」的身分（一台機器一組 host key）。釘選前先看同一把還被誰信任：
//! - 別的帳號的隧道 → **拒絕**（`CLAIMED`）：裝置分不出 Telepy 使用者（大家都用同一把服務金鑰登入），所以誰能把隧道指到
//!   這台 sshd、誰就能用自己隧道的帳號清單登入它。被拒的隧道記 `claim_refused`，那台機器的隧道記 `claim_attempt` 並通知擁有者。
//!   複製出來的 VM 若沒重做 host key 也會撞到；訊息會請他重產 host key。
//! - 自己的另一條隧道 → 照常釘選，`GET …/host-key` 的 `same_machine` 列出來（兩條隧道管同一台會互相干擾）。
//! 加入腳本在註冊時就送 host key（`source = join`），所以第一次連線不再是「看到什麼信什麼」。
//! Device SSH host-key pinning (TOFU per tunnel); a changed key blocks every backend connection until the owner
//! reviews it, so a stolen tunnel key cannot impersonate the device's sshd. A pinned key is also the machine's
//! identity: pinning a key another account's tunnel already trusts is refused (that account owns the machine).

use std::collections::HashSet;
use std::sync::Arc;

use dashmap::DashMap;
use russh::keys::ssh_key::public::KeyData;
use russh::keys::{HashAlg, PublicKey, PublicKeyOrCertificate};
use tokio::sync::Mutex;

use crate::db::{self, host_keys::Claimant};
use crate::state::AppState;

/// 錯誤訊息的開頭（API 層據此辨識，給 `host_key_changed` 錯誤碼）。/ Prefix the API layers match on.
pub const CHANGED: &str = "device host key changed";
/// 錯誤訊息的開頭：這台機器屬於別的帳號的隧道（錯誤碼 `device_claimed`）。/ Prefix: the machine belongs to another account's tunnel.
pub const CLAIMED: &str = "device managed by another account";

/// 給裝置 / 使用者看的說明（加入腳本、連線錯誤）。/ The explanation shown on the device and in connection errors.
pub const CLAIMED_HINT: &str = "its SSH host key is pinned by a tunnel of another Telepy account. Ask that account to share the device with you; if this machine is a clone, regenerate its host keys (ssh-keygen -A) and try again";

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

/// 一行 `type base64 [comment]`（例如 `ssh-keyscan` 的輸出去掉主機欄）→ 與握手時相同的展示形式；解析不了就 None。
/// Parse a `type base64 [comment]` line (e.g. ssh-keyscan output without the host column) into the handshake form.
pub fn parse_line(line: &str) -> Option<KeyInfo> {
    let mut parts = line.split_whitespace();
    let (kind, blob) = (parts.next()?, parts.next()?);
    let pk = PublicKey::from_openssh(&format!("{kind} {blob}")).ok()?;
    Some(info_from_data(pk.key_data().clone()))
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

/// 這條隧道最近一次因為「機器屬於別的帳號」被拒的連線（記憶體；列表與詳細資訊顯示用）。
/// The last connection of this tunnel refused because the machine belongs to another account (in memory).
#[derive(Debug, Clone)]
pub struct RefusedClaim {
    pub key_type: String,
    pub fingerprint: String,
    /// DB 時間格式。/ DB time format.
    pub at: String,
}

/// 釘選的記憶體快取（每條連線都要比對，不必每次讀 DB）＋寫入時的鎖（同時第一次連線只記一把）＋被拒的認領。
/// Cache of pinned keys, a lock so concurrent first connections pin only one key, and the refused claims.
#[derive(Default)]
pub struct HostKeyPins {
    cache: DashMap<i64, Arc<Vec<String>>>,
    write: Mutex<()>,
    claims: DashMap<i64, RefusedClaim>,
}

impl HostKeyPins {
    /// 釘選改了（確認、忘掉、加入腳本釘的）：下次重讀 DB，並清掉被拒的認領（情況可能已經變了）。
    /// The pins changed: re-read on the next check and drop the refused claim (the situation may have changed).
    pub fn invalidate(&self, tunnel_id: i64) {
        self.cache.remove(&tunnel_id);
        self.claims.remove(&tunnel_id);
    }

    pub fn refused_claim(&self, tunnel_id: i64) -> Option<RefusedClaim> {
        self.claims.get(&tunnel_id).map(|c| c.clone())
    }

    /// 目前有被拒認領的隧道（列表用）。/ Tunnels with a refused claim (for the list).
    pub fn claimed_tunnels(&self) -> HashSet<i64> {
        self.claims.iter().map(|e| *e.key()).collect()
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

/// 握手檢查的結論。/ The outcome of the handshake check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Trust,
    /// 與釘選不符（記成 rejected，等擁有者確認）。/ Not the pinned key; recorded for review.
    Changed,
    /// 這把金鑰屬於別的帳號的機器。/ The key belongs to another account's machine.
    Claimed,
}

/// 誰擁有這台機器：別的帳號的隧道釘選了同一把金鑰就回它（第一條）。/ The first claimant owned by someone else.
pub fn foreign_claimant(others: &[Claimant], user_id: i64) -> Option<&Claimant> {
    others.iter().find(|c| c.user_id != user_id)
}

/// 握手時的檢查。/ The handshake check.
pub async fn verify(state: &AppState, tunnel_id: i64, reverse_port: u16, key: &KeyInfo) -> anyhow::Result<Decision> {
    let pins = &state.host_keys;
    match judge(&pins.pinned(state, tunnel_id).await?, &key.line) {
        Verdict::Trusted => Ok(Decision::Trust),
        Verdict::FirstUse => {
            let _w = pins.write.lock().await;
            // 鎖住後再看一次：同時的第一次連線，前一個可能剛記好。/ Re-check under the lock.
            pins.cache.remove(&tunnel_id);
            match judge(&pins.pinned(state, tunnel_id).await?, &key.line) {
                Verdict::Trusted => return Ok(Decision::Trust),
                Verdict::Mismatch => return reject(state, tunnel_id, reverse_port, key).await.map(|_| Decision::Changed),
                Verdict::FirstUse => {}
            }
            // 這台機器已經是誰的？/ Whose machine is this already?
            let Some(tunnel) = db::tunnels::by_id(&state.db, tunnel_id).await? else { anyhow::bail!("tunnel {tunnel_id} no longer exists") };
            let others = db::host_keys::claimants(&state.db, &key.line, tunnel_id).await?;
            if let Some(foreign) = foreign_claimant(&others, tunnel.user_id) {
                refuse_claim(state, &tunnel, reverse_port, key, foreign).await?;
                return Ok(Decision::Claimed);
            }
            db::host_keys::pin(&state.db, tunnel_id, &key.key_type, &key.fingerprint, &key.line, "first_use").await?;
            pins.invalidate(tunnel_id);
            let same = same_machine_note(&others);
            state
                .gateway
                .event("host_key_pinned", None, Some(reverse_port), Some(tunnel_id), format!("Pinned the device host key {} {} of '{}' (first use){same}", key.key_type, key.fingerprint, tunnel.host_friendly_name))
                .await;
            Ok(Decision::Trust)
        }
        Verdict::Mismatch => reject(state, tunnel_id, reverse_port, key).await.map(|_| Decision::Changed),
    }
}

/// 「— the same machine as 'x', 'y'」（自己的其他隧道）。/ A note naming the user's other tunnels on this machine.
pub fn same_machine_note(same: &[Claimant]) -> String {
    if same.is_empty() {
        return String::new();
    }
    let names: Vec<String> = same.iter().map(|c| format!("'{}'", c.host_friendly_name)).collect();
    format!(" — the same machine as {}", names.join(", "))
}

/// 拒絕：這把金鑰屬於別的帳號的機器。被拒的隧道記 `claim_refused`（它的擁有者才知道為什麼連不上），那台機器的隧道記
/// `claim_attempt` 並通知擁有者；同一把金鑰只報一次（連線池會一直重試）。
/// Refuse: the key belongs to another account's machine. Both tunnels get an event, the owner a notification; reported once per key.
async fn refuse_claim(state: &AppState, tunnel: &db::tunnels::Tunnel, reverse_port: u16, key: &KeyInfo, foreign: &Claimant) -> anyhow::Result<()> {
    let pins = &state.host_keys;
    let first = pins.refused_claim(tunnel.id).map_or(true, |c| c.fingerprint != key.fingerprint);
    pins.claims.insert(tunnel.id, RefusedClaim { key_type: key.key_type.clone(), fingerprint: key.fingerprint.clone(), at: crate::util::now_db() });
    tracing::warn!(tunnel_id = tunnel.id, fingerprint = %key.fingerprint, owner_tunnel = foreign.tunnel_id, "device host key belongs to another account's tunnel; connection refused");
    if !first {
        return Ok(());
    }
    state
        .gateway
        .event(
            "claim_refused",
            None,
            Some(reverse_port),
            Some(tunnel.id),
            format!("Refused to connect to '{}': {CLAIMED_HINT} (host key {} {})", tunnel.host_friendly_name, key.key_type, key.fingerprint),
        )
        .await;
    let by = db::users::by_id(&state.db, tunnel.user_id).await?.map(|u| u.username).unwrap_or_else(|| format!("user #{}", tunnel.user_id));
    report_claim_attempt(state, foreign, &by, &tunnel.host_friendly_name, key).await;
    Ok(())
}

/// 告訴機器的擁有者：別的帳號的隧道指到了這台（事件 `claim_attempt` + `DEVICE-CLAIM-ATTEMPT` 給擁有者與 ADMIN sharee）。
/// 加入腳本的註冊被拒時也用這個。/ Tell the machine's owner another account's tunnel reached it; the join path uses it too.
pub async fn report_claim_attempt(state: &AppState, owner: &Claimant, by: &str, by_tunnel: &str, key: &KeyInfo) {
    let Ok(Some(t)) = db::tunnels::by_id(&state.db, owner.tunnel_id).await else { return };
    let message = format!("Tunnel '{by_tunnel}' of {by} pointed at this device's SSH server and was refused (same host key {} {})", key.key_type, key.fingerprint);
    state.gateway.event("claim_attempt", None, u16::try_from(t.reverse_port).ok(), Some(t.id), message).await;
    let mut audience = vec![t.user_id];
    audience.extend(db::sharing::admin_sharee_ids(&state.db, t.id).await.unwrap_or_default());
    state.hub.notify_users(
        audience.clone(),
        &serde_json::json!({
            "action": "DEVICE-CLAIM-ATTEMPT", "tunnel_id": t.id, "tunnel_name": t.host_friendly_name, "by": by, "by_tunnel": by_tunnel,
            "details": format!("Another account ({by}) pointed a tunnel at '{}' and was refused", t.host_friendly_name),
        }),
    );
    state.webhooks.emit(
        crate::webhooks::Event::new(crate::webhooks::Kind::DeviceClaimAttempt)
            .tunnel(&t)
            .to(audience, None)
            .data(serde_json::json!({ "by": by, "by_tunnel": by_tunnel, "fingerprint": key.fingerprint, "key_type": key.key_type })),
    );
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
            let audience = crate::api::notify::tunnel_audience(state, &t).await.unwrap_or_default();
            state.webhooks.emit(
                crate::webhooks::Event::new(crate::webhooks::Kind::TunnelHostKeyChanged)
                    .tunnel(&t)
                    .to(audience, None)
                    .data(serde_json::json!({ "fingerprint": key.fingerprint, "key_type": key.key_type })),
            );
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
        // ssh-keyscan 的一行去掉主機欄後也是同一個形式。/ A keyscan line (host column dropped) parses to the same form.
        let parsed = parse_line("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHEFltoMG4X8MG60ALp7MCsyv9mKKK1QjxImZr4QVzQ1 ignored").unwrap();
        assert_eq!(parsed, info);
        assert!(parse_line("ssh-ed25519 notbase64").is_none());
        assert!(parse_line("").is_none());
    }

    #[test]
    fn a_foreign_claimant_is_one_owned_by_someone_else() {
        let mine = Claimant { tunnel_id: 1, user_id: 7, host_friendly_name: "a".into() };
        let theirs = Claimant { tunnel_id: 2, user_id: 8, host_friendly_name: "b".into() };
        assert!(foreign_claimant(&[mine.clone()], 7).is_none());
        assert_eq!(foreign_claimant(&[mine.clone(), theirs.clone()], 7).map(|c| c.tunnel_id), Some(2));
        assert_eq!(same_machine_note(&[]), "");
        assert_eq!(same_machine_note(&[mine, theirs]), " — the same machine as 'a', 'b'");
    }
}
