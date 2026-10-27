//! `telepy login <url>`（沒有 `--token` 時）：OAuth 2.1 + PKCE，CLI 是動態註冊的公開 client，redirect 是 loopback
//! （`http://127.0.0.1:<隨機 port>/callback`，RFC 8252；Telepy 比對 loopback 時不看 port）。瀏覽器打開 Telepy 的同意頁，
//! 你在那裡選 scope 與隧道，回來的 code 換成 access + refresh token。
//! `telepy login <url>` without `--token`: OAuth 2.1 with PKCE as a dynamically registered public client and a
//! loopback redirect (RFC 8252; Telepy ignores the port for loopback). The browser opens Telepy's consent page,
//! where you pick scopes and tunnels; the code comes back and is exchanged for access + refresh tokens.

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

fn random(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// 回呼請求的第一行 → (code, state) 或錯誤。純函式。/ Parse the callback request line. Pure.
pub fn parse_callback(request_line: &str) -> Result<(String, String), String> {
    let target = request_line.split_whitespace().nth(1).ok_or("bad request")?;
    let url = url::Url::parse(&format!("http://127.0.0.1{target}")).map_err(|_| "bad request".to_string())?;
    let q: std::collections::HashMap<String, String> = url.query_pairs().into_owned().collect();
    if let Some(e) = q.get("error") {
        return Err(q.get("error_description").cloned().unwrap_or_else(|| e.clone()));
    }
    match (q.get("code"), q.get("state")) {
        (Some(c), Some(s)) => Ok((c.clone(), s.clone())),
        _ => Err("the callback had no code".into()),
    }
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
    let (code, got_state) = loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false)?;
                let mut line = String::new();
                BufReader::new(&stream).read_line(&mut line)?;
                if !line.contains("/callback") {
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n");
                    continue;
                }
                let outcome = parse_callback(&line);
                let page = match &outcome {
                    Ok(_) => "Signed in. You can close this tab and go back to the terminal.",
                    Err(_) => "The sign-in did not finish. Go back to the terminal for details.",
                };
                let body = format!("<!doctype html><meta charset=utf-8><title>telepy</title><body style=\"font-family:system-ui;padding:3rem\"><p>{page}</p>");
                let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                match outcome {
                    Ok(v) => break v,
                    Err(e) => bail!("The sign-in was not approved: {e}"),
                }
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
    if got_state != state {
        bail!("The callback did not match this sign-in (state mismatch). Try again.");
    }
    let v = read(
        http.post(&token)
            .form(&[("grant_type", "authorization_code"), ("code", code.as_str()), ("client_id", client_id.as_str()), ("code_verifier", verifier.as_str()), ("redirect_uri", redirect.as_str())])
            .send()?,
    )
    .context("exchange the code for a token")?;
    Ok(Login { secret: api::secret_from_token_response(&v)?, client_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callbacks_and_pkce() {
        assert_eq!(parse_callback("GET /callback?code=abc&state=xyz&iss=https%3A%2F%2Ft HTTP/1.1"), Ok(("abc".into(), "xyz".into())));
        assert_eq!(parse_callback("GET /callback?error=access_denied HTTP/1.1"), Err("access_denied".into()));
        assert!(parse_callback("GET /callback HTTP/1.1").is_err());
        // RFC 7636 附錄 B 的範例。/ The RFC 7636 appendix B example.
        assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }
}
