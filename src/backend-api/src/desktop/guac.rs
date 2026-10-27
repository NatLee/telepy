//! Guacamole 協定（guacd 的線路格式）：`長度.值,長度.值,…;`，長度是「字元數」。
//!
//! 兩端數字元的方式不同：guacd 數 Unicode 碼點（code point），瀏覽器端的 guacamole-common-js 用 JS 字串長度
//! （UTF-16 code unit）。BMP 以內兩者相同，遇到 emoji 這類輔助平面字元就差一。中繼時依**來源**的單位解析、
//! 需要時依**目的端**的單位重新編碼，所以兩邊看到的永遠是自己認得的長度（純 ASCII / BMP 的指令原樣透傳）。
//!
//! Guacamole wire protocol: `LENGTH.VALUE,LENGTH.VALUE,…;` where LENGTH counts characters. guacd counts code
//! points while the browser client counts UTF-16 units; the relay parses with the sender's unit and re-encodes
//! for the receiver only when an instruction contains astral characters.

use std::borrow::Cow;
use std::collections::HashMap;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// 一個元素最大 16 MB（剪貼簿 / blob 都遠小於此；防止惡意長度把記憶體吃光）。/ Max element size.
pub const MAX_ELEMENT: usize = 16 * 1024 * 1024;
/// 解析緩衝區上限：超過還湊不出一個完整指令就視為壞掉。/ Buffer cap while waiting for a complete instruction.
pub const MAX_BUFFER: usize = 64 * 1024 * 1024;
/// 我們這邊支援的協定版本（guacamole-common-js 1.5 世代）。/ Protocol version we speak.
pub const OUR_VERSION: (u32, u32, u32) = (1, 5, 0);

/// 長度單位：guacd = 碼點；瀏覽器 = UTF-16 單元。/ Length unit of a peer.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Unit {
    CodePoints,
    Utf16,
}

fn str_units(s: &str, unit: Unit) -> usize {
    match unit {
        Unit::CodePoints => s.chars().count(),
        Unit::Utf16 => s.chars().map(|c| c.len_utf16()).sum(),
    }
}

/// 編碼一個指令（第一個元素是 opcode）。/ Encode one instruction (first element = opcode).
pub fn encode(elements: &[&str], unit: Unit) -> String {
    let mut out = String::with_capacity(elements.iter().map(|e| e.len() + 12).sum());
    for (i, e) in elements.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&str_units(e, unit).to_string());
        out.push('.');
        out.push_str(e);
    }
    out.push(';');
    out
}

/// 一個完整指令：原文 + 每個元素在原文裡的位置。/ One complete instruction with element bounds into `raw`.
#[derive(Debug, Clone)]
pub struct Instruction {
    raw: String,
    bounds: Vec<(usize, usize)>,
    /// 有輔助平面字元（兩種單位的長度不同）。/ Contains astral characters (lengths differ between units).
    astral: bool,
}

impl Instruction {
    pub fn opcode(&self) -> &str {
        self.element(0).unwrap_or("")
    }

    pub fn element(&self, i: usize) -> Option<&str> {
        self.bounds.get(i).map(|&(s, e)| &self.raw[s..e])
    }

    /// 參數（不含 opcode）。/ Arguments after the opcode.
    pub fn args(&self) -> impl Iterator<Item = &str> {
        self.bounds.iter().skip(1).map(|&(s, e)| &self.raw[s..e])
    }

    pub fn raw(&self) -> &str {
        &self.raw
    }

