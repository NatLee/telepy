//! RDP 預檢：交給 guacd 之前，先用另一條 direct-tcpip 通道送一個 RDP 的 X.224 連線請求（附 RDP_NEG_REQ），看目標怎麼回。
//! guacd 1.6 在「沒有 RDP 伺服器」時一律說 `Server refused connection (wrong security type?)`——對面沒人聽、接了就斷、
//! 接了但講別的協定都一樣（實驗過），使用者會以為是安全類型設錯。這裡先分清楚：
//! - 接了就關、沒回半個位元組 → 那裡沒有 RDP 伺服器（例如 WSL 的 mirrored 網路把 127.0.0.1 轉給沒開遠端桌面的 Windows）；
//! - 一直不說話 → 那裡的程式不是 RDP，或卡住了；
//! - 回了別的東西（`SSH-2.0-…`、`HTTP/1.1 …`）→ 那個埠是別的服務；
//! - X.224 連線確認（可能附協商回應或協商失敗碼）→ 是 RDP 伺服器，記下它選的安全層，照常交給 guacd。
//!
//! 解析是純函式（`parse`，下面有測試）；`probe` 只負責開通道、送、讀（5 秒）。
//!
//! RDP pre-flight: before guacd gets the target, send an RDP X.224 Connection Request (with an RDP_NEG_REQ) over a
//! separate direct-tcpip channel and see how the target answers. guacd 1.6 reports `Server refused connection (wrong
//! security type?)` whenever there is no RDP server — nothing listening, a connection closed at once, another protocol
//! answering all look the same (tested) — so people chase security settings. This tells them apart: closed without a
//! byte = no RDP server there; silent = not RDP or stuck; something else answered = another service on that port; an
//! X.224 Connection Confirm (maybe with a negotiation response or failure code) = an RDP server, whose security layer is
//! noted, and guacd goes ahead. Parsing is pure (`parse`, tested); `probe` opens the channel, sends and reads (5 s).

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ssh::pool::Lease;

/// 整個預檢最多等多久（開通道 + 回應）。/ How long the whole pre-flight may take (channel + answer).
pub const TIMEOUT: Duration = Duration::from_secs(5);

/// X.224 連線請求 + RDP_NEG_REQ，要 TLS | CredSSP（NLA）| CredSSP early user auth，跟 guacd 的 `security=any` 一樣大方。
/// TPKT（03 00 長度）、X.224 CR（LI 14、0xE0、DST/SRC-REF 0、class 0）、RDP_NEG_REQ（type 1、flags 0、length 8、protocols）。
/// An X.224 Connection Request with an RDP_NEG_REQ asking for TLS | CredSSP (NLA) | CredSSP with early user auth.
pub const REQUEST: [u8; 19] = [0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00, 0x0b, 0x00, 0x00, 0x00];

/// 伺服器選的安全層（RDP_NEG_RSP 的 selectedProtocol）。/ The security layer the server picked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Security {
    /// 舊的 RDP 標準安全層（沒有協商、或選 0）。/ Classic RDP security (no negotiation, or 0).
    Rdp,
    Tls,
    /// CredSSP = 網路層級驗證（NLA）。/ CredSSP = Network Level Authentication.
    Nla,
    Rdstls,
    /// CredSSP + early user authorization result（Windows 的預設）。/ CredSSP with early user auth (Windows' default).
    NlaEx,
    Other(u32),
}

impl Security {
    fn from_selected(v: u32) -> Self {
        match v {
            0 => Self::Rdp,
            1 => Self::Tls,
            2 => Self::Nla,
            4 => Self::Rdstls,
            8 => Self::NlaEx,
            other => Self::Other(other),
        }
    }

    /// 日誌用的名字。/ The name in the logs.
    pub fn label(self) -> &'static str {
        match self {
            Self::Rdp => "RDP security",
            Self::Tls => "TLS",
            Self::Nla | Self::NlaEx => "NLA",
            Self::Rdstls => "RDSTLS",
            Self::Other(_) => "unknown security",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rdp => "rdp",
            Self::Tls => "tls",
            Self::Nla => "nla",
            Self::Rdstls => "rdstls",
            Self::NlaEx => "nla_ex",
            Self::Other(_) => "other",
        }
    }
}

