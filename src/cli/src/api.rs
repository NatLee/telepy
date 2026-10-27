//! 對 Telepy 的 HTTP 呼叫：帶 Bearer（API token 或 OAuth access token；OAuth 快到期時先用 refresh token 換新的並存回去），
//! 錯誤轉成看得懂的訊息（後端的 `{error}` / `{detail}` / `code`）。
//! HTTP calls to Telepy with the bearer (an API token, or an OAuth access token renewed with the refresh token
//! shortly before it expires and saved back); errors become readable messages from the backend's body.

use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use reqwest::blocking::{Client, RequestBuilder, Response};
use reqwest::Method;
use serde_json::Value;

use crate::creds::{self, Kind, Profile, Secret};

pub const USER_AGENT: &str = concat!("telepy-cli/", env!("CARGO_PKG_VERSION"));

enum Auth {
    Token(String),
    Oauth { secret: Secret, client_id: String },
}

pub struct Api {
    pub server: String,
    http: Client,
    auth: Mutex<Auth>,
    /// 從環境變數來的就不寫回（CI）。/ From the environment: never written back (CI).
    persist: bool,
}

/// HTTP 錯誤（狀態碼 + 後端的 body）。/ An HTTP error with the backend's body.
#[derive(Debug)]
pub struct HttpError {
    pub status: u16,
    pub body: Value,
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let msg = ["error", "detail", "error_description"].iter().find_map(|k| self.body.get(*k).and_then(Value::as_str)).map(str::to_string).unwrap_or_else(|| {
            // DRF 的欄位錯誤 `{field: [msg]}`。/ DRF field errors.
            self.body
                .as_object()
                .and_then(|o| o.iter().find_map(|(k, v)| v.as_array().and_then(|a| a.first()).and_then(Value::as_str).map(|m| format!("{k}: {m}"))))
                .unwrap_or_else(|| self.body.to_string())
        });
        write!(f, "{msg} (HTTP {})", self.status)?;
        match self.body.get("code").and_then(Value::as_str) {
            Some("token_scope") => write!(f, "\n  The token lacks this scope: create one that has it, or `telepy login <url> --scope …` again."),
            Some("token_route") => write!(f, "\n  Tokens can't do this; use the Telepy web app."),
            Some("token_tunnels") => write!(f, "\n  The token is limited to some tunnels; this needs a token without a tunnel limit."),
            Some("admin_only") => write!(f, "\n  Only admins can see everyone's; leave out --all / --user."),
            Some("step_up_required") => write!(f, "\n  This tunnel asks you to confirm it's you in the web app; tokens can't."),
            _ => Ok(()),
        }
    }
}

impl std::error::Error for HttpError {}