    /// 給「以 `unit` 計長度」的接收端的線路文字；沒有輔助平面字元時原樣透傳。
    /// Wire text for a receiver counting in `unit`; passthrough unless astral characters are present.
    pub fn wire(&self, unit: Unit) -> Cow<'_, str> {
        if !self.astral {
            return Cow::Borrowed(&self.raw);
        }
        let elements: Vec<&str> = self.bounds.iter().map(|&(s, e)| &self.raw[s..e]).collect();
        Cow::Owned(encode(&elements, unit))
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ParseError {
    #[error("malformed Guacamole instruction")]
    Malformed,
    #[error("Guacamole instruction too long")]
    TooLong,
}

fn utf8_width(first: u8) -> Option<usize> {
    match first {
        0x00..=0x7F => Some(1),
        0xC2..=0xDF => Some(2),
        0xE0..=0xEF => Some(3),
        0xF0..=0xF4 => Some(4),
        _ => None,
    }
}

/// 串流解析器：餵 bytes，吐完整指令；不完整就等下一批。/ Streaming parser: push bytes, pop complete instructions.
pub struct Parser {
    buf: Vec<u8>,
    unit: Unit,
}

impl Parser {
    pub fn new(unit: Unit) -> Self {
        Self { buf: Vec::with_capacity(16 * 1024), unit }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    pub fn buffered(&self) -> usize {
        self.buf.len()
    }

    /// 下一個完整指令；`Ok(None)` = 還不完整。/ Next complete instruction; `Ok(None)` = need more bytes.
    pub fn next(&mut self) -> Result<Option<Instruction>, ParseError> {
        let b = &self.buf;
        let mut pos = 0;
        let mut bounds = Vec::with_capacity(4);
        let mut astral = false;
        loop {
            let digits_start = pos;
            while pos < b.len() && b[pos].is_ascii_digit() {
                pos += 1;
            }
            if pos == b.len() {
                return self.incomplete();
            }
            if pos == digits_start || b[pos] != b'.' {
                return Err(ParseError::Malformed);
            }
            if pos - digits_start > 9 {
                return Err(ParseError::TooLong);
            }
            let len: usize = std::str::from_utf8(&b[digits_start..pos]).unwrap().parse().map_err(|_| ParseError::Malformed)?;
            if len > MAX_ELEMENT {
                return Err(ParseError::TooLong);
            }
            pos += 1;
            let value_start = pos;
            let mut remaining = len;
            while remaining > 0 {
                if pos >= b.len() {
                    return self.incomplete();
                }
                let w = utf8_width(b[pos]).ok_or(ParseError::Malformed)?;
                if pos + w > b.len() {
                    return self.incomplete();
                }
                if b[pos + 1..pos + w].iter().any(|c| c & 0xC0 != 0x80) {
                    return Err(ParseError::Malformed);
                }
                let units = if w == 4 {
                    astral = true;
                    match self.unit {
                        Unit::CodePoints => 1,
                        Unit::Utf16 => 2,
                    }
                } else {
                    1
                };
                if units > remaining {
                    return Err(ParseError::Malformed);
                }
                remaining -= units;
                pos += w;
            }
            bounds.push((value_start, pos));
            if pos >= b.len() {
                return self.incomplete();
            }
            match b[pos] {
                b',' => pos += 1,
                b';' => {
                    pos += 1;
                    break;
                }
                _ => return Err(ParseError::Malformed),
            }
        }
        let rest = self.buf.split_off(pos);
        let raw_bytes = std::mem::replace(&mut self.buf, rest);
        let raw = String::from_utf8(raw_bytes).map_err(|_| ParseError::Malformed)?;
        Ok(Some(Instruction { raw, bounds, astral }))
    }

    fn incomplete(&self) -> Result<Option<Instruction>, ParseError> {
        if self.buf.len() > MAX_BUFFER {
            Err(ParseError::TooLong)
        } else {
            Ok(None)
        }
    }

    /// 把緩衝區裡所有完整指令一次取出（解析錯誤時回已取出的部分 + 錯誤）。
    /// Drain every complete instruction; on a parse error returns what was parsed plus the error.
    pub fn drain(&mut self) -> (Vec<Instruction>, Option<ParseError>) {
        let mut out = Vec::new();
        loop {
            match self.next() {
                Ok(Some(i)) => out.push(i),
                Ok(None) => return (out, None),
                Err(e) => return (out, Some(e)),
            }
        }
    }
}

/// `VERSION_1_5_0` → (1, 5, 0)。/ Parse guacd's protocol version argument.
pub fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let rest = s.strip_prefix("VERSION_")?;
    let mut it = rest.split('_').map(|p| p.parse::<u32>().ok());
    Some((it.next()??, it.next()??, it.next()??))
}

pub fn version_string(v: (u32, u32, u32)) -> String {
    format!("VERSION_{}_{}_{}", v.0, v.1, v.2)
}

#[derive(Debug, thiserror::Error)]
pub enum HandshakeError {
    #[error("guacd: {0}")]
    Io(#[from] std::io::Error),
    #[error("guacd closed the connection during the handshake")]
    Closed,
    #[error("guacd protocol error: {0}")]
    Protocol(String),
    /// guacd 回 `error`（訊息, 狀態碼）。/ guacd answered with an `error` instruction (message, status code).
    #[error("guacd error {code}: {message}")]
    Guacd { message: String, code: String },
    #[error("guacd handshake timed out")]
    Timeout,
}

/// 到 guacd 的一條連線（握手期間用；之後拆成 stream + parser 交給中繼）。/ A guacd connection during the handshake.
pub struct Guacd {
    stream: TcpStream,
    parser: Parser,
}

/// 握手需要的畫面參數。/ Display parameters sent in the handshake.
#[derive(Debug, Clone, Copy)]
pub struct Size {
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
}

impl Guacd {
    pub async fn connect(addr: &str, timeout: Duration) -> Result<Self, HandshakeError> {
        let stream = tokio::time::timeout(timeout, TcpStream::connect(addr)).await.map_err(|_| HandshakeError::Timeout)??;
        stream.set_nodelay(true)?;
        Ok(Self { stream, parser: Parser::new(Unit::CodePoints) })
    }

