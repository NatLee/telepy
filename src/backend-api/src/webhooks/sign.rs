//! 簽章照 Standard Webhooks（standardwebhooks.com）：`webhook-id` / `webhook-timestamp` / `webhook-signature`，
//! 簽的是 `{id}.{timestamp}.{body}`，HMAC-SHA256，金鑰是 `whsec_` 後面 base64 解開的位元組。現成的函式庫都能驗。
//! Signatures follow Standard Webhooks: HMAC-SHA256 over `{id}.{timestamp}.{body}` with the base64 bytes after
//! `whsec_`, sent as `webhook-id` / `webhook-timestamp` / `webhook-signature: v1,<base64>`.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;

pub const PREFIX: &str = "whsec_";

/// 新的簽章密鑰（32 個隨機位元組）。/ A fresh signing secret (32 random bytes).
pub fn new_secret() -> String {
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    format!("{PREFIX}{}", STANDARD.encode(key))
}

/// `v1,<base64>`；密鑰格式不對回 None。/ `v1,<base64>`; None for a malformed secret.
pub fn signature(secret: &str, msg_id: &str, timestamp: i64, body: &[u8]) -> Option<String> {
    let key = STANDARD.decode(secret.strip_prefix(PREFIX)?).ok()?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).ok()?;
    mac.update(msg_id.as_bytes());
    mac.update(b".");
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    Some(format!("v1,{}", STANDARD.encode(mac.finalize().into_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_standard_webhooks_test_vector() {
        let sig = signature("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, br#"{"test": 2432232314}"#);
        assert_eq!(sig.as_deref(), Some("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="));
    }

    #[test]
    fn fresh_secrets_sign_and_bad_ones_do_not() {
        let s = new_secret();
        assert!(s.starts_with(PREFIX) && s.len() > 40);
        assert_ne!(new_secret(), s);
        assert!(signature(&s, "m", 1, b"x").is_some());
        assert_eq!(signature("nope", "m", 1, b"x"), None);
        assert_eq!(signature("whsec_!!!", "m", 1, b"x"), None);
    }
}
