//! Passkey（WebAuthn）：relying party 設定與進行中儀式（ceremony）的暫存。
//!
//! RP ID = issuer 的 host（`PUBLIC_URL`，沒設則依 X-Forwarded-* 推導，與 OAuth 相同），origin = issuer。
//! 瀏覽器只在「網域名稱 + HTTPS」（或 localhost）上提供 passkey，所以 IP 位址部署無法使用。
//! 儀式狀態只放記憶體（5 分鐘、取用即刪）：webauthn-rs 要求伺服器端保存，避免重放。
//! Passkeys: relying-party configuration and in-flight ceremony state (memory only, single use).

use std::net::IpAddr;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use moka::sync::Cache;
use webauthn_rs::prelude::{DiscoverableAuthentication, PasskeyAuthentication, PasskeyRegistration, Url, Webauthn, WebauthnBuilder};

pub const CEREMONY_TTL: Duration = Duration::from_secs(300);
pub const MAX_NAME_CHARS: usize = 100;

/// 建一個 RP（每個請求依 issuer 建；不做 I/O，很便宜）。/ Build the relying party for an issuer.
pub fn relying_party(issuer: &str) -> Result<Webauthn, String> {
    let origin = Url::parse(issuer).map_err(|_| format!("invalid public URL: {issuer}"))?;
    let rp_id = origin.host_str().ok_or("the public URL has no host")?.to_string();
    let bare = rp_id.trim_start_matches('[').trim_end_matches(']');
    if bare.parse::<IpAddr>().is_ok() {
        return Err("Passkeys need a domain name: browsers do not offer them on IP addresses. Set PUBLIC_URL to the site's https URL.".into());
    }
    let mut builder = WebauthnBuilder::new(&rp_id, &origin).map_err(|e| format!("passkeys are not available for {issuer}: {e}"))?.rp_name("Telepy");
    if rp_id == "localhost" {
        // 開發：前端 dev server 與後端可能不同 port。/ Dev: the frontend dev server may use another port.
        builder = builder.allow_any_port(true);
    }
    builder.build().map_err(|e| format!("passkeys are not available for {issuer}: {e}"))
}

/// 用途：登入第二步，或敏感操作前的再驗證。/ What an assertion is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    Mfa,
    Reauth,
}

#[derive(Clone)]
pub enum Ceremony {
    Register { user_id: i64, state: PasskeyRegistration },
    /// 免帳號登入（discoverable credential）。/ Usernameless login.
    Login(DiscoverableAuthentication),
    Assert { user_id: i64, purpose: Purpose, state: PasskeyAuthentication },
}

pub struct Ceremonies(Cache<String, Ceremony>);

impl Default for Ceremonies {
    fn default() -> Self {
        Self(Cache::builder().time_to_live(CEREMONY_TTL).max_capacity(10_000).build())
    }
}

impl Ceremonies {
    pub fn start(&self, c: Ceremony) -> String {
        let id = crate::oauth::random_token("");
        self.0.insert(id.clone(), c);
        id
    }
    /// 取用即刪。/ Single use.
    pub fn take(&self, id: &str) -> Option<Ceremony> {
        self.0.remove(id)
    }
}

pub fn credential_id_b64(raw: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relying_party_rules() {
        assert!(relying_party("https://telepy.example.com").is_ok());
        assert!(relying_party("http://localhost:8787").is_ok());
        assert!(relying_party("http://192.168.1.10:8787").unwrap_err().contains("domain name"));
        assert!(relying_party("http://[::1]:8787").unwrap_err().contains("domain name"));
    }

    #[test]
    fn ceremonies_are_single_use() {
        let c = Ceremonies::default();
        let rp = relying_party("https://telepy.example.com").unwrap();
        let (_, state) = rp.start_discoverable_authentication().unwrap();
        let id = c.start(Ceremony::Login(state));
        assert!(c.take(&id).is_some());
        assert!(c.take(&id).is_none());
    }
}
