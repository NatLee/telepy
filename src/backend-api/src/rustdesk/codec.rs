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
pub const PUNCH_HOLE_RESPONSE: u32 = 11;
pub const REGISTER_PK: u32 = 15;
pub const REGISTER_PK_RESPONSE: u32 = 16;
pub const REQUEST_RELAY: u32 = 18;
pub const RELAY_RESPONSE: u32 = 19;

/// `RegisterPkResponse.Result`（只列 Telepy 會回的）。/ The register results Telepy answers with.
pub mod register_result {
    pub const OK: u64 = 0;
    /// 「這台沒登記」：裝置停著、每 30 秒重試，直到 `rustdesk --deploy --token …`。/ Not enrolled: the device waits for `--deploy`.
    pub const NOT_DEPLOYED: u64 = 8;
    /// 換 ID（`--set-id`）不支援。/ ID changes are not supported.
    pub const NOT_SUPPORT: u64 = 6;
}

/// `PunchHoleResponse.Failure`。
pub mod punch_failure {
    pub const ID_NOT_EXIST: u64 = 0;
    pub const OFFLINE: u64 = 2;
}

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

fn field_varint(num: u32, v: u64, out: &mut Vec<u8>) {
    varint((num as u64) << 3, out);
    varint(v, out);
}

/// 解析出的一個欄位：varint 或 length-delimited（fixed32 / fixed64 只跳過）。/ One parsed field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldValue<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
    Fixed,
}

/// 一則 protobuf 訊息最外層的欄位；壞資料回 None。/ The top-level fields of a message; None on malformed input.
pub fn fields(buf: &[u8]) -> Option<Vec<(u32, FieldValue<'_>)>> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < buf.len() {
        let (tag, n) = read_varint(&buf[pos..])?;
        pos += n;
        let num = (tag >> 3) as u32;
        match tag & 7 {
            0 => {
                let (v, n) = read_varint(&buf[pos..])?;
                pos += n;
                out.push((num, FieldValue::Varint(v)));
            }
            2 => {
                let (len, n) = read_varint(&buf[pos..])?;
                pos += n;
                let end = pos.checked_add(usize::try_from(len).ok()?)?;
                if end > buf.len() {
                    return None;
                }
                out.push((num, FieldValue::Bytes(&buf[pos..end])));
                pos = end;
            }
            1 => {
                pos = pos.checked_add(8).filter(|e| *e <= buf.len())?;
                out.push((num, FieldValue::Fixed));
            }
            5 => {
                pos = pos.checked_add(4).filter(|e| *e <= buf.len())?;
                out.push((num, FieldValue::Fixed));
            }
            _ => return None,
        }
    }
    Some(out)
}

fn bytes_field<'a>(fs: &[(u32, FieldValue<'a>)], num: u32) -> &'a [u8] {
    fs.iter()
        .find_map(|(n, v)| match v {
            FieldValue::Bytes(b) if *n == num => Some(*b),
            _ => None,
        })
        .unwrap_or(&[])
}

