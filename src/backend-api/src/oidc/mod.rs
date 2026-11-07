//! OIDC 單一登入（Okta、Entra ID、Keycloak、Authentik、Google Workspace…）：Authorization Code + PKCE，後端是
//! confidential client。這個檔是純的部分（下面有測試）：PKCE、授權網址、id_token 驗證、使用者名稱、`next` 路徑檢查、
//! issuer 網址規則；`client.rs` 做 discovery / JWKS / 換 token（有快取），`flow.rs` 放進行中的登入與一次性票券。
//!
//! 流程：登入頁的按鈕 → `GET /api/auth/oidc/{slug}/start`（state、nonce、PKCE 記在記憶體，state 也綁一個 HttpOnly
//! cookie，防 login CSRF）→ 身分提供者 → `GET /api/auth/oidc/{slug}/callback`（每個提供者自己的路徑，防 mix-up）→
//! 換 code、驗 id_token → 找 / 建帳號 → `complete_login`（2FA 照舊）→ 一次性票券 → `/login?sso=<票券>` →
//! `POST /api/auth/oidc/redeem` 拿到跟密碼登入一樣的 JSON。
//!
//! OIDC single sign-on: Authorization Code + PKCE with the backend as a confidential client. This file is the pure part
//! (tested below): PKCE, the authorization URL, id_token verification, usernames, `next` checks, issuer URL rules;
//! `client.rs` does discovery / JWKS / the code exchange (cached), `flow.rs` holds pending sign-ins and one-time tickets.

pub mod client;
pub mod flow;
pub mod roles;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// 身分提供者的 discovery 文件（`/.well-known/openid-configuration`）裡我們用到的欄位。/ The discovery fields we use.
#[derive(Debug, Clone, Deserialize)]
pub struct Discovery {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub jwks_uri: String,
    #[serde(default)]
    pub end_session_endpoint: Option<String>,
    #[serde(default)]
    pub code_challenge_methods_supported: Option<Vec<String>>,
}

/// id_token 裡我們用到的 claim。/ The id_token claims we use.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Claims {
    pub sub: String,
    #[serde(default)]
    pub email: Option<String>,
    /// 有的提供者給字串 "true"。/ Some providers send the string "true".
    #[serde(default, deserialize_with = "bool_or_string")]
    pub email_verified: Option<bool>,
    #[serde(default)]
    pub preferred_username: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub given_name: Option<String>,
    #[serde(default)]
    pub family_name: Option<String>,
    #[serde(default)]
    pub nonce: Option<String>,
    #[serde(default)]
    pub azp: Option<String>,
    /// 原始 claim（測試登入給管理員看）。/ The raw claims (shown to admins by a test sign-in).
    #[serde(flatten)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}

fn bool_or_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(match v {
        Some(serde_json::Value::Bool(b)) => Some(b),
        Some(serde_json::Value::String(s)) => Some(s.eq_ignore_ascii_case("true")),
        _ => None,
    })
}

/// 簽章演算法白名單：只收非對稱的（`none` 與 HS* 永遠不收——HS 用公開的 client id / secret 就能偽造）。
/// Allowed signature algorithms: asymmetric only (never `none` or HS*).
pub const ALGORITHMS: &[Algorithm] = &[Algorithm::RS256, Algorithm::RS384, Algorithm::RS512, Algorithm::PS256, Algorithm::PS384, Algorithm::PS512, Algorithm::ES256, Algorithm::ES384, Algorithm::EdDSA];

/// 時鐘誤差容許。/ Clock skew allowed.
pub const LEEWAY_SECS: u64 = 60;

/// PKCE：(verifier, S256 challenge)。/ PKCE: (verifier, S256 challenge).
pub fn pkce_pair() -> (String, String) {
    let verifier = random_token(48);
    (verifier.clone(), challenge(&verifier))
}

pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// URL 安全的亂數字串。/ A URL-safe random string.
pub fn random_token(bytes: usize) -> String {
    use rand::RngCore;
    let mut b = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

pub struct AuthRequest<'a> {
    pub client_id: &'a str,
    pub redirect_uri: &'a str,
    pub scopes: &'a str,
    pub state: &'a str,
    pub nonce: &'a str,
    pub challenge: &'a str,
}

