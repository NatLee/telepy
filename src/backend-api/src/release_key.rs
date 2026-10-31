//! Telepy 發行版的簽章：CI 用發行金鑰（OpenSSH ed25519，secret `RELEASE_SIGNING_KEY`）對每個 release 的 `SHA256SUMS` 做
//! `ssh-keygen -Y sign -n telepy-release`，產生 `SHA256SUMS.sig`（OpenSSH 的 SSHSIG 格式）。後端抓裝置載體（`carriers.rs`）
//! 與 `telepy update` 先用這裡的公鑰驗過簽章才信 `SHA256SUMS`，所以換掉 release 頁或鏡像上的檔案也換不掉裝置拿到的東西。
//! 這個檔案由 CLI 用 `#[path]` 共用（兩邊各自把 `ssh_key` crate 取別名成 `crate::ssh_key`）；公鑰輪替 = 多加一行，舊的留到
//! 舊 release 不再需要。`TELEPY_RELEASE_KEYS`（換行或 `;` 分隔的公鑰行）可以換掉內建的，給用自己的金鑰重簽的鏡像用。
//!
//! Release signatures: CI signs every release's `SHA256SUMS` with the release key (an OpenSSH ed25519 key in the
//! `RELEASE_SIGNING_KEY` secret, `ssh-keygen -Y sign -n telepy-release`) into `SHA256SUMS.sig` (OpenSSH's SSHSIG format).
//! The backend's carrier fetch and `telepy update` verify that signature with the keys here before trusting
//! `SHA256SUMS`, so swapping files on the release page or a mirror does not change what devices get. Shared with the
//! CLI through `#[path]` (each crate aliases the `ssh_key` crate as `crate::ssh_key`); rotation = one more line, the old
//! one stays until old releases no longer matter. `TELEPY_RELEASE_KEYS` replaces the built-in keys for a re-signing mirror.

use crate::ssh_key::{HashAlg, PublicKey, SshSig};

/// `ssh-keygen -Y sign -n <這個>`：簽章只在這個名字下有效。/ The SSHSIG namespace the signature is bound to.
pub const NAMESPACE: &str = "telepy-release";

/// 內建的發行公鑰（OpenSSH 一行格式：`ssh-ed25519 AAAA… comment`）。/ The built-in release public keys.
pub const RELEASE_KEYS: &[&str] = &[
    // 把 RELEASE_SIGNING_KEY secret 的公鑰那一行貼在這裡（`ssh-keygen -y -f <私鑰>`）；空的 = 不信任任何 release。
    // Paste the public half of the RELEASE_SIGNING_KEY secret here (`ssh-keygen -y -f <private key>`); empty = no release is trusted.
];

/// 覆寫內建公鑰的環境變數。/ The variable that replaces the built-in keys.
pub const ENV: &str = "TELEPY_RELEASE_KEYS";

/// 換行或 `;` 分隔的公鑰行（`#` 開頭是註解）；解析不了的行略過。/ Key lines separated by newlines or `;`; bad lines are skipped.
pub fn parse_keys(text: &str) -> Vec<PublicKey> {
    text.split(['\n', ';']).map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).filter_map(|l| PublicKey::from_openssh(l).ok()).collect()
}

/// 現在信任的公鑰：環境變數有設就用它，否則內建的。/ The keys in force: the variable when set, else the built-in list.
pub fn keys() -> Vec<PublicKey> {
    match std::env::var(ENV) {
        Ok(v) if !v.trim().is_empty() => parse_keys(&v),
        _ => parse_keys(&RELEASE_KEYS.join("\n")),
    }
}

/// 驗 `message` 的 SSHSIG 簽章 `signature`（PEM 文字）：命名空間要對、要是清單裡某一把簽的。回簽章用的那把的指紋。
/// Verify a message's SSHSIG signature (PEM text): the namespace must match and one of `keys` must have signed it.
/// Returns the signing key's fingerprint.
pub fn verify_with(keys: &[PublicKey], message: &[u8], signature: &str) -> Result<String, String> {
    if keys.is_empty() {
        return Err("no Telepy release key is configured, so no signature can be checked".to_string());
    }
    let sig = SshSig::from_pem(signature.trim()).map_err(|e| format!("not an OpenSSH signature: {e}"))?;
    if sig.namespace() != NAMESPACE {
        return Err(format!("the signature is for {:?}, not {NAMESPACE}", sig.namespace()));
    }
    for k in keys {
        if k.verify(NAMESPACE, message, &sig).is_ok() {
            return Ok(k.fingerprint(HashAlg::Sha256).to_string());
        }
    }
    Err("the signature matches none of the Telepy release keys".to_string())
}

/// 用現在信任的公鑰驗。/ Verify with the keys in force.
pub fn verify(message: &[u8], signature: &str) -> Result<String, String> {
    verify_with(&keys(), message, signature)
}

/// 給 doctor 看的：幾把、指紋。/ For doctor: how many keys and their fingerprints.
pub fn describe(keys: &[PublicKey]) -> String {
    if keys.is_empty() {
        return "no release key configured".to_string();
    }
    keys.iter().map(|k| format!("{} ({})", k.fingerprint(HashAlg::Sha256), k.comment())).collect::<Vec<_>>().join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一把用完即丟的測試金鑰（`ssh-keygen -t ed25519 -C test-vector`）對 `MSG` 的簽章。/ A throwaway key's signature over MSG.
    const PUB: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG/2wdGummRrInqCY3zmmteGAI+AfqDThM+SFn+QEaQz test-vector";
    const OTHER: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPMh84T98kzuoy5lgVGO8ONKwJxdNUlmbPTsXt7WnnZ8 other";
    const MSG: &[u8] = b"abc  telepy-test.tar.gz\n";
    const SIG: &str = "-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAgb/bB0a6aZGsieoJjfOaa14YAj4\nB+oNOEz5IWf5ARpDMAAAAOdGVsZXB5LXJlbGVhc2UAAAAAAAAABnNoYTUxMgAAAFMAAAAL\nc3NoLWVkMjU1MTkAAABAPq5y3XCoDnAhcBWf7Q6nmTQ5gkMBj/WpYZ2q0hPpGhoQh9u3SV\nvX6eB1BULSzNxX7H94mXTYS/jjyNS56i3XAg==\n-----END SSH SIGNATURE-----\n";

    #[test]
    fn an_ssh_keygen_signature_is_accepted_only_from_a_listed_key_over_the_same_bytes() {
        let keys = parse_keys(&format!("# comment\n{OTHER};{PUB}\n\nnot a key\n"));
        assert_eq!(keys.len(), 2);
        let fp = verify_with(&keys, MSG, SIG).unwrap();
        assert!(fp.starts_with("SHA256:"), "{fp}");
        assert_eq!(fp, parse_keys(PUB)[0].fingerprint(HashAlg::Sha256).to_string());
        assert!(verify_with(&parse_keys(OTHER), MSG, SIG).unwrap_err().contains("none of the Telepy release keys"));
        assert!(verify_with(&keys, b"abc  telepy-test.tar.gz\nextra line\n", SIG).unwrap_err().contains("none of"), "a changed message fails");
        assert!(verify_with(&[], MSG, SIG).unwrap_err().contains("no Telepy release key is configured"));
        assert!(verify_with(&keys, MSG, "garbage").unwrap_err().contains("not an OpenSSH signature"));
        assert_eq!(describe(&[]), "no release key configured");
        assert!(describe(&keys).contains("(other)") && describe(&keys).contains("(test-vector)"));
    }
}