fn string_field(fs: &[(u32, FieldValue<'_>)], num: u32) -> String {
    String::from_utf8_lossy(bytes_field(fs, num)).into_owned()
}

/// rendezvous 訊息的 oneof：(欄位號碼, 內層欄位)。/ The oneof case of a rendezvous message and its inner fields.
pub fn rendezvous(msg: &[u8]) -> Option<(u32, Vec<(u32, FieldValue<'_>)>)> {
    let top = fields(msg)?;
    let (num, value) = top.into_iter().next()?;
    match value {
        FieldValue::Bytes(inner) => Some((num, fields(inner)?)),
        _ => None,
    }
}

/// 裝置的 `RegisterPk`。/ A device's key registration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisterPk {
    pub id: String,
    pub uuid: Vec<u8>,
    pub pk: Vec<u8>,
    /// 非空 = `--set-id` 換 ID。/ Non-empty = an ID change.
    pub old_id: String,
}

pub fn parse_register_pk(msg: &[u8]) -> Option<RegisterPk> {
    let (num, fs) = rendezvous(msg)?;
    (num == REGISTER_PK).then(|| RegisterPk { id: string_field(&fs, 1), uuid: bytes_field(&fs, 2).to_vec(), pk: bytes_field(&fs, 3).to_vec(), old_id: string_field(&fs, 4) })
}

/// 瀏覽器核心的 `PunchHoleRequest` 要找的 id。/ The id a browser core asks for.
pub fn parse_punch_hole_id(msg: &[u8]) -> Option<String> {
    let (num, fs) = rendezvous(msg)?;
    (num == PUNCH_HOLE_REQUEST).then(|| string_field(&fs, 1))
}

/// 中繼端（瀏覽器或裝置）`RequestRelay` 的 uuid。/ The uuid in a relay-side `RequestRelay`.
pub fn parse_request_relay_uuid(msg: &[u8]) -> Option<String> {
    let (num, fs) = rendezvous(msg)?;
    (num == REQUEST_RELAY).then(|| string_field(&fs, 2)).filter(|u| !u.is_empty())
}

pub fn register_pk_response(result: u64, keep_alive_secs: u64) -> Vec<u8> {
    let mut inner = Vec::new();
    field_varint(1, result, &mut inner);
    field_varint(2, keep_alive_secs, &mut inner);
    let mut out = Vec::new();
    field_bytes(REGISTER_PK_RESPONSE, &inner, &mut out);
    out
}

/// 推給裝置的「開一條中繼」：`RequestRelay { uuid, socket_addr, relay_server, secure }`。
/// The relay request pushed to a registered device.
pub fn request_relay(uuid: &str, socket_addr: &[u8], relay_server: &str, secure: bool) -> Vec<u8> {
    let mut inner = Vec::new();
    field_bytes(2, uuid.as_bytes(), &mut inner);
    field_bytes(3, socket_addr, &mut inner);
    field_bytes(4, relay_server.as_bytes(), &mut inner);
    if secure {
        field_varint(5, 1, &mut inner);
    }
    let mut out = Vec::new();
    field_bytes(REQUEST_RELAY, &inner, &mut out);
    out
}

/// 回瀏覽器的 `RelayResponse { uuid, relay_server, pk = 伺服器簽過的 IdPk }`。/ The relay answer with the signed device key.
pub fn relay_response_with_pk(uuid: &str, relay_server: &str, signed_id_pk: &[u8]) -> Vec<u8> {
    let mut inner = Vec::new();
    field_bytes(2, uuid.as_bytes(), &mut inner);
    field_bytes(3, relay_server.as_bytes(), &mut inner);
    field_bytes(5, signed_id_pk, &mut inner);
    let mut out = Vec::new();
    field_bytes(RELAY_RESPONSE, &inner, &mut out);
    out
}

/// `PunchHoleResponse { failure, other_failure }`。/ A punch-hole refusal.
pub fn punch_hole_failure(failure: u64, other: &str) -> Vec<u8> {
    let mut inner = Vec::new();
    field_varint(3, failure, &mut inner);
    if !other.is_empty() {
        field_bytes(7, other.as_bytes(), &mut inner);
    }
    let mut out = Vec::new();
    field_bytes(PUNCH_HOLE_RESPONSE, &inner, &mut out);
    out
}

/// `IdPk { id, pk }`：伺服器簽的內容。/ The message the server signs.
pub fn id_pk(id: &str, pk: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    field_bytes(1, id.as_bytes(), &mut out);
    field_bytes(2, pk, &mut out);
    out
}

/// `hbb_common::AddrMangle::encode` 在時間戳 = 0 時的形式：`(ip_le << 49) | port`，little-endian，去掉尾端 0。
/// 每個請求要不同（裝置丟掉 100 ms 內與上一個位址相同的中繼請求，而它的初值就是空位址解出來的 0.0.0.0:0）。
/// AddrMangle with a zero timestamp. Must differ per request: the device drops a relay request equal to the last one.
pub fn mangle_v4(ip: [u8; 4], port: u16) -> Vec<u8> {
    let ip = u32::from_le_bytes(ip) as u128;
    let v = (ip << 49) | port as u128;
    let bytes = v.to_le_bytes();
    let used = bytes.iter().rposition(|b| *b != 0).map(|i| i + 1).unwrap_or(0);
    bytes[..used].to_vec()
}

/// [`mangle_v4`] 的反向（測試用；同 `AddrMangle::decode`）。/ The inverse, for tests.
pub fn unmangle_v4(bytes: &[u8]) -> Option<([u8; 4], u16)> {
    if bytes.len() > 16 {
        return None;
    }
    let mut padded = [0u8; 16];
    padded[..bytes.len()].copy_from_slice(bytes);
    let n = u128::from_le_bytes(padded);
    let tm = (n >> 17) & (u32::MAX as u128);
    let ip = (((n >> 49).checked_sub(tm)?) as u32).to_le_bytes();
    let port = ((n & 0xFF_FFFF).checked_sub(tm & 0xFFFF)?) as u16;
    Some((ip, port))
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

    /// 測試與假裝置用的 `RegisterPk`。/ A RegisterPk for tests.
    fn register_pk(id: &str, uuid: &[u8], pk: &[u8], old_id: &str) -> Vec<u8> {
        let mut inner = Vec::new();
        field_bytes(1, id.as_bytes(), &mut inner);
        field_bytes(2, uuid, &mut inner);
        field_bytes(3, pk, &mut inner);
        if !old_id.is_empty() {
            field_bytes(4, old_id.as_bytes(), &mut inner);
        }
        let mut out = Vec::new();
        field_bytes(REGISTER_PK, &inner, &mut out);
        out
    }

    #[test]
    fn id_server_messages_round_trip() {
        let msg = register_pk("113668456", b"uuid-bytes", &[7u8; 32], "");
        let r = parse_register_pk(&msg).unwrap();
        assert_eq!(r.id, "113668456");
        assert_eq!(r.uuid, b"uuid-bytes");
        assert_eq!(r.pk, vec![7u8; 32]);
        assert_eq!(r.old_id, "");
        assert_eq!(parse_register_pk(&register_pk("tp1", b"u", b"", "113668456")).unwrap().old_id, "113668456");
        assert_eq!(parse_register_pk(&rendezvous_with_id(PUNCH_HOLE_REQUEST, "x")), None, "another message is not a registration");
        assert_eq!(parse_punch_hole_id(&rendezvous_with_id(PUNCH_HOLE_REQUEST, "113668456")).as_deref(), Some("113668456"));

        let rr = request_relay("abc-uuid", &mangle_v4([127, 0, 0, 1], 40001), "wss://t.example/ws/relay", true);
        let (num, fs) = rendezvous(&rr).unwrap();
        assert_eq!(num, REQUEST_RELAY);
        assert_eq!(string_field(&fs, 2), "abc-uuid");
        assert_eq!(string_field(&fs, 4), "wss://t.example/ws/relay");
        assert!(fs.contains(&(5, FieldValue::Varint(1))), "secure flag");
        assert_eq!(parse_request_relay_uuid(&rr).as_deref(), Some("abc-uuid"));

        let resp = register_pk_response(register_result::NOT_DEPLOYED, 30);
        let (num, fs) = rendezvous(&resp).unwrap();
        assert_eq!(num, REGISTER_PK_RESPONSE);
        assert_eq!(fs, vec![(1, FieldValue::Varint(8)), (2, FieldValue::Varint(30))]);

        let signed = [9u8; 80];
        let rr = relay_response_with_pk("u1", "/ws/rustdesk/s/", &signed);
        let (num, fs) = rendezvous(&rr).unwrap();
        assert_eq!(num, RELAY_RESPONSE);
        assert_eq!(bytes_field(&fs, 5), &signed[..]);

        let ph = punch_hole_failure(punch_failure::OFFLINE, "");
        let (num, fs) = rendezvous(&ph).unwrap();
        assert_eq!(num, PUNCH_HOLE_RESPONSE);
        assert_eq!(fs, vec![(3, FieldValue::Varint(2))]);
        assert_eq!(id_pk("a", &[1, 2]), vec![0x0a, 1, b'a', 0x12, 2, 1, 2]);
    }

    #[test]
    fn malformed_messages_do_not_parse() {
        assert_eq!(fields(&[0x0a, 0x05, 1, 2]), None, "length past the end");
        assert_eq!(fields(&[0x0b]), None, "wire type 3");
        assert_eq!(rendezvous(&[]), None);
        assert_eq!(parse_request_relay_uuid(&request_relay("", &[], "x", false)), None, "an empty uuid is no uuid");
    }

    #[test]
    fn addr_mangle_matches_the_device_decoder() {
        // 裝置用 AddrMangle::decode 解；同一個位址每次都要能解回來，而且不同埠 = 不同位元組。
        // The device decodes with AddrMangle::decode; different ports must give different bytes.
        for (ip, port) in [([127, 0, 0, 1], 40001u16), ([192, 168, 1, 50], 1), ([10, 0, 0, 2], 65535)] {
            let m = mangle_v4(ip, port);
            assert!(!m.is_empty() && m.len() <= 16);
            assert_eq!(unmangle_v4(&m), Some((ip, port)));
        }
        assert_ne!(mangle_v4([127, 0, 0, 1], 40001), mangle_v4([127, 0, 0, 1], 40002));
        // 空位址 = 0.0.0.0:0，就是裝置的初值（所以一定要給非空的）。/ Empty decodes to the device's initial value.
        assert_eq!(unmangle_v4(&[]), Some(([0, 0, 0, 0], 0)));
        // PoC 實測送出、裝置接受的那串（127.0.0.1:40001）。/ The bytes the PoC sent and a real device accepted.
        assert_eq!(mangle_v4([127, 0, 0, 1], 40001).len(), 10);
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
