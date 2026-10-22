//! 兩步驟驗證（2FA）的純邏輯：TOTP（RFC 6238）、base32、TOTP secret 的靜態加密、復原碼、otpauth URI 與 QR code。
//! Passkey（WebAuthn）的部分在 `passkey.rs`；HTTP handler 在 `api/mfa.rs`，SQL 在 `db/mfa.rs`。
//!
//! 規則：帳號只要有任一個第二因素（啟用中的 TOTP 或至少一把 passkey）就算「已啟用 2FA」：
//! - 帳密 / Google 登入後先回 `mfa_required`，通過 TOTP / passkey / 復原碼才發 token；
//! - 用 passkey 直接登入（免密碼）本身就是兩個因素（裝置 + 生物辨識/PIN），不再要求第二步；
//! - 敏感操作（新增 / 刪除因素、重產復原碼、核可 MCP app）要「再驗證」一次。
//! Pure two-factor logic: TOTP, base32, TOTP secret encryption at rest, recovery codes, otpauth URI, QR code.

pub mod passkey;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::{Digest, Sha256};

/// TOTP 參數：SHA-1、6 位數、30 秒（所有 authenticator app 都支援的組合）。/ The universally supported TOTP profile.
pub const TOTP_DIGITS: u32 = 6;
pub const TOTP_PERIOD: u64 = 30;
/// 容許前後各一個時間窗（時鐘誤差）。/ Accept one step of clock skew either way.
pub const TOTP_SKEW: i64 = 1;
pub const TOTP_SECRET_BYTES: usize = 20;
pub const RECOVERY_CODES: usize = 10;
/// 登入第二步（mfa_token）的有效時間與嘗試次數。/ Lifetime and attempts of a login challenge.
pub const CHALLENGE_TTL: Duration = Duration::from_secs(300);
pub const CHALLENGE_ATTEMPTS: u32 = 5;
/// 每個使用者在 `LOCKOUT_WINDOW` 內最多失敗幾次（TOTP / 復原碼 / passkey，含再驗證）。
/// Failed second-factor attempts allowed per user within the window.
pub const MAX_FAILURES: u32 = 10;
pub const LOCKOUT_WINDOW: Duration = Duration::from_secs(900);

// ---------------------------------------------------------------- in-memory state

/// 帳密 / Google 通過、等待第二步的登入。失敗次數放在 `Arc` 裡原地累加：不重新 insert，所以每次失敗
/// 不會把 `CHALLENGE_TTL` 重算一次（moka 的 insert 會重設 TTL），並行的兩次失敗也不會互相蓋掉。
/// A login waiting for its second factor; attempts are counted in place so a failure never extends the TTL.
#[derive(Debug, Clone)]
pub struct LoginChallenge {
    pub user_id: i64,
    pub attempts: Arc<AtomicU32>,
}

impl LoginChallenge {
    pub fn new(user_id: i64) -> Self {
        Self { user_id, attempts: Arc::new(AtomicU32::new(0)) }
    }
    /// 記一次失敗，回傳累計次數。/ Record a failure; returns the new total.
    pub fn fail(&self) -> u32 {
        self.attempts.fetch_add(1, Ordering::SeqCst) + 1
    }
    pub fn exhausted(&self) -> bool {
        self.attempts.load(Ordering::SeqCst) >= CHALLENGE_ATTEMPTS
    }
}

/// 2FA 的記憶體狀態：登入挑戰（`mfa_token`）、每位使用者的失敗次數、passkey 儀式、TOTP secret 的加解密。
/// In-memory two-factor state: login challenges, per-user failure counters, passkey ceremonies, secret sealing.
pub struct MfaStores {
    pub challenges: moka::sync::Cache<String, LoginChallenge>,
    pub failures: moka::sync::Cache<i64, u32>,
    pub ceremonies: passkey::Ceremonies,
    pub secrets: SecretBox,
}

