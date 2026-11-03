//! VAPID（RFC 8292）：伺服器向推播服務證明「這則推播是訂閱時那台伺服器送的」。一把 P-256 金鑰，存在
//! `<DATA_DIR>/push/vapid.key`（0600），**不**用 SECRET_KEY 封存——換了 SECRET_KEY 也不能讓每台裝置的訂閱一起失效；
//! 這把金鑰一換，所有訂閱就得重訂。每則推播帶一個 ES256 簽的 JWT（`aud` = 推播服務的 origin，12 小時）。
//! VAPID (RFC 8292): the server proves to the push service that a push comes from the server the browser subscribed
//! to. One P-256 key in `<DATA_DIR>/push/vapid.key` (0600), deliberately **not** sealed with SECRET_KEY — rotating
//! SECRET_KEY must not invalidate every device's subscription; replacing this key does. Each push carries an
//! ES256-signed JWT (`aud` = the push service's origin, valid 12 hours).

use std::path::Path;

use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::SecretKey;
use serde_json::json;

use super::crypto::{b64, b64_encode, public_bytes, random_secret};

/// JWT 的有效時間（RFC 8292 上限 24 小時）。/ JWT lifetime (RFC 8292 allows up to 24 hours).
const JWT_SECS: i64 = 12 * 3600;

pub struct VapidKey {
    secret: SecretKey,
    public: String,
}

impl VapidKey {
    pub fn generate() -> Self {
        Self::from_secret(random_secret())
    }

    fn from_secret(secret: SecretKey) -> Self {
        let public = b64_encode(&public_bytes(&secret));
        Self { secret, public }
    }

    /// 檔案內容：`#` 開頭的說明行，加上一行私鑰（base64url 的 32 位元組）。/ The file: `#` comment lines plus the private key (base64url, 32 bytes).
    pub fn parse(text: &str) -> Result<Self, String> {
        let line = text.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#')).ok_or("the file holds no key")?;
        let bytes = b64(line).map_err(|e| e.to_string())?;
        let secret = SecretKey::from_slice(&bytes).map_err(|_| "not a P-256 private key".to_string())?;
        Ok(Self::from_secret(secret))
    }

    pub fn to_file_text(&self) -> String {
        format!(
            "# Telepy Web Push (VAPID) private key. Keep it: replacing it ends every device's push subscription.\n{}\n",
            b64_encode(&self.secret.to_bytes())
        )
    }

    /// 給瀏覽器 `applicationServerKey` 的公鑰（base64url、未壓縮）。/ The public key for the browser's `applicationServerKey`.
    pub fn public_key(&self) -> &str {
        &self.public
    }

    /// `Authorization: vapid t=<JWT>, k=<公鑰>`。`sub` = 聯絡方式（https 網址或 mailto）。/ The Authorization header value; `sub` = a contact (https URL or mailto).
    pub fn authorization(&self, endpoint: &url::Url, sub: &str, now: i64) -> Result<String, String> {
        let aud = audience(endpoint).ok_or("the endpoint has no origin")?;
        let header = b64_encode(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = b64_encode(json!({ "aud": aud, "exp": now + JWT_SECS, "sub": sub }).to_string().as_bytes());
        let signing = format!("{header}.{claims}");
        let sig: Signature = SigningKey::from(&self.secret).sign(signing.as_bytes());
        Ok(format!("vapid t={signing}.{}, k={}", b64_encode(&sig.to_bytes()), self.public))
    }
}

/// 推播服務的 origin（JWT 的 `aud`）。/ The push service's origin (the JWT's `aud`).
pub fn audience(endpoint: &url::Url) -> Option<String> {
    let host = endpoint.host_str()?;
    Some(match endpoint.port() {
        Some(p) => format!("{}://{host}:{p}", endpoint.scheme()),
        None => format!("{}://{host}", endpoint.scheme()),
    })
}

/// 讀檔；沒有就產生一把寫進去（0600，先寫暫存檔再改名）。/ Read the file, or create it (0600, written beside then renamed).
pub fn load_or_create(path: &Path) -> Result<VapidKey, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => return VapidKey::parse(&text).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(format!("{}: {e}", path.display())),
        Err(_) => {}
    }
    let key = VapidKey::generate();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("tmp");
    write_private(&tmp, &key.to_file_text()).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(key)
}

#[cfg(unix)]
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
    f.write_all(text.as_bytes())
}

#[cfg(not(unix))]
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    std::fs::write(path, text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;
    use p256::ecdsa::VerifyingKey;

    #[test]
    fn the_jwt_is_signed_for_the_push_service_origin() {
        let key = VapidKey::generate();
        let endpoint = url::Url::parse("https://fcm.googleapis.com/fcm/send/abc:def").unwrap();
        let auth = key.authorization(&endpoint, "https://telepy.example.com", 1_000).unwrap();
        let (t, k) = auth.strip_prefix("vapid t=").unwrap().split_once(", k=").unwrap();
        assert_eq!(k, key.public_key());
        let parts: Vec<&str> = t.split('.').collect();
        assert_eq!(parts.len(), 3);
        let claims: serde_json::Value = serde_json::from_slice(&b64(parts[1]).unwrap()).unwrap();
        assert_eq!(claims, json!({ "aud": "https://fcm.googleapis.com", "exp": 1_000 + JWT_SECS, "sub": "https://telepy.example.com" }));
        // 用公鑰驗得過（瀏覽器廠商就是這樣驗）。/ It verifies with the public key, as the push service does.
        let vk = VerifyingKey::from_sec1_bytes(&b64(k).unwrap()).unwrap();
        let sig = Signature::from_slice(&b64(parts[2]).unwrap()).unwrap();
        assert!(vk.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).is_ok());
        assert_eq!(audience(&url::Url::parse("https://push.example:8443/x").unwrap()).as_deref(), Some("https://push.example:8443"));
    }

    #[test]
    fn the_key_file_is_created_once_and_kept() {
        let dir = std::env::temp_dir().join(format!("telepy-vapid-{}", std::process::id()));
        let path = dir.join("push/vapid.key");
        let _ = std::fs::remove_dir_all(&dir);
        let first = load_or_create(&path).unwrap();
        let again = load_or_create(&path).unwrap();
        assert_eq!(first.public_key(), again.public_key(), "an existing key is never replaced");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::write(&path, "# broken\nnot-a-key\n").unwrap();
        assert!(load_or_create(&path).is_err(), "a broken file is an error, not silently replaced");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