    pub async fn send(&mut self, elements: &[&str]) -> Result<(), HandshakeError> {
        self.stream.write_all(encode(elements, Unit::CodePoints).as_bytes()).await?;
        Ok(())
    }

    pub async fn read(&mut self, timeout: Duration) -> Result<Instruction, HandshakeError> {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut buf = [0u8; 8192];
        loop {
            match self.parser.next() {
                Ok(Some(i)) => return Ok(i),
                Ok(None) => {}
                Err(e) => return Err(HandshakeError::Protocol(e.to_string())),
            }
            let n = tokio::time::timeout_at(deadline, self.stream.read(&mut buf)).await.map_err(|_| HandshakeError::Timeout)??;
            if n == 0 {
                return Err(HandshakeError::Closed);
            }
            self.parser.push(&buf[..n]);
        }
    }

    /// 完整握手：`select` → `args` → `size` / `audio` / `video` / `image` [/ `timezone`] → `connect` → `ready`。
    /// 回 guacd 的 connection id。`params` 依 guacd 要求的參數名取值，沒有的留空。`audio` = 瀏覽器會播的音訊格式
    /// （空 = 不要聲音）。
    /// Full handshake; returns guacd's connection id. `params` is looked up by the argument names guacd asks for;
    /// `audio` lists the audio formats the browser plays (empty = no sound).
    pub async fn handshake(&mut self, protocol: &str, size: Size, audio: &[&str], params: &HashMap<String, String>, timeout: Duration) -> Result<String, HandshakeError> {
        let deadline = tokio::time::Instant::now() + timeout;
        let left = |deadline: tokio::time::Instant| deadline.saturating_duration_since(tokio::time::Instant::now());
        self.send(&["select", protocol]).await?;
        let args = self.read(left(deadline)).await?;
        if args.opcode() != "args" {
            return Err(unexpected(&args));
        }
        let names: Vec<String> = args.args().map(str::to_string).collect();
        let version = names.first().and_then(|n| parse_version(n));
        self.send(&["size", &size.width.to_string(), &size.height.to_string(), &size.dpi.to_string()]).await?;
        let mut audio_instruction: Vec<&str> = vec!["audio"];
        audio_instruction.extend_from_slice(audio);
        self.send(&audio_instruction).await?;
        self.send(&["video"]).await?;
        self.send(&["image", "image/png", "image/jpeg", "image/webp"]).await?;
        if version.map(|v| v >= (1, 1, 0)).unwrap_or(false) {
            if let Some(tz) = params.get("timezone").filter(|t| !t.is_empty()) {
                self.send(&["timezone", tz]).await?;
            }
        }
        let ours = version.map(|v| v.min(OUR_VERSION)).map(version_string);
        let values: Vec<String> = names
            .iter()
            .map(|n| if n.starts_with("VERSION_") { ours.clone().unwrap_or_default() } else { params.get(n).cloned().unwrap_or_default() })
            .collect();
        let mut elements: Vec<&str> = vec!["connect"];
        elements.extend(values.iter().map(String::as_str));
        self.send(&elements).await?;
        loop {
            let i = self.read(left(deadline)).await?;
            match i.opcode() {
                "ready" => return Ok(i.element(1).unwrap_or("").to_string()),
                "error" => return Err(HandshakeError::Guacd { message: i.element(1).unwrap_or("").to_string(), code: i.element(2).unwrap_or("").to_string() }),
                // guacd 1.1+ 可能在 ready 前送 nop。/ Keep-alives before ready are fine.
                "nop" => continue,
                _ => return Err(unexpected(&i)),
            }
        }
    }

