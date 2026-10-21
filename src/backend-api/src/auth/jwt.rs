//! simplejwt 相容的 HS256 token：claims `{token_type, exp, iat, jti, user_id}`。
//! 用同一把 SECRET_KEY 簽，切換當下既有 token 不失效。
//! simplejwt-compatible HS256 tokens signed with the same SECRET_KEY as the Django backend.

use std::time::Duration;

use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub token_type: String,
    pub exp: i64,
    pub iat: i64,
    pub jti: String,
    pub user_id: i64,
}

#[derive(Clone)]
pub struct Jwt {
    enc: EncodingKey,
    dec: DecodingKey,
    access_lifetime: Duration,
    refresh_lifetime: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenType {
    Access,
    Refresh,
}

impl TokenType {
    fn as_str(self) -> &'static str {
        match self {
            TokenType::Access => "access",
            TokenType::Refresh => "refresh",
        }
    }
}

impl Jwt {
    pub fn new(secret: &str, access_lifetime: Duration, refresh_lifetime: Duration) -> Self {
        Self {
            enc: EncodingKey::from_secret(secret.as_bytes()),
            dec: DecodingKey::from_secret(secret.as_bytes()),
            access_lifetime,
            refresh_lifetime,
        }
    }

    fn issue(&self, user_id: i64, kind: TokenType) -> String {
        let now = chrono::Utc::now().timestamp();
        let life = match kind {
            TokenType::Access => self.access_lifetime,
            TokenType::Refresh => self.refresh_lifetime,
        };
        let claims = Claims {
            token_type: kind.as_str().to_string(),
            exp: now + life.as_secs() as i64,
            iat: now,
            jti: crate::util::uuid_hex(),
            user_id,
        };
        encode(&Header::new(Algorithm::HS256), &claims, &self.enc).expect("HS256 encoding cannot fail")
    }

    pub fn access(&self, user_id: i64) -> String {
        self.issue(user_id, TokenType::Access)
    }

    pub fn refresh(&self, user_id: i64) -> String {
        self.issue(user_id, TokenType::Refresh)
    }

    /// 驗簽 + exp + token_type。/ Verify signature, expiry and token type.
    pub fn verify(&self, token: &str, kind: TokenType) -> Result<Claims, jsonwebtoken::errors::Error> {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.leeway = 0;
        validation.validate_exp = true;
        validation.required_spec_claims.clear();
        validation.required_spec_claims.insert("exp".to_string());
        let data = decode::<Claims>(token, &self.dec, &validation)?;
        if data.claims.token_type != kind.as_str() {
            return Err(jsonwebtoken::errors::ErrorKind::InvalidToken.into());
        }
        Ok(data.claims)
    }

    /// `/token/verify`：任一型別皆可（simplejwt 的 UntypedToken）。
    pub fn verify_any(&self, token: &str) -> Result<Claims, jsonwebtoken::errors::Error> {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.leeway = 0;
        validation.required_spec_claims.clear();
        validation.required_spec_claims.insert("exp".to_string());
        Ok(decode::<Claims>(token, &self.dec, &validation)?.claims)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_type_check() {
        let j = Jwt::new("k", Duration::from_secs(60), Duration::from_secs(120));
        let a = j.access(7);
        let r = j.refresh(7);
        assert_eq!(j.verify(&a, TokenType::Access).unwrap().user_id, 7);
        assert!(j.verify(&a, TokenType::Refresh).is_err());
        assert_eq!(j.verify(&r, TokenType::Refresh).unwrap().token_type, "refresh");
        assert!(Jwt::new("other", Duration::from_secs(60), Duration::from_secs(60)).verify(&a, TokenType::Access).is_err());
    }
}