/// 授權網址：授權端點原本的查詢參數保留（有的提供者把租戶放在那裡）。/ The authorization URL; the endpoint's own query is kept.
pub fn authorize_url(endpoint: &str, r: &AuthRequest) -> Result<String, String> {
    let mut url = url::Url::parse(endpoint).map_err(|e| format!("bad authorization endpoint: {e}"))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", r.client_id)
        .append_pair("redirect_uri", r.redirect_uri)
        .append_pair("scope", r.scopes)
        .append_pair("state", r.state)
        .append_pair("nonce", r.nonce)
        .append_pair("code_challenge", r.challenge)
        .append_pair("code_challenge_method", "S256");
    Ok(url.to_string())
}

/// 身分提供者的登出網址（OpenID Connect RP-Initiated Logout 1.0）：`id_token_hint` 說是誰，登出後回到
/// `post_logout_redirect_uri`（要先在身分提供者那邊登記）；端點原本的查詢參數保留。
/// The provider's sign-out URL (RP-Initiated Logout 1.0): `id_token_hint` names the session, the browser comes back to
/// `post_logout_redirect_uri` (registered at the provider); the endpoint's own query is kept.
pub fn end_session_url(endpoint: &str, id_token: &str, post_logout_redirect_uri: &str, client_id: &str) -> Result<String, String> {
    let mut url = url::Url::parse(endpoint).map_err(|e| format!("bad end_session_endpoint: {e}"))?;
    if url.scheme() != "https" && !url.host_str().is_some_and(|h| h == "localhost" || h == "127.0.0.1" || h == "[::1]") {
        return Err("the end_session_endpoint is not https".into());
    }
    url.query_pairs_mut()
        .append_pair("id_token_hint", id_token)
        .append_pair("post_logout_redirect_uri", post_logout_redirect_uri)
        .append_pair("client_id", client_id);
    Ok(url.to_string())
}

/// scope 一定有 `openid`；空白整理過。/ Scopes always include `openid`; whitespace tidied.
pub fn normalize_scopes(raw: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for s in raw.split_whitespace() {
        if !out.contains(&s) {
            out.push(s);
        }
    }
    if !out.contains(&"openid") {
        out.insert(0, "openid");
    }
    out.join(" ")
}

/// issuer 網址：https；http 只給本機（測試、同一台的 Keycloak / Dex）。結尾的 `/` 拿掉。
/// An issuer URL: https; plain http only for loopback hosts. A trailing `/` is dropped.
pub fn check_issuer(raw: &str) -> Result<String, String> {
    let s = raw.trim().trim_end_matches('/');
    let url = url::Url::parse(s).map_err(|_| "Enter the issuer as a full URL, e.g. https://login.example.com/realms/main.".to_string())?;
    let loopback = matches!(url.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]"));
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return Err("The issuer must use https (plain http only for localhost).".into()),
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("The issuer URL can't have a query or a fragment.".into());
    }
    Ok(s.to_string())
}

/// 提供者的代號（網址的一段）：小寫英數與 `-`，1–32。/ A provider's slug (a URL segment): lowercase letters, digits, `-`.
pub fn check_slug(s: &str) -> Result<(), String> {
    let ok = !s.is_empty() && s.len() <= 32 && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') && !s.starts_with('-') && !s.ends_with('-');
    if ok {
        Ok(())
    } else {
        Err("Use 1–32 lowercase letters, digits and dashes (not at either end).".into())
    }
}

/// 從名字做代號（`Okta (prod)` → `okta-prod`）。/ A slug from a name.
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().to_ascii_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out: String = out.trim_end_matches('-').chars().take(32).collect();
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "sso".into()
    } else {
        out
    }
}

/// 使用者名稱從哪個 claim 來。/ Which claim the username comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsernameFrom {
    /// email 的 @ 前面（跟 Google 登入一樣）。/ The email's local part (like Google sign-in).
    Email,
    /// `preferred_username`（Keycloak、Entra 常用）；沒有就退回 email。/ `preferred_username`, else the email's local part.
    PreferredUsername,
}

impl UsernameFrom {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "email" => Some(Self::Email),
            "preferred_username" => Some(Self::PreferredUsername),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Email => "email",
            Self::PreferredUsername => "preferred_username",
        }
    }
}

/// Telepy 使用者名稱只收 Django 那套字元（字母、數字、`.@+-_`），其他換成 `-`，最長 150。
/// A Telepy username keeps Django's characters (letters, digits, `.@+-_`); others become `-`; at most 150.
pub fn clean_username(raw: &str) -> Option<String> {
    let s: String = raw.trim().chars().map(|c| if c.is_alphanumeric() || ".@+-_".contains(c) { c } else { '-' }).collect();
    let s = s.trim_matches('-').chars().take(150).collect::<String>();
    (!s.is_empty()).then_some(s)
}

