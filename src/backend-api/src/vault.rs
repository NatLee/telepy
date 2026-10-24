//! 個人的加密憑證庫：存遠端桌面（RDP / VNC）的登入帳密，只有後端在握手時解開，瀏覽器永遠拿不到密碼。
//! AES-256-GCM，金鑰由 `SECRET_KEY` 衍生（和 TOTP 的金鑰分開），AAD 綁「擁有者 + 這一列」，密文搬到別人或別列就解不開。
//! 換掉 `SECRET_KEY` 之後舊的密文解不開（和 TOTP 一樣），使用者重新存一次即可。
//! Per-user encrypted credential vault for remote desktop logins. AES-256-GCM with a key derived from
//! SECRET_KEY (separate from the TOTP key) and AAD bound to the owner and the row.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};

pub struct Vault(Aes256Gcm);

/// 每一列的 AAD。/ The AAD of one row.
pub fn aad(user_id: i64, credential_id: i64) -> String {
    format!("telepy-credential:{user_id}:{credential_id}")
}

impl Vault {
    pub fn new(secret_key: &str) -> Self {
        let key = Sha256::digest(format!("telepy-vault-v1:{secret_key}").as_bytes());
        Self(Aes256Gcm::new_from_slice(&key).expect("32-byte key"))
    }

    pub fn seal(&self, aad: &str, plaintext: &[u8]) -> String {
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let ct = self.0.encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad: aad.as_bytes() }).expect("AES-GCM encryption cannot fail");
        let mut blob = nonce.to_vec();
        blob.extend(ct);
        format!("v1:{}", STANDARD.encode(blob))
    }

    pub fn open(&self, aad: &str, sealed: &str) -> Option<Vec<u8>> {
        let blob = STANDARD.decode(sealed.strip_prefix("v1:")?).ok()?;
        if blob.len() < 12 + 16 {
            return None;
        }
        let (nonce, ct) = blob.split_at(12);
        self.0.decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: aad.as_bytes() }).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_binding() {
        let v = Vault::new("k");
        let sealed = v.seal(&aad(1, 7), b"hunter2");
        assert!(!sealed.contains("hunter2"));
        assert_eq!(v.open(&aad(1, 7), &sealed).as_deref(), Some(&b"hunter2"[..]));
        assert_eq!(v.open(&aad(2, 7), &sealed), None, "another owner");
        assert_eq!(v.open(&aad(1, 8), &sealed), None, "another row");
        assert_eq!(Vault::new("other").open(&aad(1, 7), &sealed), None, "another SECRET_KEY");
        assert_ne!(v.seal(&aad(1, 7), b"hunter2"), sealed, "fresh nonce every time");
    }
}
