//! RustDesk 線路格式裡中繼需要懂的那一點點（純函式）。
//!
//! TCP 分框 `BytesCodec`（hbb_common/src/bytes_codec.rs）：1–4 bytes little-endian 前綴，低 2 bits = 前綴長度 − 1，
//! 其餘 bits = 長度（`len << 2`）。WebSocket 那端則是一則 binary message 一則訊息，所以中繼只做重新分框。
//! rendezvous protobuf 的最外層：中繼假裝 hbbs 時只要認得 `punch_hole_request`（欄位 8）和 `request_relay`
//! （欄位 18），並回一則 `relay_response`（欄位 19：`uuid` = 2、`relay_server` = 3）。內容其他部分一概不解析。
//! 對裝置的 peer 訊息（message.proto 的 `Message`）只看最外層欄位：`login_request`（7）決定這條連線是遙控、
//! 傳檔還是別的（[`LoginGuard`]），`public_key`（4）帶內容 = 要加密（Telepy 從不給金鑰，所以那不是我們的核心）。
//! The slice of RustDesk's wire format the relay needs: the TCP frame header, the three rendezvous messages, and
//! just enough of the peer `Message` to see what a connection logs in as (remote control, file transfer, …).

/// 一則訊息最大 16 MiB（畫面幀遠小於此；防惡意長度）。/ Cap on one frame.
pub const MAX_FRAME: usize = 16 * 1024 * 1024;
pub const PUNCH_HOLE_REQUEST: u32 = 8;
pub const REQUEST_RELAY: u32 = 18;
pub const RELAY_RESPONSE: u32 = 19;

/// 一則訊息 → 帶長度前綴的 TCP 框。/ One message with its frame header.
pub fn encode_frame(data: &[u8]) -> Vec<u8> {
    let n = data.len();
    let mut out = Vec::with_capacity(n + 4);
    if n <= 0x3F {
        out.push((n << 2) as u8);
    } else if n <= 0x3FFF {
        out.extend_from_slice(&(((n << 2) | 0x1) as u16).to_le_bytes());
    } else if n <= 0x3F_FFFF {
        let h = ((n << 2) | 0x2) as u32;
        out.extend_from_slice(&[h as u8, (h >> 8) as u8, (h >> 16) as u8]);
    } else {
        out.extend_from_slice(&(((n << 2) | 0x3) as u32).to_le_bytes());
    }
    out.extend_from_slice(data);
    out
}

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    /// 長度超過 [`MAX_FRAME`]。/ Declared length above the cap.
    TooLong(usize),
}

/// 緩衝區開頭有沒有一則完整的框：`Ok(Some((payload, consumed)))`；不完整 → `Ok(None)`。
/// A complete frame at the start of the buffer, if any.
pub fn decode_frame(buf: &[u8]) -> Result<Option<(&[u8], usize)>, FrameError> {
    if buf.is_empty() {
        return Ok(None);
    }
    let head_len = ((buf[0] & 0x3) + 1) as usize;
    if buf.len() < head_len {
        return Ok(None);
    }
    let mut n = (buf[0] >> 2) as usize;
    if head_len >= 2 {
        n |= (buf[1] as usize) << 6;
    }
    if head_len >= 3 {
        n |= (buf[2] as usize) << 14;
    }
    if head_len >= 4 {
        n |= (buf[3] as usize) << 22;
    }
    if n > MAX_FRAME {
        return Err(FrameError::TooLong(n));
    }
    if buf.len() < head_len + n {
        return Ok(None);
    }
    Ok(Some((&buf[head_len..head_len + n], head_len + n)))
}