impl MfaStores {
    pub fn new(secret_key: &str) -> Self {
        Self {
            challenges: moka::sync::Cache::builder().time_to_live(CHALLENGE_TTL).max_capacity(10_000).build(),
            failures: moka::sync::Cache::builder().time_to_live(LOCKOUT_WINDOW).max_capacity(100_000).build(),
            ceremonies: passkey::Ceremonies::default(),
            secrets: SecretBox::new(secret_key),
        }
    }
    pub fn locked(&self, user_id: i64) -> bool {
        self.failures.get(&user_id).unwrap_or(0) >= MAX_FAILURES
    }
    pub fn record_failure(&self, user_id: i64) {
        let n = self.failures.get(&user_id).unwrap_or(0) + 1;
        self.failures.insert(user_id, n);
    }
    pub fn clear_failures(&self, user_id: i64) {
        self.failures.invalidate(&user_id);
    }
}

// ---------------------------------------------------------------- base32 (RFC 4648, no padding)

const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

pub fn base32_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(5) * 8);
    for chunk in data.chunks(5) {
        let mut buf = [0u8; 5];
        buf[..chunk.len()].copy_from_slice(chunk);
        let n = u64::from_be_bytes([0, 0, 0, buf[0], buf[1], buf[2], buf[3], buf[4]]);
        let chars = (chunk.len() * 8).div_ceil(5);
        for i in 0..chars {
            out.push(B32[((n >> (35 - i * 5)) & 31) as usize] as char);
        }
    }
    out
}

pub fn base32_decode(s: &str) -> Option<Vec<u8>> {
    let mut bits: u64 = 0;
    let mut nbits = 0u32;
    let mut out = Vec::new();
    for c in s.chars().filter(|c| !c.is_whitespace() && *c != '=') {
        let v = B32.iter().position(|b| *b as char == c.to_ascii_uppercase())? as u64;
        bits = (bits << 5) | v;
        nbits += 5;
        if nbits >= 8 {
            nbits -= 8;
            out.push((bits >> nbits) as u8);
            bits &= (1 << nbits) - 1;
        }
    }
    Some(out)
}

// ---------------------------------------------------------------- TOTP

/// RFC 4226 HOTP（HMAC-SHA1、動態截斷）。/ RFC 4226 HOTP.
pub fn hotp(secret: &[u8], counter: u64) -> u32 {
    let mut mac = <Hmac<sha1::Sha1> as Mac>::new_from_slice(secret).expect("HMAC takes any key length");
    mac.update(&counter.to_be_bytes());
    let h = mac.finalize().into_bytes();
    let off = (h[19] & 0x0f) as usize;
    let bin = ((h[off] as u32 & 0x7f) << 24) | ((h[off + 1] as u32) << 16) | ((h[off + 2] as u32) << 8) | h[off + 3] as u32;
    bin % 10u32.pow(TOTP_DIGITS)
}

pub fn totp_step(unix_secs: u64) -> u64 {
    unix_secs / TOTP_PERIOD
}

/// 驗證 6 位數碼：容許 ±1 個時間窗，而且時間窗必須比上次用過的晚（同一組碼不能重放）。回傳用掉的時間窗。
/// Verify a code within ±1 step that is newer than the last accepted step; returns the step used.
pub fn totp_verify(secret: &[u8], code: &str, unix_secs: u64, last_step: Option<i64>) -> Option<i64> {
    let code = code.trim().replace(' ', "");
    if code.len() != TOTP_DIGITS as usize || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let want: u32 = code.parse().ok()?;
    let now = totp_step(unix_secs) as i64;
    (-TOTP_SKEW..=TOTP_SKEW)
        .map(|d| now + d)
        .filter(|step| *step >= 0 && last_step.is_none_or(|last| *step > last))
        .find(|step| {
            use subtle::ConstantTimeEq;
            hotp(secret, *step as u64).to_be_bytes().ct_eq(&want.to_be_bytes()).into()
        })
}

pub fn new_totp_secret() -> Vec<u8> {
    let mut s = vec![0u8; TOTP_SECRET_BYTES];
    rand::thread_rng().fill_bytes(&mut s);
    s
}