pub fn http_client() -> Result<Client> {
    Ok(Client::builder().user_agent(USER_AGENT).connect_timeout(Duration::from_secs(15)).build()?)
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

impl Api {
    /// `--server` / `TELEPY_URL` 與 `--token` / `TELEPY_TOKEN` 優先，否則用 `telepy login` 存的。
    /// Flags / environment first, else what `telepy login` stored.
    pub fn open(server: Option<&str>, token: Option<&str>) -> Result<Api> {
        let http = http_client()?;
        if let Some(t) = token.filter(|t| !t.is_empty()) {
            let server = server.map(creds::normalize_server).or_else(|| creds::load_profile().map(|p| p.server)).ok_or_else(|| anyhow!("Which server? Pass --server <url> or set TELEPY_URL."))?;
            return Ok(Api { server, http, auth: Mutex::new(Auth::Token(t.to_string())), persist: false });
        }
        let profile = creds::load_profile().ok_or_else(|| anyhow!("Not signed in. Run `telepy login <url>` first."))?;
        if let Some(s) = server.map(creds::normalize_server) {
            if s != profile.server {
                bail!("You are signed in to {}, not {s}. Run `telepy login {s}`.", profile.server);
            }
        }
        let secret = creds::load_secret(&profile.server).ok_or_else(|| anyhow!("The stored sign-in for {} is gone. Run `telepy login {}` again.", profile.server, profile.server))?;
        let auth = match profile.kind {
            Kind::Token => Auth::Token(secret.access),
            Kind::Oauth => Auth::Oauth { secret, client_id: profile.client_id.clone().unwrap_or_default() },
        };
        Ok(Api { server: profile.server, http, auth: Mutex::new(auth), persist: true })
    }

    pub fn with_token(server: &str, token: &str) -> Result<Api> {
        Ok(Api { server: creds::normalize_server(server), http: http_client()?, auth: Mutex::new(Auth::Token(token.to_string())), persist: false })
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.server)
    }

    pub fn is_token(&self) -> bool {
        matches!(*self.auth.lock().unwrap(), Auth::Token(_))
    }

    /// 現在的 Bearer；OAuth 剩不到一分鐘就先換。/ The bearer now; OAuth renews when under a minute is left.
    fn bearer(&self, force_refresh: bool) -> Result<String> {
        let mut auth = self.auth.lock().unwrap();
        match &mut *auth {
            Auth::Token(t) => Ok(t.clone()),
            Auth::Oauth { secret, client_id } => {
                let due = secret.expires_at.map(|e| e - 60 <= now()).unwrap_or(false);
                if (due || force_refresh) && secret.refresh.is_some() {
                    let fresh = refresh(&self.http, &self.server, client_id, secret.refresh.as_deref().unwrap_or_default())?;
                    *secret = fresh;
                    if self.persist {
                        creds::save_secret(&self.server, secret)?;
                    }
                }
                Ok(secret.access.clone())
            }
        }
    }

    pub fn request(&self, method: Method, path: &str) -> Result<RequestBuilder> {
        Ok(self.http.request(method, self.url(path)).bearer_auth(self.bearer(false)?).timeout(Duration::from_secs(120)))
    }

    /// 送出；OAuth 被 401 時換一次 token 再送。/ Send; on a 401 with OAuth, renew once and retry.
    pub fn send(&self, method: Method, path: &str, body: Option<&Value>, timeout: Option<Duration>) -> Result<Response> {
        let build = |bearer: String| {
            let mut rb = self.http.request(method.clone(), self.url(path)).bearer_auth(bearer).timeout(timeout.unwrap_or(Duration::from_secs(120)));
            if let Some(b) = body {
                rb = rb.json(b);
            }
            rb
        };
        let res = build(self.bearer(false)?).send().with_context(|| format!("cannot reach {}", self.server))?;
        if res.status() == 401 && !self.is_token() {
            return build(self.bearer(true)?).send().with_context(|| format!("cannot reach {}", self.server));
        }
        Ok(res)
    }

    pub fn json(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Value> {
        self.json_timeout(method, path, body, None)
    }

    pub fn json_timeout(&self, method: Method, path: &str, body: Option<&Value>, timeout: Option<Duration>) -> Result<Value> {
        let res = self.send(method, path, body, timeout)?;
        read(res)
    }

    pub fn get(&self, path: &str) -> Result<Value> {
        self.json(Method::GET, path, None)
    }
}

pub fn read(res: Response) -> Result<Value> {
    let status = res.status().as_u16();
    let text = res.text().unwrap_or_default();
    let body: Value = if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::String(text)) };
    if status >= 400 {
        return Err(HttpError { status, body }.into());
    }
    Ok(body)
}

/// OAuth refresh_token（每次都輪替）。/ The OAuth refresh grant (rotated on every use).
pub fn refresh(http: &Client, server: &str, client_id: &str, refresh_token: &str) -> Result<Secret> {
    let res = http
        .post(format!("{server}/api/oauth/token"))
        .form(&[("grant_type", "refresh_token"), ("refresh_token", refresh_token), ("client_id", client_id)])
        .send()
        .context("renew the sign-in")?;
    let v = read(res).map_err(|e| anyhow!("Your sign-in expired ({e}). Run `telepy login {server}` again."))?;
    secret_from_token_response(&v)
}

pub fn secret_from_token_response(v: &Value) -> Result<Secret> {
    let access = v.get("access_token").and_then(Value::as_str).ok_or_else(|| anyhow!("no access_token in the response"))?.to_string();
    Ok(Secret { access, refresh: v.get("refresh_token").and_then(Value::as_str).map(str::to_string), expires_at: v.get("expires_in").and_then(Value::as_i64).map(|s| now() + s) })
}

pub fn profile_of(kind: Kind, server: &str, client_id: Option<String>, username: Option<String>, store: &str) -> Profile {
    Profile { server: server.to_string(), kind, client_id, username, store: Some(store.to_string()) }
}