/// 新帳號的使用者名稱。/ The username for a new account.
pub fn username_for(claims: &Claims, from: UsernameFrom) -> Option<String> {
    let from_email = || claims.email.as_deref().and_then(|e| e.split_once('@')).and_then(|(local, _)| clean_username(local));
    match from {
        UsernameFrom::Email => from_email(),
        UsernameFrom::PreferredUsername => {
            // Entra / Keycloak 的 preferred_username 常是 email：取 @ 前面。/ Often an email: take its local part.
            let p = claims.preferred_username.as_deref().map(|p| p.split_once('@').map(|(l, _)| l).unwrap_or(p));
            p.and_then(clean_username).or_else(from_email)
        }
    }
}

/// email 的網域（小寫）。/ The email's domain, lowercased.
pub fn email_domain(email: &str) -> Option<String> {
    email.rsplit_once('@').map(|(_, d)| d.trim().to_ascii_lowercase()).filter(|d| !d.is_empty())
}

/// 允許的網域清單（逗號或空白分開；空 = 不限，由身分提供者決定誰能登入）。/ Allowed domains; empty = any.
pub fn parse_domains(raw: &str) -> Vec<String> {
    raw.split(|c: char| c == ',' || c.is_whitespace()).map(|d| d.trim().trim_start_matches('@').to_ascii_lowercase()).filter(|d| !d.is_empty()).collect()
}

