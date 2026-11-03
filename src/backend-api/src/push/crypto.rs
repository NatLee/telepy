//! Web Push 的內容加密（RFC 8291，`aes128gcm`，RFC 8188 的一筆記錄）。瀏覽器訂閱時給的公鑰（`p256dh`）與共用秘密
//! （`auth`）加上我們每則訊息新產生的 ECDH 金鑰與 salt，推出 AES-128-GCM 的金鑰與 nonce；推播服務（Google / Apple /
//! Mozilla / Microsoft）只看得到密文。純函式，測試用 RFC 8291 附錄 A 的數值逐位元組比對。
//! Web Push content encryption (RFC 8291, `aes128gcm`, a single RFC 8188 record). The browser's subscription key
//! (`p256dh`) and shared secret (`auth`), plus a fresh ECDH key and salt per message, give the AES-128-GCM key and nonce;
//! the push service (Google / Apple / Mozilla / Microsoft) only sees ciphertext. Pure; the tests compare byte for byte
//! with RFC 8291 appendix A.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use p256::{PublicKey, SecretKey};
use sha2::Sha256;

/// 一筆記錄的大小（header 裡寫的 rs）。/ The record size written in the header.
pub const RECORD_SIZE: u32 = 4096;
/// 明文上限：4096 − header 86 − tag 16 − 分隔字元 1。/ The plaintext limit: 4096 − 86 header − 16 tag − 1 delimiter.
pub const PLAINTEXT_MAX: usize = RECORD_SIZE as usize - 86 - 16 - 1;

/// base64url（有沒有 `=` 都收）。/ base64url, padded or not.
pub fn b64(s: &str) -> Result<Vec<u8>, &'static str> {
    URL_SAFE_NO_PAD.decode(s.trim().trim_end_matches('=')).map_err(|_| "not base64url")
}

pub fn b64_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// 訂閱的兩把鑰匙是否像樣：`p256dh` = 65 位元組、P-256 曲線上的未壓縮點；`auth` = 16 位元組。
/// Whether a subscription's keys make sense: `p256dh` = a 65-byte uncompressed P-256 point, `auth` = 16 bytes.
pub fn check_keys(p256dh: &str, auth: &str) -> Result<(), &'static str> {
    let key = b64(p256dh)?;
    if key.len() != 65 || key[0] != 4 || PublicKey::from_sec1_bytes(&key).is_err() {
        return Err("p256dh is not a P-256 public key");
    }
    if b64(auth)?.len() != 16 {
        return Err("auth must be 16 bytes");
    }
    Ok(())
}

/// 未壓縮的公鑰（65 位元組）。/ The uncompressed public key (65 bytes).
pub fn public_bytes(secret: &SecretKey) -> Vec<u8> {
    secret.public_key().to_sec1_bytes().to_vec()
}

/// 隨機的 P-256 私鑰（從作業系統亂數取 32 位元組，不在曲線範圍內就重抽）。/ A random P-256 key (32 OS-random bytes, redrawn if out of range).
pub fn random_secret() -> SecretKey {
    use rand::RngCore;
    loop {
        let mut b = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut b);
        if let Ok(k) = SecretKey::from_slice(&b) {
            return k;
        }
    }
}

fn expand(prk: &Hkdf<Sha256>, info: &[u8], out: &mut [u8]) {
    prk.expand(info, out).expect("HKDF output length is valid");
}

/// 推出內容加密金鑰與 nonce（RFC 8291 §3.4 + RFC 8188 §2.2）。/ Derive the content key and nonce.
fn keys(as_secret: &SecretKey, salt: &[u8; 16], ua_public: &[u8], auth: &[u8]) -> Result<([u8; 16], [u8; 12]), &'static str> {
    let ua = PublicKey::from_sec1_bytes(ua_public).map_err(|_| "p256dh is not a P-256 public key")?;
    let ecdh = p256::ecdh::diffie_hellman(as_secret.to_nonzero_scalar(), ua.as_affine());
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(&public_bytes(as_secret));
    let mut ikm = [0u8; 32];
    expand(&Hkdf::<Sha256>::new(Some(auth), ecdh.raw_secret_bytes().as_slice()), &key_info, &mut ikm);
    let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    expand(&prk, b"Content-Encoding: aes128gcm\0", &mut cek);
    let mut nonce = [0u8; 12];
    expand(&prk, b"Content-Encoding: nonce\0", &mut nonce);
    Ok((cek, nonce))
}