/// `otpauth://totp/<issuer>:<account>?secret=…`（Google Authenticator Key URI 格式）。
pub fn otpauth_uri(issuer: &str, account: &str, secret_b32: &str) -> String {
    let label = urlencoding::encode(&format!("{issuer}:{account}")).into_owned();
    format!(
        "otpauth://totp/{label}?secret={secret_b32}&issuer={}&algorithm=SHA1&digits={TOTP_DIGITS}&period={TOTP_PERIOD}",
        urlencoding::encode(issuer)
    )
}

/// otpauth URI 的 QR code（SVG，前端直接嵌入）。/ The otpauth URI as an SVG QR code.
pub fn qr_svg(data: &str) -> String {
    match qrcode::QrCode::new(data.as_bytes()) {
        Ok(code) => code
            .render::<qrcode::render::svg::Color>()
            .min_dimensions(200, 200)
            .quiet_zone(true)
            .dark_color(qrcode::render::svg::Color("#000000"))
            .light_color(qrcode::render::svg::Color("#ffffff"))
            .build(),
        Err(_) => String::new(),
    }
}

// ---------------------------------------------------------------- secret encryption at rest

/// TOTP secret 用 SECRET_KEY 衍生的 AES-256-GCM 金鑰加密後才存 DB（DB 檔或備份外流時拿不到 secret）。
/// 換 SECRET_KEY 會讓既有的 TOTP 失效（使用者改用 passkey / 復原碼登入，或請管理員重設）。
/// TOTP secrets are encrypted with a key derived from SECRET_KEY; rotating SECRET_KEY invalidates them.
pub struct SecretBox(Aes256Gcm);

impl SecretBox {
    pub fn new(secret_key: &str) -> Self {
        let key = Sha256::digest(format!("telepy-mfa-v1:{secret_key}").as_bytes());
        Self(Aes256Gcm::new_from_slice(&key).expect("32-byte key"))
    }

    pub fn seal(&self, plaintext: &[u8]) -> String {
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let ct = self.0.encrypt(Nonce::from_slice(&nonce), plaintext).expect("AES-GCM encryption cannot fail");
        let mut blob = nonce.to_vec();
        blob.extend(ct);
        format!("v1:{}", STANDARD.encode(blob))
    }

    pub fn open(&self, sealed: &str) -> Option<Vec<u8>> {
        let blob = STANDARD.decode(sealed.strip_prefix("v1:")?).ok()?;
        if blob.len() < 12 + 16 {
            return None;
        }
        let (nonce, ct) = blob.split_at(12);
        self.0.decrypt(Nonce::from_slice(nonce), ct).ok()
    }
}

// ---------------------------------------------------------------- recovery codes

const RECOVERY_ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";

/// `xxxx-xxxx-xxxx`（去掉易混淆字元；約 59 bits）。/ Recovery code without ambiguous characters.
pub fn new_recovery_code() -> String {
    let mut rng = rand::thread_rng();
    let chars: String = (0..12).map(|_| RECOVERY_ALPHABET[(rng.next_u32() as usize) % RECOVERY_ALPHABET.len()] as char).collect();
    format!("{}-{}-{}", &chars[0..4], &chars[4..8], &chars[8..12])
}

/// 比對前正規化：小寫、去掉空白與連字號。/ Normalise before hashing: lowercase, no spaces or dashes.
pub fn normalize_recovery_code(code: &str) -> String {
    code.chars().filter(|c| !c.is_whitespace() && *c != '-').collect::<String>().to_ascii_lowercase()
}

