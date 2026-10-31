//! `telepy _carrier`：`telepy ssh / scp / sftp` 連 Telepy 那一跳的 ProxyCommand。預設把 SSH 包進網頁 port 的 WebSocket
//! （`/ws/gateway/`），Telepy 才記得到這台電腦真正的位址（SSH 的 port 前面常有東西把來源換掉，例如 OrbStack / Docker 的
//! port 轉送）；裡面是同一條 SSH，金鑰與 host key 檢查都不變。網頁 port 連不到時，照設定（`prefs::Fallback`）在終端機問、
//! 一律、或從不退回 SSH 的 port。不需要 python3。連線、HTTP CONNECT 代理（`HTTPS_PROXY` / `NO_PROXY`）與轉接都是
//! `telepy-carrier` crate 的（裝置端的 `telepy-carrier` binary 用同一組）；這裡只有「先網頁 port、退回要同意」的順序。
//! `telepy _carrier`: the ProxyCommand of the hop to Telepy for `telepy ssh / scp / sftp`. By default SSH rides inside
//! a WebSocket on the web port (`/ws/gateway/`), so Telepy records this computer's real address (something in front
//! of the SSH port often rewrites it, e.g. OrbStack's or Docker's port forwarding); the SSH inside is the same, keys
//! and host-key checks included. When the web port can't be reached it asks in the terminal, always or never falls
//! back to the SSH port, as set (`prefs::Fallback`). No python3 needed. Connecting, the HTTP CONNECT proxy
//! (`HTTPS_PROXY` / `NO_PROXY`) and relaying come from the `telepy-carrier` crate (the device binary shares them);
//! only the order — web port first, consent to fall back — lives here.

use std::time::Duration;

use anyhow::{anyhow, Result};
use telepy_carrier::{connect_ws, relay_tcp, relay_ws, split_host_port, tcp_connect, ws_endpoint, Proxy};

use crate::prefs::{self, Fallback};

const WS_TIMEOUT: Duration = Duration::from_secs(15);
const TCP_TIMEOUT: Duration = Duration::from_secs(10);

/// 問題的回答。/ The answer to the question.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    /// 這次退回。/ Fall back this time.
    Once,
    /// 這台伺服器一律退回（存起來）。/ Always for this server (saved).
    Always,
    No,
}

/// `y` / `yes` = 這次、`a` / `always` = 一律，其他（含空白）= 不要。/ `y` = once, `a` = always, anything else = no.
pub fn parse_answer(s: &str) -> Answer {
    match s.trim().to_ascii_lowercase().as_str() {
        "y" | "yes" => Answer::Once,
        "a" | "always" => Answer::Always,
        _ => Answer::No,
    }
}

/// 不退回時給人看的話：怎麼允許它。/ What to say when not falling back: how to allow it.
pub fn refusal(err: &str, tcp: &str, fallback: Fallback, tty: bool) -> String {
    let why = match (fallback, tty) {
        (Fallback::Never, _) => "falling back to the SSH port is turned off for this server",
        (_, false) => "there is no terminal to ask whether to use the SSH port instead",
        _ => "you chose not to use the SSH port",
    };
    format!(
        "telepy: Telepy's web port can't be reached ({err}), and {why}.\n\
         telepy: to connect on the SSH port ({tcp}) instead — Telepy then can't see your real address — run with \
         --fallback always, or set it for this server: telepy config fallback always"
    )
}

/// 在終端機上問（ssh 自己問密碼也是這樣：stdin / stdout 是 SSH 連線本身）。沒有終端機 = None。
/// Ask on the terminal (as ssh asks for passwords: stdin / stdout are the SSH stream). No terminal = None.
fn ask_terminal(question: &str) -> Option<String> {
    use std::io::{BufRead, BufReader, Write};
    #[cfg(unix)]
    {
        let mut tty = std::fs::OpenOptions::new().read(true).write(true).open("/dev/tty").ok()?;
        tty.write_all(question.as_bytes()).ok()?;
        tty.flush().ok()?;
        let mut line = String::new();
        BufReader::new(tty).read_line(&mut line).ok()?;
        Some(line)
    }
    #[cfg(windows)]
    {
        let mut out = std::fs::OpenOptions::new().write(true).open("CONOUT$").ok()?;
        out.write_all(question.as_bytes()).ok()?;
        out.flush().ok()?;
        let input = std::fs::OpenOptions::new().read(true).open("CONIN$").ok()?;
        let mut line = String::new();
        BufReader::new(input).read_line(&mut line).ok()?;
        Some(line)
    }
}

