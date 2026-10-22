//! Google 登入：驗證前端送來的 id_token（RS256，公鑰來自 Google JWKS，依 Cache-Control 快取）。
//! 取代 `google.oauth2.id_token.verify_oauth2_token`。
//! Google id_token verification against the cached JWKS, replacing google-auth.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use tokio::sync::RwLock;

const CERTS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS: [&str; 2] = ["accounts.google.com", "https://accounts.google.com"];

#[derive(Debug, Clone, Deserialize)]
pub struct GoogleClaims {
    pub sub: String,
    pub email: Option<String>,
    pub given_name: Option<String>,
    pub family_name: Option<String>,
    #[allow(dead_code)]
    pub email_verified: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct Jwk {
    kid: String,
    n: String,
    e: String,
    #[serde(default)]
    kty: String,
}

#[derive(Debug, Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

struct Cached {
    keys: HashMap<String, (String, String)>,
    fetched: Instant,
    ttl: Duration,
}

#[derive(Clone)]
pub struct GoogleVerifier {
    http: reqwest::Client,
    cache: Arc<RwLock<Option<Cached>>>,
}

#[derive(Debug, thiserror::Error)]
pub enum GoogleError {
    #[error("Backend SOCIAL_GOOGLE_CLIENT_ID is not configured")]
    NotConfigured,
    #[error("failed to fetch Google certificates: {0}")]
    Fetch(String),
    #[error("the Google token has expired")]
    Expired,
    /// token 的 aud 不是後端設定的 client ID：前端按鈕與後端的 SOCIAL_GOOGLE_CLIENT_ID 不一致（常見部署錯誤）。
    /// The token was issued for another client ID: the button and SOCIAL_GOOGLE_CLIENT_ID disagree.
    #[error("the Google token was issued for another client ID")]
    WrongAudience,
    #[error("invalid Google token: {0}")]
    Invalid(String),
}

impl GoogleVerifier {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http, cache: Arc::new(RwLock::new(None)) }
    }

    async fn keys(&self, force: bool) -> Result<HashMap<String, (String, String)>, GoogleError> {
        if !force {
            if let Some(c) = self.cache.read().await.as_ref() {
                if c.fetched.elapsed() < c.ttl {
                    return Ok(c.keys.clone());
                }
            }
        }
        let resp = self.http.get(CERTS_URL).send().await.map_err(|e| GoogleError::Fetch(e.to_string()))?;
        let ttl = resp
            .headers()
            .get(reqwest::header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').find_map(|p| p.trim().strip_prefix("max-age=").and_then(|s| s.parse::<u64>().ok())))
            .map(Duration::from_secs)
            .unwrap_or(Duration::from_secs(3600));
        let jwks: Jwks = resp.json().await.map_err(|e| GoogleError::Fetch(e.to_string()))?;
        let keys: HashMap<_, _> = jwks
            .keys
            .into_iter()
            .filter(|k| k.kty.is_empty() || k.kty == "RSA")
            .map(|k| (k.kid, (k.n, k.e)))
            .collect();
        *self.cache.write().await = Some(Cached { keys: keys.clone(), fetched: Instant::now(), ttl });
        Ok(keys)
    }

    pub async fn verify(&self, credential: &str, client_id: Option<&str>) -> Result<GoogleClaims, GoogleError> {
        let client_id = client_id.ok_or(GoogleError::NotConfigured)?;
        let header = decode_header(credential).map_err(|e| GoogleError::Invalid(e.to_string()))?;
        let kid = header.kid.ok_or_else(|| GoogleError::Invalid("missing kid".into()))?;
        let mut keys = self.keys(false).await?;
        if !keys.contains_key(&kid) {
            // 金鑰輪替：強制重抓一次。/ Key rotation: refetch once.
            keys = self.keys(true).await?;
        }
        let (n, e) = keys.get(&kid).ok_or_else(|| GoogleError::Invalid("unknown kid".into()))?;
        let key = DecodingKey::from_rsa_components(n, e).map_err(|e| GoogleError::Invalid(e.to_string()))?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_audience(&[client_id]);
        validation.set_issuer(&ISSUERS);
        let data = decode::<GoogleClaims>(credential, &key, &validation).map_err(|e| match e.kind() {
            jsonwebtoken::errors::ErrorKind::ExpiredSignature => GoogleError::Expired,
            jsonwebtoken::errors::ErrorKind::InvalidAudience => GoogleError::WrongAudience,
            _ => GoogleError::Invalid(e.to_string()),
        })?;
        Ok(data.claims)
    }
}
