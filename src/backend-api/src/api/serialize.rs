//! DRF serializer 的 JSON 形狀（欄位名、型別、日期格式）。
//! JSON shapes of the DRF serializers the frontend consumes.

use serde_json::{json, Value};

use crate::db::keys::UserKey;
use crate::db::tunnel_endpoints::LastEndpoint;
use crate::db::tunnels::{Tunnel, Username};
use crate::geoip::GeoIp;
use crate::monitor::Endpoint;
use crate::presence::{self, Entry};
use crate::permissions::{Effective, Permission};
use crate::util::{db_to_iso, db_to_iso_utc_z, opt_db_to_iso};

/// `ReverseServerAuthorizedKeysSerializer`（含 6 個由有效權限推導的欄位）。
pub fn tunnel_json(t: &Tunnel, eff: Option<Effective>, shared_with_count: i64, tz: i32) -> Value {
    let level = eff.map(Effective::level);
    let can_edit = level.map(|l| l >= Permission::Edit).unwrap_or(false);
    let can_admin = level.map(|l| l >= Permission::Admin).unwrap_or(false);
    json!({
        "id": t.id,
        "can_edit": can_edit,
        "can_share": can_admin,
        "can_delete": can_admin,
        "is_owner": matches!(eff, Some(Effective::Owner)),
        "user_permission": eff.map(Effective::label),
        "shared_with_count": shared_with_count,
        "host_friendly_name": t.host_friendly_name,
        // 裝置金鑰認得是哪台機器：只給 owner / ADMIN（換它也只有他們能）。/ The device key identifies the machine: owner / ADMIN only.
        "key": if can_admin { json!(t.key) } else { Value::Null },
        "reverse_port": t.reverse_port,
        "description": t.description,
        "created_at": db_to_iso(&t.created_at, tz),
        "updated_at": db_to_iso(&t.updated_at, tz),
        "user": t.user_id,
        "default_username": t.default_username_id,
        "require_step_up": t.require_step_up,
        "record_sessions": t.record_sessions,
        "terminal_detach_policy": t.terminal_detach_policy,
    })
}

/// 裝置的公網來源：連著就用 gateway 現在看到的，離線就用最後一次記下的；都沒有回 null。
/// Device source address: the live one while connected, else the last recorded one, else null.
/// `geo` = 位址範圍 + 國家 / ISP（有 GeoIP 資料庫時）；`previous_ip` / `changed_at` = 最近一次換 IP。
/// `geo` = scope plus country / network owner; `previous_ip` / `changed_at` = the latest address change.
pub fn endpoint_json(live: Option<&Endpoint>, last: Option<&LastEndpoint>, geo: &GeoIp) -> Value {
    let mut v = match (live, last) {
        (Some(e), _) => json!({"ip": e.ip, "live": true, "connected_at": db_to_iso_utc_z(&e.since), "last_seen_at": null, "transport": e.transport}),
        (None, Some(l)) => json!({
            "ip": l.ip,
            "live": false,
            "connected_at": db_to_iso_utc_z(&l.connected_at),
            "last_seen_at": db_to_iso_utc_z(&l.last_seen_at),
        }),
        (None, None) => return Value::Null,
    };
    v["geo"] = geo.json(v["ip"].as_str());
    v["previous_ip"] = json!(last.and_then(|l| l.previous_ip.clone()));
    v["changed_at"] = json!(last.and_then(|l| l.changed_at.as_deref()).map(db_to_iso_utc_z));
    // 裝置自己的位址（`device_info`）：公網 IP（gateway 或裝置回報）、內網網卡、hostname。
    // The device's own addresses: public IP (gateway or device-reported), LAN interfaces, hostname.
    let public = last.and_then(|l| l.public_ip.as_deref());
    v["public_ip"] = json!(public);
    v["public_source"] = json!(last.and_then(|l| l.public_source.as_deref()));
    v["public_geo"] = geo.json(public);
    v["lan"] = last.and_then(|l| l.lan.as_deref()).and_then(|s| serde_json::from_str::<Value>(s).ok()).unwrap_or_else(|| json!([]));
    v["hostname"] = json!(last.and_then(|l| l.hostname.as_deref()));
    v["probed_at"] = json!(last.and_then(|l| l.probed_at.as_deref()).map(db_to_iso_utc_z));
    v["probe_error"] = json!(last.and_then(|l| l.probe_error.as_deref()));
    // 裝置的基本狀況（`device_facts`，含 `warnings`）與讀到的時間。/ Device facts (with `warnings`) and when they were read.
    v["facts"] = last.and_then(|l| l.facts.as_deref()).and_then(|s| serde_json::from_str::<Value>(s).ok()).unwrap_or(Value::Null);
    v["facts_at"] = json!(last.and_then(|l| l.facts_at.as_deref()).map(db_to_iso_utc_z));
    v
}