pub fn hash_recovery_code(code: &str) -> String {
    crate::oauth::hash_token(&normalize_recovery_code(code))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_roundtrip_and_rfc4648_vectors() {
        assert_eq!(base32_encode(b"foobar"), "MZXW6YTBOI");
        assert_eq!(base32_encode(b"f"), "MY");
        assert_eq!(base32_decode("MZXW6YTBOI").unwrap(), b"foobar");
        assert_eq!(base32_decode("mzxw 6ytb oi==").unwrap(), b"foobar");
        assert!(base32_decode("not base32!").is_none());
        let s = new_totp_secret();
        assert_eq!(base32_decode(&base32_encode(&s)).unwrap(), s);
        assert_eq!(base32_encode(&s).len(), 32);
    }

    #[test]
    fn rfc6238_sha1_vectors() {
        // RFC 6238 附錄 B（取 8 位數的後 6 位）。/ RFC 6238 appendix B, last six digits.
        let secret = b"12345678901234567890";
        for (t, code) in [(59u64, 287082u32), (1111111109, 81804), (1111111111, 50471), (1234567890, 5924), (2000000000, 279037)] {
            assert_eq!(hotp(secret, totp_step(t)), code, "t={t}");
        }
    }

    #[test]
    fn totp_window_and_replay() {
        let secret = b"12345678901234567890";
        let t = 1111111111u64;
        let code = format!("{:06}", hotp(secret, totp_step(t)));
        let step = totp_step(t) as i64;
        assert_eq!(totp_verify(secret, &code, t, None), Some(step));
        assert_eq!(totp_verify(secret, &code, t + 30, None), Some(step), "one step late is accepted");
        assert_eq!(totp_verify(secret, &code, t + 90, None), None, "three steps late is not");
        assert_eq!(totp_verify(secret, &code, t, Some(step)), None, "the same step cannot be replayed");
        assert_eq!(totp_verify(secret, &format!("{} {}", &code[..3], &code[3..]), t, None), Some(step), "spaces are ignored");
        assert_eq!(totp_verify(secret, "12345", t, None), None);
        assert_eq!(totp_verify(secret, "abcdef", t, None), None);
    }

    #[test]
    fn otpauth_and_qr() {
        let uri = otpauth_uri("Telepy", "admin@telepy.example.com", "MZXW6YTBOI");
        assert_eq!(uri, "otpauth://totp/Telepy%3Aadmin%40telepy.example.com?secret=MZXW6YTBOI&issuer=Telepy&algorithm=SHA1&digits=6&period=30");
        let svg = qr_svg(&uri);
        assert!(svg.starts_with("<?xml") && svg.contains("<svg"), "{}", &svg[..60.min(svg.len())]);
    }

    #[test]
    fn secret_box_roundtrip_and_key_binding() {
        let a = SecretBox::new("key-a");
        let sealed = a.seal(b"secret");
        assert!(sealed.starts_with("v1:"));
        assert_ne!(sealed, a.seal(b"secret"), "random nonce");
        assert_eq!(a.open(&sealed).unwrap(), b"secret");
        assert!(SecretBox::new("key-b").open(&sealed).is_none(), "another SECRET_KEY cannot open it");
        assert!(a.open("v1:AAAA").is_none());
        assert!(a.open("garbage").is_none());
    }

    #[test]
    fn login_challenge_counts_failures_in_place() {
        let ch = LoginChallenge::new(7);
        let clone = ch.clone();
        for n in 1..CHALLENGE_ATTEMPTS {
            assert_eq!(clone.fail(), n);
            assert!(!ch.exhausted(), "attempt {n}");
        }
        assert_eq!(clone.fail(), CHALLENGE_ATTEMPTS);
        assert!(ch.exhausted(), "the clone shares the counter, so the cached challenge sees every failure");
    }

    #[test]
    fn recovery_codes() {
        let c = new_recovery_code();
        assert_eq!(c.len(), 14);
        assert_eq!(c.matches('-').count(), 2);
        assert!(c.chars().all(|ch| ch == '-' || RECOVERY_ALPHABET.contains(&(ch as u8))));
        assert_eq!(normalize_recovery_code(" ABCD-efgh jkmn "), "abcdefghjkmn");
        assert_eq!(hash_recovery_code("ABCD-EFGH-JKMN"), hash_recovery_code("abcdefghjkmn"));
    }
}
