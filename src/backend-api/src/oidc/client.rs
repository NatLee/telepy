//! 跟身分提供者講話：discovery 文件與 JWKS（各快取一小時；id_token 的 kid 不在快取裡就重抓一次，提供者換鑰匙時不必等）
//! 以及用 code 換 token。每個請求 10 秒為限。
//! Talking to the provider: the discovery document and the JWKS (cached an hour each; an id_token kid missing from the
//! cache refetches once, so a key rotation needs no wait) and the code exchange. Each request is limited to 10 s.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use jsonwebtoken::jwk::JwkSet;
use serde::Deserialize;

use super::{verify_id_token, Claims, Discovery, TokenError};

const CACHE_TTL: Duration = Duration::from_secs(3600);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

pub struct OidcClient {
    http: reqwest::Client,
    discovery: Mutex<HashMap<String, (Discovery, Instant)>>,
    jwks: Mutex<HashMap<String, (JwkSet, Instant)>>,
}

#[derive(Deserialize)]
struct TokenResponse {
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

impl OidcClient {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http, discovery: Mutex::new(HashMap::new()), jwks: Mutex::new(HashMap::new()) }
    }

    /// `<issuer>/.well-known/openid-configuration`，文件裡的 issuer 必須是同一個（只差結尾的 `/` 也算）。
    /// The discovery document; its issuer must be the same one (a trailing `/` aside).
    pub async fn discover(&self, issuer: &str, force: bool) -> Result<Discovery, String> {
        if !force {
            if let Some((d, at)) = self.discovery.lock().unwrap().get(issuer) {
                if at.elapsed() < CACHE_TTL {
                    return Ok(d.clone());
                }
            }
        }
        let url = format!("{}/.well-known/openid-configuration", issuer.trim_end_matches('/'));
        let resp = self.http.get(&url).timeout(REQUEST_TIMEOUT).send().await.map_err(|e| format!("could not reach {url}: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("{url} answered {}", resp.status()));
        }
        let d: Discovery = resp.json().await.map_err(|e| format!("{url} is not an OpenID discovery document: {e}"))?;
        if d.issuer.trim_end_matches('/') != issuer.trim_end_matches('/') {
            return Err(format!("the discovery document names another issuer ({}); use exactly that as the issuer", d.issuer));
        }
        if let Some(methods) = &d.code_challenge_methods_supported {
            if !methods.iter().any(|m| m == "S256") {
                return Err("the provider doesn't support PKCE with S256".into());
            }
        }
        self.discovery.lock().unwrap().insert(issuer.to_string(), (d.clone(), Instant::now()));
        Ok(d)
    }

    async fn jwks(&self, uri: &str, force: bool) -> Result<JwkSet, String> {
        if !force {
            if let Some((k, at)) = self.jwks.lock().unwrap().get(uri) {
                if at.elapsed() < CACHE_TTL {
                    return Ok(k.clone());
                }
            }
        }
        let resp = self.http.get(uri).timeout(REQUEST_TIMEOUT).send().await.map_err(|e| format!("could not fetch the signing keys: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("the signing keys ({uri}) answered {}", resp.status()));
        }
        let set: JwkSet = resp.json().await.map_err(|e| format!("the signing keys are not a JWK set: {e}"))?;
        self.jwks.lock().unwrap().insert(uri.to_string(), (set.clone(), Instant::now()));
        Ok(set)
    }

    /// 設定頁的「檢查」：一定重抓簽章金鑰，回有幾把。/ The settings check: refetch the signing keys, count them.
    pub async fn key_count(&self, d: &Discovery) -> Result<usize, String> {
        Ok(self.jwks(&d.jwks_uri, true).await?.keys.len())
    }

    /// 用 code 換 token（有 secret 用 client_secret_basic，沒有就是 public client，只靠 PKCE），回 id_token。
    /// Exchange the code (client_secret_basic with a secret, else a public client relying on PKCE); returns the id_token.
    pub async fn exchange(&self, d: &Discovery, client_id: &str, secret: Option<&str>, code: &str, redirect_uri: &str, verifier: &str) -> Result<String, String> {
        let mut form = vec![("grant_type", "authorization_code"), ("code", code), ("redirect_uri", redirect_uri), ("code_verifier", verifier)];
        let mut req = self.http.post(&d.token_endpoint).timeout(REQUEST_TIMEOUT).header("Accept", "application/json");
        match secret {
            Some(s) => req = req.basic_auth(urlencoding::encode(client_id), Some(urlencoding::encode(s))),
            None => form.push(("client_id", client_id)),
        }
        let resp = req.form(&form).send().await.map_err(|e| format!("could not reach the token endpoint: {e}"))?;
        let status = resp.status();
        let body: TokenResponse = resp.json().await.map_err(|e| format!("the token endpoint answered {status} without JSON: {e}"))?;
        if let Some(err) = body.error {
            return Err(match body.error_description {
                Some(d) => format!("the provider refused the code: {err} ({d})"),
                None => format!("the provider refused the code: {err}"),
            });
        }
        body.id_token.ok_or_else(|| format!("the token endpoint answered {status} without an id_token (is the `openid` scope allowed?)"))
    }

    /// 驗 id_token；kid 沒在快取的金鑰裡就重抓一次 JWKS。/ Verify the id_token, refetching the JWKS once for an unknown kid.
    pub async fn verify(&self, d: &Discovery, id_token: &str, client_id: &str, nonce: &str) -> Result<Claims, String> {
        let keys = self.jwks(&d.jwks_uri, false).await?;
        match verify_id_token(id_token, &keys, &d.issuer, client_id, nonce) {
            Err(TokenError::UnknownKey(_)) => {
                let keys = self.jwks(&d.jwks_uri, true).await?;
                verify_id_token(id_token, &keys, &d.issuer, client_id, nonce).map_err(|e| e.to_string())
            }
            other => other.map_err(|e| e.to_string()),
        }
    }
}