/// 誰在用：人數給所有看得到隧道的人；`sessions`（誰、哪種連線、IP、多久）只在 `details` 時帶，否則 null。
/// Presence: the count for everyone, the sessions only with `details`.
pub fn presence_json(entries: &[Entry], details: bool, geo: &GeoIp) -> Value {
    let sessions = details.then(|| {
        entries
            .iter()
            .map(|e| {
                json!({
                    "id": e.id,
                    "user": e.username,
                    "kind": e.kind.as_str(),
                    "ip": e.ip,
                    "geo": geo.json(e.ip.as_deref()),
                    "since": db_to_iso_utc_z(&e.since),
                    "client": e.client,
                    "detached": detached_json(e),
                })
            })
            .collect::<Vec<_>>()
    });
    json!({ "count": presence::distinct_users(entries), "sessions": sessions })
}

/// 斷線保留中的網頁終端機：`{since, ends_at}`，否則 null。/ A detached web terminal: `{since, ends_at}`, else null.
pub fn detached_json(e: &Entry) -> Value {
    match &e.detached {
        Some((since, ends)) => json!({ "since": db_to_iso_utc_z(since), "ends_at": db_to_iso_utc_z(ends) }),
        None => Value::Null,
    }
}

/// `ReverseServerUsernamesSerializer`
pub fn username_json(u: &Username, tz: i32) -> Value {
    json!({
        "id": u.id,
        "username": u.username,
        "created_at": db_to_iso(&u.created_at, tz),
        "updated_at": db_to_iso(&u.updated_at, tz),
        "reverse_server": u.reverse_server_id,
        "user": u.user_id,
    })
}

/// `UserAuthorizedKeysSerializer`
/// 另外附上由公鑰解析出的 `fingerprint` / `key_type` / `bits` / `comment`（無法解析時為 null）與最後使用紀錄。
pub fn user_key_json(k: &UserKey, tz: i32) -> Value {
    let parsed = crate::device_keys::authorized_keys::parse_public_key(&k.key);
    json!({
        "id": k.id,
        "host_friendly_name": k.host_friendly_name,
        "key": k.key,
        "description": k.description,
        "created_at": db_to_iso(&k.created_at, tz),
        "updated_at": db_to_iso(&k.updated_at, tz),
        "user": k.user_id,
        "fingerprint": parsed.as_ref().map(|p| p.fingerprint.clone()),
        "key_type": parsed.as_ref().map(|p| p.label),
        "bits": parsed.as_ref().and_then(|p| p.bits),
        "comment": parsed.as_ref().map(|p| p.comment.clone()).filter(|c| !c.is_empty()),
        "last_used_at": opt_db_to_iso(&k.last_used_at, tz),
        "last_used_ip": k.last_used_ip,
        "expires_at": opt_db_to_iso(&k.expires_at, tz),
        "expired": k.expired(),
    })
}

/// `is_valid_ssh_public_key`
pub fn is_valid_ssh_public_key(key: &str) -> bool {
    const PREFIXES: [&str; 6] = ["ssh-rsa", "ssh-dss", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-ed25519"];
    let mut parts = key.trim().split_whitespace();
    let (Some(kind), Some(body)) = (parts.next(), parts.next()) else { return false };
    if !PREFIXES.contains(&kind) {
        return false;
    }
    // Python base64.b64decode（validate=False）會先丟棄非字母表字元再檢查 padding；比照辦理。
    // Mirror Python's lenient b64decode: drop non-alphabet chars, then require valid padding.
    // 並允許非 canonical 的尾端位元（Python 不檢查）。/ Python also ignores non-zero trailing bits.
    use base64::engine::{GeneralPurpose, GeneralPurposeConfig};
    use base64::{alphabet, Engine};
    let cleaned: String = body.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=')).collect();
    let engine = GeneralPurpose::new(&alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true));
    engine.decode(cleaned).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_key_validation() {
        assert!(is_valid_ssh_public_key("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq= comment"));
        assert!(!is_valid_ssh_public_key("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq comment"), "bad padding like Python");
        assert!(!is_valid_ssh_public_key("ssh-ed25519"));
        assert!(!is_valid_ssh_public_key("foo AAAA"));
        assert!(!is_valid_ssh_public_key("ssh-rsa not*base64"));
    }
}
