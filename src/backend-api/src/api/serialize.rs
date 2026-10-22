//! DRF serializer 的 JSON 形狀（欄位名、型別、日期格式）。
//! JSON shapes of the DRF serializers the frontend consumes.

use serde_json::{json, Value};

use crate::db::keys::UserKey;
use crate::db::tunnel_endpoints::LastEndpoint;
use crate::db::tunnels::{Tunnel, Username};
use crate::monitor::Endpoint;
use crate::permissions::{Effective, Permission};
use crate::util::{db_to_iso, db_to_iso_utc_z};

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
        "key": t.key,
        "reverse_port": t.reverse_port,
        "description": t.description,
        "created_at": db_to_iso(&t.created_at, tz),
        "updated_at": db_to_iso(&t.updated_at, tz),
        "user": t.user_id,
        "default_username": t.default_username_id,
    })
}

/// 裝置的公網來源：連著就用 gateway 現在看到的，離線就用最後一次記下的；都沒有回 null。
/// Device source address: the live one while connected, else the last recorded one, else null.
pub fn endpoint_json(live: Option<&Endpoint>, last: Option<&LastEndpoint>) -> Value {
    match (live, last) {
        (Some(e), _) => json!({"ip": e.ip, "live": true, "connected_at": db_to_iso_utc_z(&e.since), "last_seen_at": null}),
        (None, Some(l)) => json!({
            "ip": l.ip,
            "live": false,
            "connected_at": db_to_iso_utc_z(&l.connected_at),
            "last_seen_at": db_to_iso_utc_z(&l.last_seen_at),
        }),
        (None, None) => Value::Null,
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
pub fn user_key_json(k: &UserKey, tz: i32) -> Value {
    json!({
        "id": k.id,
        "host_friendly_name": k.host_friendly_name,
        "key": k.key,
        "description": k.description,
        "created_at": db_to_iso(&k.created_at, tz),
        "updated_at": db_to_iso(&k.updated_at, tz),
        "user": k.user_id,
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
