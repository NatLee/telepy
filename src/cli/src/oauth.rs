//! `telepy login <url>`（沒有 `--token` 時）：OAuth 2.1 + PKCE，CLI 是動態註冊的公開 client，redirect 是 loopback
//! （`http://127.0.0.1:<隨機 port>/callback`，RFC 8252；Telepy 比對 loopback 時不看 port）。瀏覽器打開 Telepy 的同意頁，
//! 你在那裡選 scope 與隧道，回來的 code 換成 access + refresh token。
//! `telepy login <url>` without `--token`: OAuth 2.1 with PKCE as a dynamically registered public client and a
//! loopback redirect (RFC 8252; Telepy ignores the port for loopback). The browser opens Telepy's consent page,
//! where you pick scopes and tunnels; the code comes back and is exchanged for access + refresh tokens.
//! 瀏覽器等到換完 token 才拿到回應：伺服器有完成頁就導過去，否則是 CLI 自己的一頁（`signed_in`）。
//! The browser gets its answer only after the exchange: the server's done page when it has one, else the CLI's own
//! page (`signed_in`).

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::api::{self, read};
use crate::creds::Secret;
use crate::signed_in::{self, Failure, Outcome};

fn random(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// 回呼沒帶授權碼：OAuth 的錯誤碼（`access_denied`…，沒有就是 `invalid_request`）與說明。
/// A callback without a code: the OAuth error code (`access_denied`…, else `invalid_request`) and its description.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallbackError {
    pub code: String,
    pub message: String,
}

/// 回呼請求的第一行 → (code, state) 或錯誤。純函式。/ Parse the callback request line. Pure.
pub fn parse_callback(request_line: &str) -> Result<(String, String), CallbackError> {
    let bad = |m: &str| CallbackError { code: "invalid_request".into(), message: m.into() };
    let target = request_line.split_whitespace().nth(1).ok_or_else(|| bad("bad request"))?;
    let url = url::Url::parse(&format!("http://127.0.0.1{target}")).map_err(|_| bad("bad request"))?;
    let q: std::collections::HashMap<String, String> = url.query_pairs().into_owned().collect();
    if let Some(e) = q.get("error") {
        return Err(CallbackError { code: e.clone(), message: q.get("error_description").cloned().unwrap_or_else(|| e.clone()) });
    }
    match (q.get("code"), q.get("state")) {
        (Some(c), Some(s)) => Ok((c.clone(), s.clone())),
        _ => Err(bad("the callback had no code")),
    }
}

/// 回給瀏覽器：伺服器有完成頁 → 303 導過去；沒有 → CLI 自己的一頁。
/// Answer the browser: 303 to the server's done page when it has one, else the CLI's own page.
fn answer(stream: &mut std::net::TcpStream, done_page: Option<&str>, client_id: &str, accept_language: &str, outcome: Outcome) {
    let _ = match done_page.and_then(|p| signed_in::done_location(p, client_id, outcome)) {
        Some(location) => write!(stream, "HTTP/1.1 303 See Other\r\nlocation: {location}\r\ncache-control: no-store\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"),
        None => {
            let body = signed_in::fallback_page(signed_in::page_lang(accept_language), outcome);
            write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncache-control: no-store\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len())
        }
    };
    let _ = stream.flush();
}

fn open_browser(url: &str) -> bool {
    let mut cmd = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
    } else if cfg!(windows) {
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    } else {
        std::process::Command::new("xdg-open")
    };
    cmd.arg(url).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().is_ok()
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .or_else(|| std::process::Command::new("hostname").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()))
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "this computer".into())
}

pub struct Login {
    pub secret: Secret,
    pub client_id: String,
}