    /// 拆成 socket + 解析器（緩衝區裡可能已有 ready 之後的指令，中繼要接著用同一個解析器）。
    /// Split into the socket and the parser (it may already hold instructions sent after `ready`).
    pub fn into_parts(self) -> (TcpStream, Parser) {
        (self.stream, self.parser)
    }
}

fn unexpected(i: &Instruction) -> HandshakeError {
    HandshakeError::Protocol(format!("unexpected instruction '{}' during the handshake", i.opcode()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_all(unit: Unit, text: &str) -> Vec<Vec<String>> {
        let mut p = Parser::new(unit);
        p.push(text.as_bytes());
        let (list, err) = p.drain();
        assert!(err.is_none(), "{err:?}");
        list.into_iter().map(|i| i.bounds.iter().map(|&(s, e)| i.raw[s..e].to_string()).collect()).collect()
    }

    #[test]
    fn encodes_and_parses_ascii() {
        let wire = encode(&["select", "rdp"], Unit::CodePoints);
        assert_eq!(wire, "6.select,3.rdp;");
        assert_eq!(parse_all(Unit::CodePoints, &wire), vec![vec!["select", "rdp"]]);
        // 空 opcode = guacamole-common-js 的 tunnel UUID 指令。/ Empty opcode = the client's tunnel-UUID instruction.
        assert_eq!(encode(&["", "abc"], Unit::Utf16), "0.,3.abc;");
        assert_eq!(parse_all(Unit::Utf16, "0.,3.abc;"), vec![vec!["", "abc"]]);
    }

    #[test]
    fn splits_a_stream_at_instruction_boundaries() {
        let mut p = Parser::new(Unit::CodePoints);
        p.push(b"4.size,1.0,4.1024,3.768;4.sync,2.");
        let first = p.next().unwrap().unwrap();
        assert_eq!(first.opcode(), "size");
        assert_eq!(first.args().collect::<Vec<_>>(), vec!["0", "1024", "768"]);
        assert!(p.next().unwrap().is_none(), "second instruction is incomplete");
        p.push(b"42;");
        let second = p.next().unwrap().unwrap();
        assert_eq!(second.raw(), "4.sync,2.42;");
        assert_eq!(p.buffered(), 0);
    }

    #[test]
    fn a_multibyte_character_split_across_reads_waits_for_the_rest() {
        let wire = encode(&["clipboard", "測"], Unit::CodePoints);
        let bytes = wire.as_bytes();
        let cut = wire.find('測').unwrap() + 1;
        let mut p = Parser::new(Unit::CodePoints);
        p.push(&bytes[..cut]);
        assert!(p.next().unwrap().is_none());
        p.push(&bytes[cut..]);
        assert_eq!(p.next().unwrap().unwrap().element(1), Some("測"));
    }

    #[test]
    fn counts_multibyte_bmp_characters_once_in_both_units() {
        let text = "測試";
        let wire = encode(&["clipboard", text], Unit::CodePoints);
        assert_eq!(wire, format!("9.clipboard,2.{text};"));
        assert_eq!(encode(&["clipboard", text], Unit::Utf16), wire);
        assert_eq!(parse_all(Unit::Utf16, &wire), vec![vec!["clipboard", text]]);
    }

    #[test]
    fn astral_characters_are_reencoded_for_the_other_unit() {
        // 😀 = 1 碼點、2 個 UTF-16 單元。/ One code point, two UTF-16 units.
        let from_browser = "4.blob,1.0,3.a😀;";
        let mut p = Parser::new(Unit::Utf16);
        p.push(from_browser.as_bytes());
        let i = p.next().unwrap().unwrap();
        assert_eq!(i.element(2), Some("a😀"));
        assert_eq!(i.wire(Unit::CodePoints), "4.blob,1.0,2.a😀;");
        assert_eq!(i.wire(Unit::Utf16), from_browser);
        let mut p = Parser::new(Unit::CodePoints);
        p.push("4.blob,1.0,2.a😀;".as_bytes());
        let i = p.next().unwrap().unwrap();
        assert_eq!(i.wire(Unit::Utf16), "4.blob,1.0,3.a😀;");
        // 沒有輔助平面字元時原樣透傳（不配置新字串）。/ Plain instructions pass through untouched.
        let mut p = Parser::new(Unit::CodePoints);
        p.push(b"3.nop;");
        assert!(matches!(p.next().unwrap().unwrap().wire(Unit::Utf16), Cow::Borrowed(_)));
    }

    #[test]
    fn rejects_garbage() {
        for bad in [&b"abc;"[..], b"3.nopX", b".x;", b"3.ab,"] {
            let mut p = Parser::new(Unit::CodePoints);
            p.push(bad);
            let r = p.next();
            assert!(matches!(r, Err(ParseError::Malformed)) || matches!(r, Ok(None)), "{:?} → {r:?}", String::from_utf8_lossy(bad));
        }
        let mut p = Parser::new(Unit::CodePoints);
        p.push(b"abc;");
        assert_eq!(p.next().unwrap_err(), ParseError::Malformed);
        let mut p = Parser::new(Unit::CodePoints);
        p.push(b"99999999999.x;");
        assert_eq!(p.next().unwrap_err(), ParseError::TooLong);
        let mut p = Parser::new(Unit::CodePoints);
        p.push(&[b'2', b'.', 0xFF, 0xFE, b';']);
        assert_eq!(p.next().unwrap_err(), ParseError::Malformed);
    }

    #[test]
    fn version_parsing() {
        assert_eq!(parse_version("VERSION_1_5_0"), Some((1, 5, 0)));
        assert_eq!(parse_version("hostname"), None);
        assert_eq!(version_string((1, 3, 0)), "VERSION_1_3_0");
        assert_eq!((1, 6, 0).min(OUR_VERSION), (1, 5, 0));
    }
}