/// 登入後要回去的地方：只收站內路徑（`/` 開頭、不是 `//`、沒有反斜線）。/ Where to go after sign-in: same-site paths only.
pub fn safe_next(next: Option<&str>) -> Option<String> {
    let n = next?.trim();
    let ok = n.starts_with('/') && !n.starts_with("//") && !n.contains('\\') && !n.chars().any(|c| c.is_control()) && n.len() <= 2048;
    ok.then(|| n.to_string())
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TokenError {
    #[error("the id_token is malformed: {0}")]
    Malformed(String),
    #[error("the id_token is signed with {0:?}, which is not allowed")]
    Algorithm(String),
    #[error("no signing key matches the id_token (kid {0})")]
    UnknownKey(String),
    #[error("the id_token failed verification: {0}")]
    Invalid(String),
    #[error("the id_token's nonce doesn't match this sign-in")]
    Nonce,
    #[error("the id_token was issued to another client (azp)")]
    Azp,
}

/// 驗 id_token：簽章（JWKS 裡 kid 對得上的那把；沒有 kid 時只有一把才用）、演算法白名單、iss、aud、exp / nbf（容許 60 秒誤差）、
/// nonce，有好幾個 aud 時 azp 必須是我們。/ Verify an id_token: signature (the JWKS key with its kid, or the only one),
/// the algorithm allow-list, iss, aud, exp / nbf (60 s leeway), the nonce, and azp when there are several audiences.
pub fn verify_id_token(token: &str, jwks: &JwkSet, issuer: &str, client_id: &str, nonce: &str) -> Result<Claims, TokenError> {
    let header = decode_header(token).map_err(|e| TokenError::Malformed(e.to_string()))?;
    if !ALGORITHMS.contains(&header.alg) {
        return Err(TokenError::Algorithm(format!("{:?}", header.alg)));
    }
    let jwk = match &header.kid {
        Some(kid) => jwks.find(kid).ok_or_else(|| TokenError::UnknownKey(kid.clone()))?,
        None if jwks.keys.len() == 1 => &jwks.keys[0],
        None => return Err(TokenError::UnknownKey("(none)".into())),
    };
    let key = DecodingKey::from_jwk(jwk).map_err(|e| TokenError::Invalid(e.to_string()))?;
    let mut v = Validation::new(header.alg);
    v.set_issuer(&[issuer]);
    v.set_audience(&[client_id]);
    v.leeway = LEEWAY_SECS;
    v.validate_nbf = true;
    v.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    let data = decode::<Claims>(token, &key, &v).map_err(|e| TokenError::Invalid(e.to_string()))?;
    let claims = data.claims;
    if claims.nonce.as_deref() != Some(nonce) {
        return Err(TokenError::Nonce);
    }
    // aud 有好幾個時，azp 必須是我們（OIDC Core 3.1.3.7）。/ With several audiences, azp must be us.
    let several = matches!(claims.rest.get("aud"), Some(serde_json::Value::Array(a)) if a.len() > 1);
    if (several || claims.azp.is_some()) && claims.azp.as_deref().is_some_and(|a| a != client_id) {
        return Err(TokenError::Azp);
    }
    if several && claims.azp.is_none() {
        return Err(TokenError::Azp);
    }
    Ok(claims)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};

    /// 測試用的 P-256 金鑰（只在測試裡）。/ A P-256 test key, tests only.
    pub const TEST_EC_PEM: &str = "-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgoOS0b1VN1vPoF+hx
6a2O0kY/iM9BA4hhi4I0XC/9WIuhRANCAARtrvl4kHvci1sPgu/3SF6jp84zZZG6
4yQ1Oh1oLTPd54lw2rE/iCdhzEIJ4UdlLqlNHFpfOt39XfoxaBFatAoT
-----END PRIVATE KEY-----";

    pub fn test_jwks() -> JwkSet {
        serde_json::from_value(serde_json::json!({"keys": [{
            "kty": "EC", "crv": "P-256", "kid": "k1", "alg": "ES256", "use": "sig",
            "x": "ba75eJB73ItbD4Lv90heo6fOM2WRuuMkNTodaC0z3ec",
            "y": "iXDasT-IJ2HMQgnhR2UuqU0cWl863f1d-jFoEVq0ChM"
        }]}))
        .unwrap()
    }

    pub fn sign(claims: serde_json::Value, kid: Option<&str>, alg: Algorithm) -> String {
        let mut h = Header::new(alg);
        h.kid = kid.map(str::to_string);
        encode(&h, &claims, &EncodingKey::from_ec_pem(TEST_EC_PEM.as_bytes()).unwrap()).unwrap()
    }

    fn now() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
    }

    fn good() -> serde_json::Value {
        serde_json::json!({"iss": "https://idp.example", "aud": "telepy", "sub": "u-1", "exp": now() + 300, "iat": now(), "nonce": "n1", "email": "alice@corp.example", "email_verified": "true", "preferred_username": "alice.w"})
    }

    #[test]
    fn the_sign_out_url_names_the_session_and_the_way_back() {
        let u = end_session_url("https://idp.example/logout?tenant=t1", "eyJ.a.b", "https://telepy.example/login", "telepy").unwrap();
        assert_eq!(u, "https://idp.example/logout?tenant=t1&id_token_hint=eyJ.a.b&post_logout_redirect_uri=https%3A%2F%2Ftelepy.example%2Flogin&client_id=telepy");
        assert!(end_session_url("http://idp.example/logout", "t", "https://x/login", "c").is_err(), "plain http only for loopback");
        assert!(end_session_url("http://127.0.0.1:9/logout", "t", "https://x/login", "c").is_ok());
    }

    #[test]
    fn a_good_id_token_verifies_and_reads_its_claims() {
        let t = sign(good(), Some("k1"), Algorithm::ES256);
        let c = verify_id_token(&t, &test_jwks(), "https://idp.example", "telepy", "n1").unwrap();
        assert_eq!((c.sub.as_str(), c.email.as_deref(), c.email_verified), ("u-1", Some("alice@corp.example"), Some(true)));
        assert_eq!(username_for(&c, UsernameFrom::Email).as_deref(), Some("alice"));
        assert_eq!(username_for(&c, UsernameFrom::PreferredUsername).as_deref(), Some("alice.w"));
        // kid 沒給、JWKS 只有一把：用那把。/ No kid and a single key: that key.
        let t = sign(good(), None, Algorithm::ES256);
        assert!(verify_id_token(&t, &test_jwks(), "https://idp.example", "telepy", "n1").is_ok());
    }

    #[test]
    fn every_check_refuses_its_own_kind_of_bad_token() {
        let jwks = test_jwks();
        let with = |patch: serde_json::Value| {
            let mut c = good();
            for (k, v) in patch.as_object().unwrap() {
                c[k] = v.clone();
            }
            sign(c, Some("k1"), Algorithm::ES256)
        };
        let check = |t: &str| verify_id_token(t, &jwks, "https://idp.example", "telepy", "n1");
        assert!(matches!(check(&with(serde_json::json!({"iss": "https://evil.example"}))), Err(TokenError::Invalid(_))));
        assert!(matches!(check(&with(serde_json::json!({"aud": "someone-else"}))), Err(TokenError::Invalid(_))));
        assert!(matches!(check(&with(serde_json::json!({"exp": now() - 600}))), Err(TokenError::Invalid(_))));
        assert!(matches!(check(&with(serde_json::json!({"nonce": "other"}))), Err(TokenError::Nonce)));
        assert!(matches!(check(&with(serde_json::json!({"aud": ["telepy", "other"]}))), Err(TokenError::Azp)), "several audiences need azp");
        assert!(check(&with(serde_json::json!({"aud": ["telepy", "other"], "azp": "telepy"}))).is_ok());
        assert!(matches!(check(&with(serde_json::json!({"azp": "other"}))), Err(TokenError::Azp)));
        assert!(matches!(check(&sign(good(), Some("nope"), Algorithm::ES256)), Err(TokenError::UnknownKey(_))));
        // 改過的簽章。/ A tampered signature.
        let t = with(serde_json::json!({}));
        let mut parts: Vec<&str> = t.split('.').collect();
        let forged = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({"iss": "https://idp.example", "aud": "telepy", "sub": "admin", "exp": now() + 300, "nonce": "n1"})).unwrap());
        parts[1] = &forged;
        assert!(matches!(check(&parts.join(".")), Err(TokenError::Invalid(_))));
        // HS256 / none 永遠不收。/ HS256 and none are never accepted.
        let hs = encode(&Header::new(Algorithm::HS256), &good(), &EncodingKey::from_secret(b"telepy")).unwrap();
        assert!(matches!(check(&hs), Err(TokenError::Algorithm(_))));
        assert!(matches!(check("eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0."), Err(TokenError::Malformed(_)) | Err(TokenError::Algorithm(_))));
    }

    #[test]
    fn urls_scopes_slugs_and_next() {
        let url = authorize_url(
            "https://idp.example/authorize?tenant=t1",
            &AuthRequest { client_id: "telepy", redirect_uri: "https://t.example/api/auth/oidc/okta/callback", scopes: "openid email", state: "s", nonce: "n", challenge: "c" },
        )
        .unwrap();
        assert!(url.starts_with("https://idp.example/authorize?tenant=t1&response_type=code&client_id=telepy&redirect_uri=https%3A%2F%2Ft.example%2Fapi%2Fauth%2Foidc%2Fokta%2Fcallback"), "{url}");
        assert!(url.contains("code_challenge=c&code_challenge_method=S256"));
        assert_eq!(normalize_scopes("email  profile email"), "openid email profile");
        assert_eq!(normalize_scopes("openid"), "openid");
        assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "RFC 7636 appendix B");
        assert_eq!(check_issuer("https://login.example.com/realms/main/").unwrap(), "https://login.example.com/realms/main");
        assert!(check_issuer("http://login.example.com").is_err());
        assert!(check_issuer("http://127.0.0.1:5556/dex").is_ok());
        assert!(check_issuer("https://x.example/?a=1").is_err());
        assert_eq!(slugify("Okta (prod)"), "okta-prod");
        assert_eq!(slugify("  微軟 Entra ID "), "entra-id");
        assert_eq!(slugify("!!!"), "sso");
        assert!(check_slug("okta-prod").is_ok() && check_slug("-x").is_err() && check_slug("Okta").is_err() && check_slug("").is_err());
        assert_eq!(safe_next(Some("/tunnels?x=1")).as_deref(), Some("/tunnels?x=1"));
        for bad in ["//evil.example", "https://evil.example", "/\\evil", "tunnels", ""] {
            assert_eq!(safe_next(Some(bad)), None, "{bad}");
        }
        assert_eq!(parse_domains("Corp.example, @lab.example  x.org"), ["corp.example", "lab.example", "x.org"]);
        assert_eq!(email_domain("a@Corp.Example").as_deref(), Some("corp.example"));
    }

    #[test]
    fn usernames_are_tidied_and_fall_back_to_the_email() {
        let c = |email: Option<&str>, pref: Option<&str>| Claims { sub: "s".into(), email: email.map(String::from), preferred_username: pref.map(String::from), ..Default::default() };
        assert_eq!(username_for(&c(Some("bob@x.org"), Some("Bob Smith")), UsernameFrom::PreferredUsername).as_deref(), Some("Bob-Smith"));
        assert_eq!(username_for(&c(Some("bob@x.org"), Some("bob@corp.x")), UsernameFrom::PreferredUsername).as_deref(), Some("bob"), "an email-shaped preferred_username");
        assert_eq!(username_for(&c(Some("bob@x.org"), None), UsernameFrom::PreferredUsername).as_deref(), Some("bob"));
        assert_eq!(username_for(&c(None, None), UsernameFrom::Email), None);
        assert_eq!(username_for(&c(Some("陳 小明@x.org"), None), UsernameFrom::Email).as_deref(), Some("陳-小明"));
    }
}