fn varint(mut n: u64, out: &mut Vec<u8>) {
    loop {
        let b = (n & 0x7F) as u8;
        n >>= 7;
        if n == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

fn read_varint(buf: &[u8]) -> Option<(u64, usize)> {
    let mut n: u64 = 0;
    let mut shift = 0;
    for (i, b) in buf.iter().enumerate().take(10) {
        n |= ((b & 0x7F) as u64) << shift;
        if b & 0x80 == 0 {
            return Some((n, i + 1));
        }
        shift += 7;
    }
    None
}

/// 最外層第一個欄位的編號（rendezvous 訊息的 oneof 分支）。/ The first top-level field number.
pub fn top_field(msg: &[u8]) -> Option<u32> {
    let (tag, _) = read_varint(msg)?;
    Some((tag >> 3) as u32)
}

fn field_bytes(num: u32, data: &[u8], out: &mut Vec<u8>) {
    varint(((num as u64) << 3) | 2, out);
    varint(data.len() as u64, out);
    out.extend_from_slice(data);
}

/// `RendezvousMessage { relay_response { uuid, relay_server } }`。/ The reply to a punch-hole request.
pub fn relay_response(uuid: &str, relay_server: &str) -> Vec<u8> {
    let mut inner = Vec::new();
    field_bytes(2, uuid.as_bytes(), &mut inner);
    field_bytes(3, relay_server.as_bytes(), &mut inner);
    let mut out = Vec::new();
    field_bytes(RELAY_RESPONSE, &inner, &mut out);
    out
}

/// 一個 protobuf 欄位：編號 + 值（長度分隔的是內容，varint / 定長的是空切片）。/ One protobuf field.
struct Field<'a> {
    num: u32,
    bytes: &'a [u8],
}

/// 逐一讀出最外層欄位；格式壞了 → None。/ The top-level fields of a message; None when malformed.
fn fields(mut msg: &[u8]) -> Option<Vec<Field<'_>>> {
    let mut out = Vec::new();
    while !msg.is_empty() {
        let (tag, used) = read_varint(msg)?;
        msg = &msg[used..];
        let num = (tag >> 3) as u32;
        match tag & 7 {
            0 => {
                let (_, used) = read_varint(msg)?;
                msg = &msg[used..];
                out.push(Field { num, bytes: &[] });
            }
            1 => {
                msg = msg.get(8..)?;
                out.push(Field { num, bytes: &[] });
            }
            2 => {
                let (len, used) = read_varint(msg)?;
                let end = used.checked_add(usize::try_from(len).ok()?)?;
                let bytes = msg.get(used..end)?;
                msg = &msg[end..];
                out.push(Field { num, bytes });
            }
            5 => {
                msg = msg.get(4..)?;
                out.push(Field { num, bytes: &[] });
            }
            _ => return None,
        }
    }
    Some(out)
}

/// peer `Message` 的欄位編號（message.proto）。/ Field numbers of the peer `Message`.
pub const MSG_PUBLIC_KEY: u32 = 4;
pub const MSG_LOGIN_REQUEST: u32 = 7;
pub const MSG_AUDIO_FRAME: u32 = 11;
pub const MSG_FILE_ACTION: u32 = 17;
pub const MSG_FILE_RESPONSE: u32 = 18;
/// `LoginRequest` 的 oneof 分支。/ The `LoginRequest` oneof arms.
const LOGIN_FILE_TRANSFER: u32 = 7;
const LOGIN_PORT_FORWARD: u32 = 8;
const LOGIN_VIEW_CAMERA: u32 = 15;
const LOGIN_TERMINAL: u32 = 16;

/// 一條 RustDesk 連線登入成什麼。沒有 oneof 分支 = 遙控（看畫面、操作）。/ What a connection logs in as.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LoginKind {
    Control,
    FileTransfer,
    PortForward,
    ViewCamera,
    Terminal,
}

impl LoginKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Control => "remote control",
            Self::FileTransfer => "file transfer",
            Self::PortForward => "port forward",
            Self::ViewCamera => "camera",
            Self::Terminal => "terminal",
        }
    }
}