/// 用指定的金鑰與 salt 加密（測試向量用；送出時用 [`encrypt`]）。/ Encrypt with a given key and salt (test vectors; sending uses [`encrypt`]).
pub fn encrypt_with(as_secret: &SecretKey, salt: &[u8; 16], ua_public: &[u8], auth: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, &'static str> {
    if plaintext.len() > PLAINTEXT_MAX {
        return Err("the message is too long for one push");
    }
    let (cek, nonce) = keys(as_secret, salt, ua_public, auth)?;
    let mut padded = plaintext.to_vec();
    // 最後一筆記錄的分隔字元。/ The last record's delimiter.
    padded.push(2);
    let cipher = Aes128Gcm::new_from_slice(&cek).expect("16-byte key");
    let sealed = cipher.encrypt(Nonce::from_slice(&nonce), padded.as_slice()).map_err(|_| "encryption failed")?;
    let key_id = public_bytes(as_secret);
    let mut out = Vec::with_capacity(16 + 4 + 1 + key_id.len() + sealed.len());
    out.extend_from_slice(salt);
    out.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    out.push(key_id.len() as u8);
    out.extend_from_slice(&key_id);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// 加密一則推播：每次都是新的 ECDH 金鑰與 salt。/ Encrypt one push: a fresh ECDH key and salt every time.
pub fn encrypt(ua_public: &[u8], auth: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, &'static str> {
    use rand::RngCore;
    let mut salt = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    encrypt_with(&random_secret(), &salt, ua_public, auth, plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 8291 附錄 A。/ RFC 8291 appendix A.
    const PLAINTEXT: &str = "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24";
    const AS_PUBLIC: &str = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    const AS_PRIVATE: &str = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const UA_PUBLIC: &str = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const UA_PRIVATE: &str = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
    const SALT: &str = "DGv6ra1nlYgDCS1FRnbzlw";
    const AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";
    const CEK: &str = "oIhVW04MRdy2XN9CiKLxTg";
    const NONCE: &str = "4h_95klXJ5E_qnoN";
    const HEADER: &str = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    const CIPHERTEXT: &str = "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ";

    fn salt() -> [u8; 16] {
        b64(SALT).unwrap().try_into().unwrap()
    }

    #[test]
    fn keys_match_rfc_8291_appendix_a() {
        let as_secret = SecretKey::from_slice(&b64(AS_PRIVATE).unwrap()).unwrap();
        assert_eq!(b64_encode(&public_bytes(&as_secret)), AS_PUBLIC);
        let (cek, nonce) = keys(&as_secret, &salt(), &b64(UA_PUBLIC).unwrap(), &b64(AUTH).unwrap()).unwrap();
        assert_eq!(b64_encode(&cek), CEK);
        assert_eq!(b64_encode(&nonce), NONCE);
    }

    #[test]
    fn the_message_matches_rfc_8291_appendix_a_byte_for_byte() {
        let as_secret = SecretKey::from_slice(&b64(AS_PRIVATE).unwrap()).unwrap();
        let body = encrypt_with(&as_secret, &salt(), &b64(UA_PUBLIC).unwrap(), &b64(AUTH).unwrap(), &b64(PLAINTEXT).unwrap()).unwrap();
        let mut want = b64(HEADER).unwrap();
        assert_eq!(want.len(), 86, "the RFC's header is 86 octets");
        want.extend(b64(CIPHERTEXT).unwrap());
        assert_eq!(b64_encode(&body), b64_encode(&want));
    }

    /// 瀏覽器那一端：用 UA 私鑰與 header 裡的 keyid 解回來。/ The browser's side: decrypt with the UA key and the header's keyid.
    fn decrypt(ua_secret: &SecretKey, auth: &[u8], body: &[u8]) -> Vec<u8> {
        let salt: [u8; 16] = body[..16].try_into().unwrap();
        let idlen = body[20] as usize;
        let as_public = PublicKey::from_sec1_bytes(&body[21..21 + idlen]).unwrap();
        let ecdh = p256::ecdh::diffie_hellman(ua_secret.to_nonzero_scalar(), as_public.as_affine());
        let mut key_info = b"WebPush: info\0".to_vec();
        key_info.extend_from_slice(&public_bytes(ua_secret));
        key_info.extend_from_slice(&body[21..21 + idlen]);
        let mut ikm = [0u8; 32];
        expand(&Hkdf::<Sha256>::new(Some(auth), ecdh.raw_secret_bytes().as_slice()), &key_info, &mut ikm);
        let prk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
        let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
        expand(&prk, b"Content-Encoding: aes128gcm\0", &mut cek);
        expand(&prk, b"Content-Encoding: nonce\0", &mut nonce);
        let mut plain = Aes128Gcm::new_from_slice(&cek).unwrap().decrypt(Nonce::from_slice(&nonce), &body[21 + idlen..]).unwrap();
        assert_eq!(plain.pop(), Some(2), "the last record ends with 0x02");
        plain
    }

    #[test]
    fn a_fresh_message_round_trips_and_never_repeats() {
        let ua_secret = SecretKey::from_slice(&b64(UA_PRIVATE).unwrap()).unwrap();
        let (ua_public, auth) = (b64(UA_PUBLIC).unwrap(), b64(AUTH).unwrap());
        let a = encrypt(&ua_public, &auth, b"{\"title\":\"Telepy\"}").unwrap();
        let b = encrypt(&ua_public, &auth, b"{\"title\":\"Telepy\"}").unwrap();
        assert_ne!(a, b, "a new key and salt every time");
        assert_eq!(decrypt(&ua_secret, &auth, &a), b"{\"title\":\"Telepy\"}");
        assert!(encrypt(&ua_public, &auth, &vec![b'x'; PLAINTEXT_MAX + 1]).is_err());
        assert!(encrypt(&ua_public, &auth, &vec![b'x'; PLAINTEXT_MAX]).is_ok());
    }

    #[test]
    fn subscription_keys_are_checked() {
        assert_eq!(check_keys(UA_PUBLIC, AUTH), Ok(()));
        assert_eq!(check_keys(&format!("{UA_PUBLIC}=="), &format!("{AUTH}==")), Ok(()), "padding is accepted");
        assert!(check_keys(&UA_PUBLIC[..40], AUTH).is_err());
        assert!(check_keys(UA_PUBLIC, "AAAA").is_err());
        let mut off_curve = b64(UA_PUBLIC).unwrap();
        off_curve[64] ^= 1;
        assert!(check_keys(&b64_encode(&off_curve), AUTH).is_err(), "a point off the curve");
    }
}
