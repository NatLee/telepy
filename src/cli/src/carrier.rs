//! `telepy _carrier`：`telepy ssh / scp / sftp` 連 Telepy 那一跳的 ProxyCommand。預設把 SSH 包進網頁 port 的 WebSocket
//! （`/ws/gateway/`），Telepy 才記得到這台電腦真正的位址（SSH 的 port 前面常有東西把來源換掉，例如 OrbStack / Docker 的
//! port 轉送）；裡面是同一條 SSH，金鑰與 host key 檢查都不變。網頁 port 連不到時，照設定（`prefs::Fallback`）在終端機問、
//! 一律、或從不退回 SSH 的 port。不需要 python3。
//! `telepy _carrier`: the ProxyCommand of the hop to Telepy for `telepy ssh / scp / sftp`. By default SSH rides inside
//! a WebSocket on the web port (`/ws/gateway/`), so Telepy records this computer's real address (something in front
//! of the SSH port often rewrites it, e.g. OrbStack's or Docker's port forwarding); the SSH inside is the same, keys
//! and host-key checks included. When the web port can't be reached it asks in the terminal, always or never falls
//! back to the SSH port, as set (`prefs::Fallback`). No python3 needed.

use std::time::Duration;

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

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
        let err = match tokio::time::timeout(WS_TIMEOUT, tokio_tungstenite::connect_async(url)).await {
            Ok(Ok((ws, _))) => {
                relay_ws(ws).await;
                std::process::exit(0);
            }
            Ok(Err(e)) => e.to_string(),
            Err(_) => "timed out".to_string(),
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
            let stream = tokio::time::timeout(TCP_TIMEOUT, tokio::net::TcpStream::connect(tcp)).await.map_err(|_| anyhow!("connecting to {tcp} timed out"))?.map_err(|e| anyhow!("cannot connect to {tcp}: {e}"))?;
            let _ = stream.set_nodelay(true);
            relay_tcp(stream).await;
            std::process::exit(0);
        }
        Ok(255)
    })
}

/// stdin ↔ WebSocket 的二進位 frame；Ping 回 Pong，Close = 結束。/ stdin ↔ binary frames; Ping → Pong, Close = done.
async fn relay_ws<S>(ws: tokio_tungstenite::WebSocketStream<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::channel::<Message>(64);
    // 只有一個地方寫：stdin 的資料、Pong 與最後的 Close 都排進同一條。/ One writer: data, pongs and the final close.
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            let close = matches!(m, Message::Close(_));
            if sink.send(m).await.is_err() || close {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let up = {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut stdin = tokio::io::stdin();
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match stdin.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                            return;
                        }
                    }
                }
            }
            let _ = tx.send(Message::Close(None)).await;
        })
    };
    let mut stdout = tokio::io::stdout();
    while let Some(msg) = stream.next().await {
        match msg {
            Ok(Message::Binary(b)) => {
                if stdout.write_all(&b).await.is_err() || stdout.flush().await.is_err() {
                    break;
                }
            }
            Ok(Message::Text(t)) => {
                if stdout.write_all(t.as_bytes()).await.is_err() || stdout.flush().await.is_err() {
                    break;
                }
            }
            Ok(Message::Ping(p)) => {
                let _ = tx.send(Message::Pong(p)).await;
            }
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => {}
        }
    }
    up.abort();
    drop(tx);
    let _ = tokio::time::timeout(Duration::from_secs(1), writer).await;
}

/// stdin / stdout ↔ TCP，原封不動。/ stdin / stdout ↔ TCP, unchanged.
async fn relay_tcp(mut tcp: tokio::net::TcpStream) {
    let mut local = tokio::io::join(tokio::io::stdin(), tokio::io::stdout());
    let _ = tokio::io::copy_bidirectional(&mut local, &mut tcp).await;
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