/// 這則訊息是 `login_request` 的話，它登入成什麼；不是 → None。/ The login kind, when this is a `login_request`.
pub fn login_kind(msg: &[u8]) -> Option<Result<LoginKind, ()>> {
    let Some(top) = fields(msg) else { return if top_field(msg) == Some(MSG_LOGIN_REQUEST) { Some(Err(())) } else { None } };
    let login = top.iter().find(|f| f.num == MSG_LOGIN_REQUEST)?;
    let Some(inner) = fields(login.bytes) else { return Some(Err(())) };
    let kind = inner.iter().find_map(|f| match f.num {
        LOGIN_FILE_TRANSFER => Some(LoginKind::FileTransfer),
        LOGIN_PORT_FORWARD => Some(LoginKind::PortForward),
        LOGIN_VIEW_CAMERA => Some(LoginKind::ViewCamera),
        LOGIN_TERMINAL => Some(LoginKind::Terminal),
        _ => None,
    });
    Some(Ok(kind.unwrap_or(LoginKind::Control)))
}

/// 帶內容的 `public_key`：瀏覽器要和裝置交換金鑰、之後全部加密。/ A `public_key` with content: the stream is about to be encrypted.
pub fn starts_encryption(msg: &[u8]) -> bool {
    let Some(top) = fields(msg) else { return false };
    top.iter().any(|f| f.num == MSG_PUBLIC_KEY && fields(f.bytes).map(|inner| inner.iter().any(|i| !i.bytes.is_empty())).unwrap_or(true))
}

/// 登入之前最多容忍幾則訊息（核心在裝置的 hash 之後就登入）。/ Messages tolerated before the login.
pub const MESSAGES_BEFORE_LOGIN: u32 = 32;

/// 瀏覽器 → 裝置方向的守門：這條中繼只准登入成 `expect`（畫面 session = 遙控，檔案 session = 傳檔）。
/// - 登入成別的、或格式壞的登入 → 拒絕；登入前訊息太多 → 拒絕（看不到登入就不放行）。
/// - 要求加密（帶內容的 `public_key`）→ 拒絕：Telepy 的假 hbbs 從不給裝置的金鑰，所以我們的核心永遠走不加密的
///   Direct IP（整段在 TLS + SSH 裡）；會加密的只會是改過的客戶端，而加密後就看不到它登入成什麼了。
/// - 登入之後也繼續看（再送一個登入換成傳檔一樣拒絕）。
///
/// Guards the browser → device direction: the relay only admits a login of the expected kind (screen session =
/// remote control, files session = file transfer). A different or malformed login, too many messages before the
/// login, or an attempt to encrypt (our core never has the device's key, so only a modified client would) is refused.
pub struct LoginGuard {
    expect: LoginKind,
    logged_in: bool,
    before_login: u32,
}

impl LoginGuard {
    pub fn new(expect: LoginKind) -> Self {
        Self { expect, logged_in: false, before_login: 0 }
    }

    pub fn logged_in(&self) -> bool {
        self.logged_in
    }

    /// Ok = 放行；Err = 拒絕的原因（給日誌）。/ Ok = forward it; Err = why it is refused.
    pub fn check(&mut self, msg: &[u8]) -> Result<(), String> {
        if starts_encryption(msg) {
            return Err("the browser tried to encrypt the RustDesk stream (Telepy's own client never does)".into());
        }
        match login_kind(msg) {
            Some(Ok(kind)) if kind == self.expect => {
                self.logged_in = true;
                Ok(())
            }
            Some(Ok(kind)) => Err(format!("a {} login on a {} session", kind.as_str(), self.expect.as_str())),
            Some(Err(())) => Err("a malformed login request".into()),
            None if self.logged_in => Ok(()),
            None => {
                self.before_login += 1;
                if self.before_login > MESSAGES_BEFORE_LOGIN {
                    Err("no login request within the first messages".into())
                } else {
                    Ok(())
                }
            }
        }
    }
}

/// 測試與假裝置用：一個 peer `Message`，最外層只有欄位 `field`（內容 `inner`）。/ For tests: a peer message.
pub fn peer_message(field: u32, inner: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    field_bytes(field, inner, &mut out);
    out
}