/// 對面回了什麼（不是 RDP 時）。/ What answered, when it was not RDP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seen {
    Ssh,
    Http,
    /// 一行可讀的字（截短）。/ A readable line (shortened).
    Text(String),
    Binary,
}

impl Seen {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Ssh => "ssh",
            Self::Http => "http",
            Self::Text(_) => "text",
            Self::Binary => "binary",
        }
    }

    fn describe(&self) -> String {
        match self {
            Self::Ssh => "an SSH server".into(),
            Self::Http => "a web server".into(),
            Self::Text(t) => format!("a program that said \"{t}\""),
            Self::Binary => "a program that is not RDP".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    /// RDP 伺服器：連線確認（附它選的安全層，或協商失敗碼）。/ An RDP server: Connection Confirm with its pick or a failure code.
    Rdp { security: Security, failure: Option<u32> },
    /// 接了連線，一個位元組都沒回就關了。/ Accepted, then closed without a byte.
    Closed,
    /// 接了連線，時間內一個位元組都沒回。/ Accepted, then silent.
    Silent,
    /// 回了，但不是 RDP。/ Answered, but not RDP.
    NotRdp(Seen),
}

impl Answer {
    /// 擋下連線時給前端的錯誤碼；RDP 伺服器回應了就是 None（照常交給 guacd）。/ The error code when it stops the start.
    pub fn error_code(&self) -> Option<&'static str> {
        match self {
            Self::Rdp { .. } => None,
            Self::Closed => Some("rdp_no_answer"),
            Self::Silent => Some("rdp_silent"),
            Self::NotRdp(_) => Some("rdp_not_rdp"),
        }
    }

    /// 給人看（日誌、錯誤的 detail）的一句英文。/ One English sentence for logs and the error detail.
    pub fn describe(&self, address: &str) -> String {
        match self {
            Self::Rdp { security, failure: None } => format!("{address} answered as an RDP server ({})", security.as_str()),
            Self::Rdp { failure: Some(code), .. } => format!("{address} answered as an RDP server and refused the requested security ({})", failure_name(*code)),
            Self::Closed => format!("{address} accepted the connection and closed it without an RDP answer: no Remote Desktop server runs there"),
            Self::Silent => format!("{address} accepted the connection but sent nothing back within {} s: whatever listens there is not a Remote Desktop server, or it is stuck", TIMEOUT.as_secs()),
            Self::NotRdp(seen) => format!("{address} is answered by {}, not a Remote Desktop server", seen.describe()),
        }
    }
}

/// RDP_NEG_FAILURE 的失敗碼。/ RDP_NEG_FAILURE codes ([MS-RDPBCGR] 2.2.1.2.2).
pub fn failure_name(code: u32) -> &'static str {
    match code {
        1 => "ssl_required_by_server",
        2 => "ssl_not_allowed_by_server",
        3 => "ssl_cert_not_on_server",
        4 => "inconsistent_flags",
        5 => "hybrid_required_by_server",
        6 => "ssl_with_user_auth_required_by_server",
        _ => "unknown",
    }
}

fn seen(bytes: &[u8]) -> Seen {
    if bytes.starts_with(b"SSH-") {
        return Seen::Ssh;
    }
    if bytes.starts_with(b"HTTP/") {
        return Seen::Http;
    }
    let line: String = bytes.iter().take_while(|&&b| b != b'\r' && b != b'\n').map(|&b| b as char).collect();
    if !line.is_empty() && line.chars().all(|c| c.is_ascii_graphic() || c == ' ') {
        let short: String = line.chars().take(60).collect();
        return Seen::Text(short);
    }
    Seen::Binary
}