pub fn login(server: &str, scope: &str, no_browser: bool) -> Result<Login> {
    let http = api::http_client()?;
    let meta = read(http.get(format!("{server}/.well-known/oauth-authorization-server")).send().with_context(|| format!("cannot reach {server}"))?)
        .context("this server has no OAuth sign-in (is it a Telepy server?)")?;
    let endpoint = |k: &str| meta.get(k).and_then(Value::as_str).map(str::to_string).ok_or_else(|| anyhow!("the server's OAuth metadata has no {k}"));
    let (authorize, token, register) = (endpoint("authorization_endpoint")?, endpoint("token_endpoint")?, endpoint("registration_endpoint")?);
    // 換完 token 後瀏覽器去哪（Telepy 的擴充欄位；舊伺服器沒有）。/ Where the browser goes afterwards (a Telepy extension).
    let done_page = meta.get("telepy_cli_done_page").and_then(Value::as_str).map(str::to_string);

    let listener = TcpListener::bind("127.0.0.1:0").context("open a local port for the sign-in callback")?;
    let port = listener.local_addr()?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let reg = read(
        http.post(&register)
            .json(&json!({
                "client_name": format!("telepy CLI ({})", hostname()),
                "redirect_uris": ["http://127.0.0.1/callback"],
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
            }))
            .send()?,
    )
    .context("register the CLI with the server")?;
    let client_id = reg.get("client_id").and_then(Value::as_str).ok_or_else(|| anyhow!("registration returned no client_id"))?.to_string();

    let verifier = random(48);
    let state = random(16);
    let mut url = url::Url::parse(&authorize)?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect)
        .append_pair("code_challenge", &challenge(&verifier))
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("resource", &format!("{server}/mcp"));
    if !scope.trim().is_empty() {
        url.query_pairs_mut().append_pair("scope", scope.trim());
    }
    eprintln!("Opening Telepy in your browser to approve the CLI. If nothing opens, visit:\n\n  {url}\n");
    if !no_browser && !open_browser(url.as_str()) {
        eprintln!("(Could not start a browser.)");
    }

    // 等瀏覽器回呼（最多 10 分鐘，同意頁的授權碼也只活 10 分鐘）。/ Wait for the callback (10 minutes, like the code).
    listener.set_nonblocking(true)?;
    let deadline = Instant::now() + Duration::from_secs(600);
    let (mut stream, line, accept_language) = loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false)?;
                stream.set_read_timeout(Some(Duration::from_secs(10)))?;
                let mut reader = BufReader::new(stream.try_clone()?);
                let mut line = String::new();
                reader.read_line(&mut line)?;
                // 標頭讀到空行為止（要 Accept-Language）。/ Headers up to the blank line (for Accept-Language).
                let mut headers = Vec::new();
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).unwrap_or(0) == 0 || h.trim().is_empty() || headers.len() > 100 {
                        break;
                    }
                    headers.push(h);
                }
                if !line.contains("/callback") {
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
                    continue;
                }
                break (stream, line, signed_in::accept_language(headers.iter().map(String::as_str)));
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    bail!("Timed out waiting for the browser.");
                }
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(e) => return Err(e.into()),
        }
    };
    // 瀏覽器等著：先確認、換到 token，再告訴它結果（頁面說的才是真的）。
    // The browser waits while we check and exchange, so the page it gets tells the truth.
    let done = done_page.as_deref();
    let fail = |stream: &mut std::net::TcpStream, outcome: Outcome| answer(stream, done, &client_id, &accept_language, outcome);
    let (code, got_state) = match parse_callback(&line) {
        Ok(v) => v,
        Err(e) => {
            fail(&mut stream, if e.code == "access_denied" { Outcome::Denied } else { Outcome::Failed(Failure::Error) });
            bail!("The sign-in was not approved: {}", e.message);
        }
    };
    if got_state != state {
        fail(&mut stream, Outcome::Failed(Failure::State));
        bail!("The callback did not match this sign-in (state mismatch). Try again.");
    }
    let secret = http
        .post(&token)
        .form(&[("grant_type", "authorization_code"), ("code", code.as_str()), ("client_id", client_id.as_str()), ("code_verifier", verifier.as_str()), ("redirect_uri", redirect.as_str())])
        .send()
        .map_err(anyhow::Error::from)
        .and_then(read)
        .context("exchange the code for a token")
        .and_then(|v| api::secret_from_token_response(&v));
    let secret = match secret {
        Ok(s) => s,
        Err(e) => {
            fail(&mut stream, Outcome::Failed(Failure::Exchange));
            return Err(e);
        }
    };
    answer(&mut stream, done, &client_id, &accept_language, Outcome::Ok);
    Ok(Login { secret, client_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callbacks_and_pkce() {
        assert_eq!(parse_callback("GET /callback?code=abc&state=xyz&iss=https%3A%2F%2Ft HTTP/1.1"), Ok(("abc".into(), "xyz".into())));
        let denied = parse_callback("GET /callback?error=access_denied HTTP/1.1").unwrap_err();
        assert_eq!((denied.code.as_str(), denied.message.as_str()), ("access_denied", "access_denied"));
        let described = parse_callback("GET /callback?error=invalid_scope&error_description=no+such+scope HTTP/1.1").unwrap_err();
        assert_eq!((described.code.as_str(), described.message.as_str()), ("invalid_scope", "no such scope"));
        assert!(parse_callback("GET /callback HTTP/1.1").is_err());
        // RFC 7636 附錄 B 的範例。/ The RFC 7636 appendix B example.
        assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }
}