/// 測試用：`LoginRequest`，`arm` = oneof 分支（None = 遙控）。/ For tests: a login request with the given oneof arm.
pub fn login_request(arm: Option<u32>) -> Vec<u8> {
    let mut inner = Vec::new();
    field_bytes(1, b"telepy", &mut inner);
    // password（bytes）、my_id、version：真的登入一定有的幾個欄位。/ A few fields every real login carries.
    field_bytes(2, &[7u8; 32], &mut inner);
    field_bytes(4, b"web", &mut inner);
    if let Some(arm) = arm {
        let mut ft = Vec::new();
        field_bytes(1, b"/home", &mut ft);
        field_bytes(arm, &ft, &mut inner);
    }
    varint((9 << 3) as u64, &mut inner);
    varint(1, &mut inner);
    field_bytes(11, b"1.4.0", &mut inner);
    peer_message(MSG_LOGIN_REQUEST, &inner)
}

/// 測試與假裝置用：`RendezvousMessage { <field> { id } }`。/ For tests: a rendezvous message with an `id` string.
pub fn rendezvous_with_id(field: u32, id: &str) -> Vec<u8> {
    let mut inner = Vec::new();
    field_bytes(1, id.as_bytes(), &mut inner);
    let mut out = Vec::new();
    field_bytes(field, &inner, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_at_every_header_size() {
        for n in [0usize, 1, 0x3F, 0x40, 0x3FFF, 0x4000, 0x3F_FFFF, 0x40_0000] {
            let data = vec![0xABu8; n];
            let frame = encode_frame(&data);
            let expect_head = if n <= 0x3F { 1 } else if n <= 0x3FFF { 2 } else if n <= 0x3F_FFFF { 3 } else { 4 };
            assert_eq!(frame.len(), n + expect_head, "n={n}");
            assert_eq!((frame[0] & 0x3) as usize + 1, expect_head);
            let (payload, used) = decode_frame(&frame).unwrap().unwrap();
            assert_eq!(payload, &data[..]);
            assert_eq!(used, frame.len());
            // 少一個 byte 就不完整。/ One byte short is incomplete.
            assert_eq!(decode_frame(&frame[..frame.len() - 1]).unwrap(), None);
        }
    }

    #[test]
    fn two_frames_in_one_buffer() {
        let mut buf = encode_frame(b"abc");
        buf.extend(encode_frame(b"defgh"));
        let (a, used) = decode_frame(&buf).unwrap().unwrap();
        assert_eq!(a, b"abc");
        let (b, used2) = decode_frame(&buf[used..]).unwrap().unwrap();
        assert_eq!(b, b"defgh");
        assert_eq!(used + used2, buf.len());
    }

    #[test]
    fn matches_what_a_real_device_sent() {
        // 實測從 RustDesk 1.5.0 的 21118 收到的前幾個 bytes：前綴 0xb0 = 44 << 2，接著 protobuf 第 9 欄（hash）。
        // Bytes observed from a real device: header 0xb0 = 44 << 2, then protobuf field 9 (hash).
        let mut frame = vec![0xb0u8, 0x4a, 0x2a, 0x0a, 0x20];
        frame.extend(std::iter::repeat_n(b'x', 40));
        let (payload, used) = decode_frame(&frame).unwrap().unwrap();
        assert_eq!(payload.len(), 44);
        assert_eq!(used, 45);
        assert_eq!(top_field(payload), Some(9));
    }

    #[test]
    fn oversized_frames_are_refused() {
        let header = ((MAX_FRAME + 1) << 2 | 0x3) as u32;
        let buf = header.to_le_bytes().to_vec();
        assert_eq!(decode_frame(&buf), Err(FrameError::TooLong(MAX_FRAME + 1)));
    }

    #[test]
    fn login_kinds_are_read_from_the_oneof_arm() {
        assert_eq!(login_kind(&login_request(None)), Some(Ok(LoginKind::Control)));
        assert_eq!(login_kind(&login_request(Some(LOGIN_FILE_TRANSFER))), Some(Ok(LoginKind::FileTransfer)));
        assert_eq!(login_kind(&login_request(Some(LOGIN_PORT_FORWARD))), Some(Ok(LoginKind::PortForward)));
        assert_eq!(login_kind(&login_request(Some(LOGIN_TERMINAL))), Some(Ok(LoginKind::Terminal)));
        // 其他訊息不是登入；空訊息（核心 pk 對不上時送的）也不是。/ Other messages, and the empty one, are not logins.
        assert_eq!(login_kind(&peer_message(MSG_AUDIO_FRAME, b"opus")), None);
        assert_eq!(login_kind(&[]), None);
        // 截斷的登入 = 壞的。/ A truncated login is malformed.
        let full = login_request(None);
        assert_eq!(login_kind(&full[..full.len() - 3]), Some(Err(())));
    }

    #[test]
    fn the_guard_admits_only_the_expected_login() {
        let mut g = LoginGuard::new(LoginKind::Control);
        assert!(g.check(&[]).is_ok(), "the core's empty handshake message");
        assert!(g.check(&peer_message(MSG_PUBLIC_KEY, &[])).is_ok(), "an empty public key = stay unencrypted");
        assert!(g.check(&login_request(None)).is_ok());
        assert!(g.logged_in());
        assert!(g.check(&peer_message(MSG_FILE_ACTION, b"x")).is_ok());
        // 登入後再送一個傳檔登入。/ A second, file-transfer login after the first.
        assert!(g.check(&login_request(Some(LOGIN_FILE_TRANSFER))).unwrap_err().contains("file transfer login on a remote control session"));

        let mut g = LoginGuard::new(LoginKind::FileTransfer);
        assert!(g.check(&login_request(None)).is_err(), "remote control on a files session");
        let mut g = LoginGuard::new(LoginKind::FileTransfer);
        assert!(g.check(&login_request(Some(LOGIN_FILE_TRANSFER))).is_ok());

        // 要加密 → 拒絕（之後就看不到登入了）。/ Encryption is refused.
        let mut key = Vec::new();
        field_bytes(1, &[9u8; 32], &mut key);
        let mut g = LoginGuard::new(LoginKind::Control);
        assert!(g.check(&peer_message(MSG_PUBLIC_KEY, &key)).unwrap_err().contains("encrypt"));

        // 一直不登入。/ Never logging in.
        let mut g = LoginGuard::new(LoginKind::Control);
        for _ in 0..MESSAGES_BEFORE_LOGIN {
            assert!(g.check(&peer_message(MSG_AUDIO_FRAME, b"x")).is_ok());
        }
        assert!(g.check(&peer_message(MSG_AUDIO_FRAME, b"x")).is_err());
    }

    #[test]
    fn rendezvous_messages_encode_and_classify() {
        let punch = rendezvous_with_id(PUNCH_HOLE_REQUEST, "telepy");
        assert_eq!(top_field(&punch), Some(PUNCH_HOLE_REQUEST));
        let relay = rendezvous_with_id(REQUEST_RELAY, "telepy");
        assert_eq!(top_field(&relay), Some(REQUEST_RELAY));
        let resp = relay_response("abc123", "wss://telepy/ws/rustdesk/x/");
        assert_eq!(top_field(&resp), Some(RELAY_RESPONSE));
        // 內層：欄位 2 = uuid、欄位 3 = relay_server。/ Inner fields 2 and 3.
        let (_, head) = read_varint(&resp).unwrap();
        let (len, lh) = read_varint(&resp[head..]).unwrap();
        let inner = &resp[head + lh..head + lh + len as usize];
        assert_eq!(inner[0] >> 3, 2);
        assert_eq!(&inner[2..8], b"abc123");
        assert_eq!(inner[8] >> 3, 3);
        assert_eq!(top_field(&[]), None);
        assert_eq!(top_field(&[0xFF]), None);
    }
}