/// 讀到的位元組 → 判斷；還要更多位元組時是 None。`eof` = 對面已經關了。
/// The bytes read so far → a verdict, or None while more are needed. `eof` = the other side closed.
pub fn parse(bytes: &[u8], eof: bool) -> Option<Answer> {
    if bytes.is_empty() {
        return eof.then_some(Answer::Closed);
    }
    if bytes[0] != 0x03 {
        // 不是 TPKT：多等一點字（一行）再說它是什麼，關了或夠了就判。/ Not TPKT: wait for a line, then say what it is.
        let enough = eof || bytes.len() >= 64 || bytes.contains(&b'\n');
        return enough.then(|| Answer::NotRdp(seen(bytes)));
    }
    if bytes.len() < 4 {
        return eof.then(|| Answer::NotRdp(seen(bytes)));
    }
    let total = u16::from_be_bytes([bytes[2], bytes[3]]) as usize;
    if !(11..=512).contains(&total) || bytes[1] != 0 {
        return Some(Answer::NotRdp(Seen::Binary));
    }
    if bytes.len() < total {
        return eof.then_some(Answer::NotRdp(Seen::Binary));
    }
    // X.224：LI、代碼（高 4 位元 0xD = 連線確認）。/ X.224: length indicator, then the code (0xD_ = Connection Confirm).
    let li = bytes[4] as usize;
    if bytes[5] & 0xf0 != 0xd0 || li + 5 > total {
        return Some(Answer::NotRdp(Seen::Binary));
    }
    // 固定部分 6 個位元組之後是協商結構（有的話）。/ The negotiation structure follows the 6 fixed bytes, when present.
    let neg = 11;
    if li >= 6 + 8 && total >= neg + 8 {
        let kind = bytes[neg];
        let len = u16::from_le_bytes([bytes[neg + 2], bytes[neg + 3]]);
        let value = u32::from_le_bytes([bytes[neg + 4], bytes[neg + 5], bytes[neg + 6], bytes[neg + 7]]);
        if len == 8 {
            match kind {
                0x02 => return Some(Answer::Rdp { security: Security::from_selected(value), failure: None }),
                0x03 => return Some(Answer::Rdp { security: Security::Rdp, failure: Some(value) }),
                _ => {}
            }
        }
    }
    // 沒有協商回應：舊的伺服器，只會 RDP 標準安全層。/ No negotiation response: an old server, classic RDP security only.
    Some(Answer::Rdp { security: Security::Rdp, failure: None })
}

/// 經裝置的連線另開一條通道到目標，送連線請求、讀回應，然後關掉。開不了通道時當作沒回應（真正的通道已經開好，這種情況很少）。
/// Open another channel to the target over the device's connection, send the request, read the answer, close it.
/// A channel that won't open counts as no answer (the real one is already open, so this is rare).
pub async fn probe(lease: &Lease, host: &str, port: u16) -> Answer {
    let run = async {
        let channel = match lease.device().channel_open_direct_tcpip(host.to_string(), port as u32, "127.0.0.1", 0).await {
            Ok(c) => c,
            Err(_) => return Answer::Closed,
        };
        let mut stream = channel.into_stream();
        if stream.write_all(&REQUEST).await.is_err() {
            return Answer::Closed;
        }
        let _ = stream.flush().await;
        let mut buf = Vec::with_capacity(64);
        let mut chunk = [0u8; 256];
        loop {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return parse(&buf, true).unwrap_or(Answer::Closed),
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(a) = parse(&buf, false) {
                        let _ = stream.shutdown().await;
                        return a;
                    }
                    if buf.len() > 1024 {
                        return Answer::NotRdp(seen(&buf));
                    }
                }
            }
        }
    };
    tokio::time::timeout(TIMEOUT, run).await.unwrap_or(Answer::Silent)
}

