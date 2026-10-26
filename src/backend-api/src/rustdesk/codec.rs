//! RustDesk 線路格式裡中繼需要懂的那一點點（純函式）。
//!
//! TCP 分框 `BytesCodec`（hbb_common/src/bytes_codec.rs）：1–4 bytes little-endian 前綴，低 2 bits = 前綴長度 − 1，
//! 其餘 bits = 長度（`len << 2`）。WebSocket 那端則是一則 binary message 一則訊息，所以中繼只做重新分框。
//! rendezvous protobuf 的最外層：中繼假裝 hbbs 時只要認得 `punch_hole_request`（欄位 8）和 `request_relay`
//! （欄位 18），並回一則 `relay_response`（欄位 19：`uuid` = 2、`relay_server` = 3）。內容其他部分一概不解析。
//! The slice of RustDesk's wire format the relay needs: the TCP frame header and the three rendezvous messages.

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