/// 跑載具；回結束碼（連上後由連線結束決定，這個函式在那之前就讓程式結束）。
/// Run the carrier; returns an exit code (once connected the process ends when the connection does).
pub fn run(url: &str, tcp: Option<&str>, fallback: Fallback, server: &str) -> Result<i32> {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    rt.block_on(async move {
        // 代理照環境變數（HTTPS_PROXY / NO_PROXY），網頁 port 與 SSH 的 port 一樣。/ The proxy from the environment, both ways.
        let ws_host = ws_endpoint(url).map(|(h, _, _)| h).unwrap_or_default();
        let proxy = Proxy::from_env(&ws_host);
        let err = match connect_ws(url, proxy.as_ref(), WS_TIMEOUT).await {
            Ok(ws) => {
                relay_ws(ws).await;
                std::process::exit(0);
            }
            Err(e) => format!("{e:#}"),
        };
        let Some(tcp) = tcp else {
            eprintln!("telepy: Telepy's web port can't be reached ({err}).");
            return Ok(255);
        };
        let go = match fallback {
            Fallback::Always => true,
            Fallback::Never => {
                eprintln!("{}", refusal(&err, tcp, fallback, true));
                return Ok(255);
            }
            Fallback::Ask => {
                let q = format!(
                    "telepy: Telepy's web port can't be reached ({err}).\n  Connect on the SSH port ({tcp}) instead? Telepy then can't see your real address.\n  [y] yes, this time   [a] always for this server   [N] no: "
                );
                match ask_terminal(&q).map(|a| parse_answer(&a)) {
                    None => {
                        eprintln!("{}", refusal(&err, tcp, fallback, false));
                        return Ok(255);
                    }
                    Some(Answer::No) => {
                        eprintln!("{}", refusal(&err, tcp, fallback, true));
                        return Ok(255);
                    }
                    Some(Answer::Always) => {
                        prefs::set_fallback(server, Fallback::Always)?;
                        eprintln!("telepy: saved: this server falls back to the SSH port from now on (telepy config fallback ask to undo)");
                        true
                    }
                    Some(Answer::Once) => true,
                }
            }
        };
        if go {
            if fallback == Fallback::Always {
                eprintln!("telepy: Telepy's web port can't be reached ({err}); connecting on the SSH port {tcp}");
            }
            let (host, port) = split_host_port(tcp).ok_or_else(|| anyhow!("--tcp wants host:port, got {tcp}"))?;
            let tcp_proxy = Proxy::from_env(&host);
            let (stream, pending) = tcp_connect(&host, port, tcp_proxy.as_ref(), TCP_TIMEOUT).await?;
            relay_tcp(stream, &pending).await;
            std::process::exit(0);
        }
        Ok(255)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_default_to_no() {
        assert_eq!(parse_answer("y\n"), Answer::Once);
        assert_eq!(parse_answer(" YES "), Answer::Once);
        assert_eq!(parse_answer("a"), Answer::Always);
        assert_eq!(parse_answer("always"), Answer::Always);
        for no in ["", "\n", "n", "no", "maybe"] {
            assert_eq!(parse_answer(no), Answer::No, "{no:?}");
        }
    }

    #[test]
    fn refusals_say_how_to_allow_it() {
        let r = refusal("connection refused", "ssh.example.com:24242", Fallback::Ask, false);
        assert!(r.contains("no terminal") && r.contains("--fallback always") && r.contains("telepy config fallback always") && r.contains("ssh.example.com:24242"), "{r}");
        assert!(refusal("x", "h:1", Fallback::Never, true).contains("turned off for this server"));
        assert!(refusal("x", "h:1", Fallback::Ask, true).contains("you chose not to"));
    }
}