/// 這台是 Windows 裡的 WSL 嗎（看裝置資訊的核心版本：WSL2 `…-microsoft-standard-WSL2`，WSL1 `…-Microsoft`）。
/// Is this device WSL inside Windows (by the kernel in its facts: WSL2 `…-microsoft-standard-WSL2`, WSL1 `…-Microsoft`)?
pub fn is_wsl(kernel: &str) -> bool {
    let k = kernel.to_ascii_lowercase();
    k.contains("microsoft-standard-wsl") || k.ends_with("-microsoft") || k.contains("-microsoft ")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一個連線確認：TPKT + X.224 CC + 協商結構。/ A Connection Confirm with a negotiation structure.
    fn confirm(kind: u8, value: u32) -> Vec<u8> {
        let mut v = vec![0x03, 0x00, 0x00, 0x13, 0x0e, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00, kind, 0x00, 0x08, 0x00];
        v.extend_from_slice(&value.to_le_bytes());
        v
    }

    #[test]
    fn the_request_is_a_well_formed_x224_connection_request() {
        assert_eq!(u16::from_be_bytes([REQUEST[2], REQUEST[3]]) as usize, REQUEST.len(), "TPKT length");
        assert_eq!(REQUEST[4] as usize, REQUEST.len() - 5, "the length indicator counts what follows it");
        assert_eq!(REQUEST[5], 0xe0, "Connection Request");
        assert_eq!(u32::from_le_bytes([REQUEST[15], REQUEST[16], REQUEST[17], REQUEST[18]]), 0b1011, "TLS | CredSSP | CredSSP early auth");
    }

    #[test]
    fn rdp_servers_are_recognised_with_their_security_layer() {
        assert_eq!(parse(&confirm(0x02, 8), false), Some(Answer::Rdp { security: Security::NlaEx, failure: None }), "Windows' default");
        assert_eq!(parse(&confirm(0x02, 2), false), Some(Answer::Rdp { security: Security::Nla, failure: None }));
        assert_eq!(parse(&confirm(0x02, 1), false), Some(Answer::Rdp { security: Security::Tls, failure: None }), "xrdp's default");
        assert_eq!(parse(&confirm(0x03, 2), false), Some(Answer::Rdp { security: Security::Rdp, failure: Some(2) }), "classic RDP security only");
        // 沒有協商結構的連線確認（很舊的伺服器）。/ A Connection Confirm without negotiation (a very old server).
        let old = [0x03, 0x00, 0x00, 0x0b, 0x06, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00];
        assert_eq!(parse(&old, false), Some(Answer::Rdp { security: Security::Rdp, failure: None }));
        assert_eq!(Answer::Rdp { security: Security::Rdp, failure: Some(5) }.describe("x:1").contains("hybrid_required_by_server"), true);
    }

    #[test]
    fn partial_answers_wait_for_more_bytes() {
        let full = confirm(0x02, 8);
        for cut in 1..full.len() {
            assert_eq!(parse(&full[..cut], false), None, "cut at {cut}");
        }
        assert_eq!(parse(&full[..7], true), Some(Answer::NotRdp(Seen::Binary)), "cut short by a close");
    }

    #[test]
    fn no_rdp_server_is_told_apart_from_another_service() {
        assert_eq!(parse(&[], true), Some(Answer::Closed));
        assert_eq!(parse(&[], false), None);
        assert_eq!(parse(b"SSH-2.0-OpenSSH_10.2p1 Ubuntu\r\n", false), Some(Answer::NotRdp(Seen::Ssh)));
        assert_eq!(parse(b"HTTP/1.1 400 Bad Request\r\n\r\n", false), Some(Answer::NotRdp(Seen::Http)));
        assert_eq!(parse(b"220 mail.example ESMTP\r\n", false), Some(Answer::NotRdp(Seen::Text("220 mail.example ESMTP".into()))));
        assert_eq!(parse(b"RFB 003.008\n", false), Some(Answer::NotRdp(Seen::Text("RFB 003.008".into()))), "a VNC server on 3389");
        assert_eq!(parse(&[0x16, 0x03, 0x01, 0x00], true), Some(Answer::NotRdp(Seen::Binary)), "TLS straight away");
        assert_eq!(parse(&[0x03, 0x01, 0x00, 0x13], false), Some(Answer::NotRdp(Seen::Binary)), "not a TPKT version");
        // 不是 RDP 的一行還沒讀完：等。/ A non-RDP line not complete yet: wait.
        assert_eq!(parse(b"SSH-2.0-Open", false), None);
        assert_eq!(Answer::Closed.error_code(), Some("rdp_no_answer"));
        assert_eq!(Answer::Silent.error_code(), Some("rdp_silent"));
        assert_eq!(Answer::Rdp { security: Security::Tls, failure: None }.error_code(), None);
    }

    #[test]
    fn wsl_kernels_are_recognised() {
        assert!(is_wsl("Linux 6.18.33.2-microsoft-standard-WSL2"));
        assert!(is_wsl("Linux 4.4.0-19041-Microsoft"));
        assert!(!is_wsl("Linux 6.8.0-45-generic"));
        assert!(!is_wsl("Darwin 24.1.0"));
    }
}
