//! Django 密碼雜湊：`pbkdf2_sha256$<iterations>$<salt>$<base64>`。
//! 沿用同一格式（而非換 argon2），讓切回 Django image 時密碼仍可用。
//! Django-compatible PBKDF2-SHA256 password hashing so the auth_user rows stay interchangeable.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

/// Django 6.0 的預設迭代次數。/ Django 6.0 default iteration count.
pub const DEFAULT_ITERATIONS: u32 = 1_000_000;
const SALT_LEN: usize = 22;

fn pbkdf2_sha256(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    // 單一 block（輸出 32 bytes = SHA-256 長度），PRF 以 clone 重用已排程的 key。
    let prf = Hmac::<Sha256>::new_from_slice(password).expect("hmac accepts any key length");
    let mut mac = prf.clone();
    mac.update(salt);
    mac.update(&1u32.to_be_bytes());
    let mut u = mac.finalize().into_bytes();
    let mut t = u;
    for _ in 1..iterations {
        let mut mac = prf.clone();
        mac.update(&u);
        u = mac.finalize().into_bytes();
        for (a, b) in t.iter_mut().zip(u.iter()) {
            *a ^= b;
        }
    }
    t.into()
}

pub fn make_password(password: &str) -> String {
    let salt = crate::util::random_alnum(SALT_LEN);
    let hash = pbkdf2_sha256(password.as_bytes(), salt.as_bytes(), DEFAULT_ITERATIONS);
    format!("pbkdf2_sha256${DEFAULT_ITERATIONS}${salt}${}", B64.encode(hash))
}

/// `User.set_unusable_password()` 的格式：`!` + 隨機字串，永遠驗不過。
pub fn unusable_password() -> String {
    format!("!{}", crate::util::random_alnum(40))
}

/// 常數時間比對；格式不符 / unusable 一律 false。/ Constant-time verify; malformed → false.
pub fn check_password(password: &str, encoded: &str) -> bool {
    if encoded.starts_with('!') {
        return false;
    }
    let mut parts = encoded.splitn(4, '$');
    let (Some(algo), Some(iter), Some(salt), Some(hash_b64)) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    if algo != "pbkdf2_sha256" {
        return false;
    }
    let Ok(iterations) = iter.parse::<u32>() else { return false };
    let Ok(expected) = B64.decode(hash_b64) else { return false };
    if expected.len() != 32 || iterations == 0 {
        return false;
    }
    let actual = pbkdf2_sha256(password.as_bytes(), salt.as_bytes(), iterations);
    actual.ct_eq(expected.as_slice()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_known_django_hash() {
        // 向量來自 Python hashlib.pbkdf2_hmac('sha256', b'secret', b'abcdefghijklmnopqrstuv', 1000)
        // —— 與 Django 的 PBKDF2PasswordHasher 使用同一個實作。
        // Vector from Python hashlib (the implementation Django's hasher delegates to).
        let encoded = "pbkdf2_sha256$1000$abcdefghijklmnopqrstuv$1nE4fvOmiD+ZePp39y6TYTXfkn5HEwJDyz8e6UkQE1w=";
        let actual = pbkdf2_sha256(b"secret", b"abcdefghijklmnopqrstuv", 1000);
        let expected = B64.decode("1nE4fvOmiD+ZePp39y6TYTXfkn5HEwJDyz8e6UkQE1w=").unwrap();
        assert_eq!(actual.as_slice(), expected.as_slice(), "PBKDF2 output must match Django's");
        assert!(check_password("secret", encoded));
        assert!(!check_password("wrong", encoded));
        assert!(!check_password("secret", "!abc"));
        assert!(!check_password("secret", "garbage"));
    }

    #[test]
    fn verifies_django_default_iteration_hash() {
        // hashlib.pbkdf2_hmac('sha256', b'1234', b'xJ3k9Lm2Qp7Rt5Vw8Yz0Ab', 870000)
        let encoded = "pbkdf2_sha256$870000$xJ3k9Lm2Qp7Rt5Vw8Yz0Ab$UmoxQp3/OAg0a23OQoEZw/OSF7KKpyO7Jn+GqfsbTkk=";
        assert!(check_password("1234", encoded));
    }

    #[test]
    fn roundtrip() {
        let enc = make_password("hunter2");
        assert!(enc.starts_with("pbkdf2_sha256$"));
        assert!(check_password("hunter2", &enc));
        assert!(!check_password("hunter3", &enc));
    }
}
