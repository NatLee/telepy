//! 純函式：OpenSSH 公鑰解析（指紋 / 演算法 / 位元數）與 `authorized_keys` 的增刪規劃。
//! Pure helpers: public-key parsing (fingerprint, algorithm, size) and `authorized_keys` edit planning.
//! 規劃只動 Telepy 管理的行；其他行（註解、空行、options、別人加的金鑰）原樣保留。

use std::collections::BTreeSet;

use russh::keys::ssh_key::{HashAlg, PublicKey};

/// 解析過的公鑰。`bare` = `"<type> <base64>"`（不含 comment），是比對與去重的唯一依據。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedKey {
    pub algorithm: String,
    /// 給人看的短名：ED25519 / RSA / ECDSA / SK-ED25519 / SK-ECDSA / DSA / KEY
    pub label: &'static str,
    pub bits: Option<u32>,
    /// `SHA256:…`（與 `ssh-keygen -lf` 和 gateway 日誌一致）。
    pub fingerprint: String,
    pub bare: String,
    pub comment: String,
}

fn label_for(algorithm: &str) -> &'static str {
    match algorithm {
        a if a.starts_with("ssh-ed25519") => "ED25519",
        a if a.starts_with("sk-ssh-ed25519") => "SK-ED25519",
        a if a.starts_with("sk-ecdsa") => "SK-ECDSA",
        a if a.starts_with("ecdsa-") => "ECDSA",
        a if a.starts_with("ssh-rsa") || a.starts_with("rsa-sha2") => "RSA",
        a if a.starts_with("ssh-dss") => "DSA",
        _ => "KEY",
    }
}

/// 解析單行 OpenSSH 公鑰（`type base64 [comment]`）。
pub fn parse_public_key(text: &str) -> Option<ParsedKey> {
    let line = text.trim();
    if line.is_empty() || line.contains('\n') {
        return None;
    }
    let mut parts = line.splitn(3, char::is_whitespace);
    let (kind, blob) = (parts.next()?, parts.next()?.trim());
    let comment = parts.next().unwrap_or("").trim().to_string();
    let key = PublicKey::from_openssh(&format!("{kind} {blob}")).ok()?;
    let algorithm = key.algorithm().to_string();
    let bits = match key.key_data() {
        russh::keys::ssh_key::public::KeyData::Rsa(rsa) => Some(rsa.key_size()),
        russh::keys::ssh_key::public::KeyData::Ecdsa(ec) => Some(match ec.curve() {
            russh::keys::ssh_key::EcdsaCurve::NistP256 => 256,
            russh::keys::ssh_key::EcdsaCurve::NistP384 => 384,
            russh::keys::ssh_key::EcdsaCurve::NistP521 => 521,
        }),
        russh::keys::ssh_key::public::KeyData::Ed25519(_) | russh::keys::ssh_key::public::KeyData::SkEd25519(_) => Some(256),
        _ => None,
    };
    Some(ParsedKey {
        label: label_for(&algorithm),
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        bare: format!("{kind} {blob}"),
        algorithm,
        bits,
        comment,
    })
}

/// 新增使用者金鑰時的強度規則：拒收 DSA 與 < 2048 位元的 RSA（OpenSSH 早已不接受）。
pub fn weak_key_reason(k: &ParsedKey) -> Option<&'static str> {
    match k.label {
        "DSA" => Some("DSA keys are not supported (OpenSSH disabled them); use an Ed25519 key."),
        "RSA" if k.bits.unwrap_or(0) < 2048 => Some("RSA keys must be at least 2048 bits; use an Ed25519 key."),
        _ => None,
    }
}

/// `authorized_keys` 的一行。`key` 為 None 表示註解、空行或無法解析。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizedLine {
    pub line_no: usize,
    pub raw: String,
    pub options: Option<String>,
    pub key: Option<ParsedKey>,
}

/// 拆出 options 欄位（可能含雙引號內的空白）。回傳 (options, 其餘)。
fn split_options(line: &str) -> (Option<&str>, &str) {
    let first = line.split_whitespace().next().unwrap_or("");
    if looks_like_key_type(first) {
        return (None, line);
    }
    let mut in_quotes = false;
    let mut escaped = false;
    for (i, c) in line.char_indices() {
        match c {
            '\\' if in_quotes && !escaped => {
                escaped = true;
                continue;
            }
            '"' if !escaped => in_quotes = !in_quotes,
            c if c.is_whitespace() && !in_quotes => return (Some(&line[..i]), line[i..].trim_start()),
            _ => {}
        }
        escaped = false;
    }
    (Some(line), "")
}

fn looks_like_key_type(t: &str) -> bool {
    t.starts_with("ssh-") || t.starts_with("ecdsa-") || t.starts_with("sk-") || t.starts_with("rsa-")
}

pub fn parse_authorized_keys(content: &str) -> Vec<AuthorizedLine> {
    content
        .lines()
        .enumerate()
        .map(|(i, raw)| {
            let trimmed = raw.trim();
            let (options, key) = if trimmed.is_empty() || trimmed.starts_with('#') {
                (None, None)
            } else {
                let (options, rest) = split_options(trimmed);
                (options.map(str::to_string), parse_public_key(rest))
            };
            AuthorizedLine { line_no: i + 1, raw: raw.to_string(), options, key }
        })
        .collect()
}

/// 要裝上的一把金鑰：`bare` + 寫進檔案的 comment。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct WantedKey {
    pub bare: String,
    pub comment: String,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan {
    /// None = 不需要改檔。
    pub content: Option<String>,
    pub added: Vec<String>,
    pub removed: Vec<String>,
    /// 已在檔案裡（不論是誰加的）的 wanted 金鑰。
    pub present: Vec<String>,
}

/// 規劃一個 OS 帳號的 `authorized_keys`：
/// - `wanted`：應該在檔案裡的金鑰（裝置金鑰清單 × 允許的帳號）；缺的附加到檔尾。
/// - `managed`：Telepy 先前裝過的金鑰；不在 `wanted` 裡的就移除（同一把金鑰的每一行都移除）。
/// - `protected`：永遠不移除（服務金鑰——移掉 Telepy 就再也連不上這個帳號）。
pub fn plan(content: &str, wanted: &[WantedKey], managed: &BTreeSet<String>, protected: &BTreeSet<String>) -> Plan {
    let wanted_bares: BTreeSet<&str> = wanted.iter().map(|w| w.bare.as_str()).collect();
    let remove: BTreeSet<&str> = managed.iter().map(String::as_str).filter(|b| !wanted_bares.contains(b) && !protected.contains(*b)).collect();
    let lines = parse_authorized_keys(content);
    let mut out = String::with_capacity(content.len() + 128);
    let mut removed = BTreeSet::new();
    let mut present = BTreeSet::new();
    for l in &lines {
        if let Some(k) = &l.key {
            if remove.contains(k.bare.as_str()) {
                removed.insert(k.bare.clone());
                continue;
            }
            if wanted_bares.contains(k.bare.as_str()) {
                present.insert(k.bare.clone());
            }
        }
        out.push_str(&l.raw);
        out.push('\n');
    }
    let mut added = Vec::new();
    for w in wanted {
        if !present.contains(&w.bare) && !added.contains(&w.bare) {
            out.push_str(&format!("{} {}\n", w.bare, w.comment));
            added.push(w.bare.clone());
        }
    }
    let changed = !added.is_empty() || !removed.is_empty();
    Plan {
        content: changed.then_some(out),
        added,
        removed: removed.into_iter().collect(),
        present: present.into_iter().collect(),
    }
}

/// 從檔案移除這些金鑰的每一行（稽核頁的「移除」；一次移除多把也只改寫一次檔案）。回傳 (新內容, 移除的行數)。
/// Removes every line of each key in `bares` in one pass. Returns (new content, lines removed).
pub fn remove_keys(content: &str, bares: &BTreeSet<String>) -> (String, usize) {
    let (out, lines) = remove_key_lines(content, bares);
    (out, lines.len())
}

/// 同 `remove_keys`，但把移掉的原始行也交回來（還原用）。/ Like `remove_keys`, also returning the raw lines removed (for undo).
pub fn remove_key_lines(content: &str, bares: &BTreeSet<String>) -> (String, Vec<String>) {
    let mut out = String::with_capacity(content.len());
    let mut removed = Vec::new();
    for l in parse_authorized_keys(content) {
        if l.key.as_ref().is_some_and(|k| bares.contains(&k.bare)) {
            removed.push(l.raw);
            continue;
        }
        out.push_str(&l.raw);
        out.push('\n');
    }
    (out, removed)
}

/// 還原的結果。/ What a restore did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Restore {
    /// None = 不需要改檔。/ None = nothing to write.
    pub content: Option<String>,
    /// 接回去的行數。/ Lines appended.
    pub restored: usize,
    /// 已經在檔案裡（同一把金鑰又出現了）而跳過的行數。/ Lines skipped because that key is back in the file.
    pub skipped: usize,
}

/// 把移掉的行接回檔尾：金鑰已經又在檔案裡的那幾行跳過（還原兩次 = 什麼都不做）；解析不了的行照原樣接回。
/// Appends removed lines; lines whose key is present again are skipped (restoring twice is a no-op).
pub fn restore_lines(content: &str, lines: &[String]) -> Restore {
    let mut present: BTreeSet<String> = parse_authorized_keys(content).into_iter().filter_map(|l| l.key.map(|k| k.bare)).collect();
    let mut out = String::with_capacity(content.len() + lines.iter().map(|l| l.len() + 1).sum::<usize>());
    out.push_str(content);
    if !content.is_empty() && !content.ends_with('\n') {
        out.push('\n');
    }
    let mut r = Restore::default();
    for raw in lines {
        let parsed = parse_authorized_keys(raw).into_iter().next().and_then(|l| l.key);
        if let Some(k) = parsed {
            if !present.insert(k.bare) {
                r.skipped += 1;
                continue;
            }
        }
        out.push_str(raw);
        out.push('\n');
        r.restored += 1;
    }
    r.content = (r.restored > 0).then_some(out);
    r
}

/// 稽核頁要移除的金鑰（依指紋挑）。/ What an audit removal will take out, picked by fingerprint.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Removal {
    /// 要移除的金鑰（bare）。/ Keys to remove.
    pub remove: BTreeSet<String>,
    /// 沒移除的指紋與原因：`not_found` / `service_key` / `in_key_list`（依請求順序）。
    /// Fingerprints left alone, with the reason, in request order.
    pub skipped: Vec<(String, &'static str)>,
}

/// 依指紋挑出要移除的金鑰：檔案裡沒有的、服務金鑰（`protected`）、在裝置清單上的（`listed`）都跳過並附原因。
/// Picks the keys to remove; absent keys, service keys and keys on the device's list are skipped with a reason.
pub fn plan_removal(content: &str, fingerprints: &[String], protected: &BTreeSet<String>, listed: &BTreeSet<String>) -> Removal {
    let by_fp: std::collections::HashMap<String, String> = parse_authorized_keys(content).into_iter().filter_map(|l| l.key).map(|k| (k.fingerprint, k.bare)).collect();
    let mut r = Removal::default();
    for fp in fingerprints {
        match by_fp.get(fp) {
            None => r.skipped.push((fp.clone(), "not_found")),
            Some(bare) if protected.contains(bare) => r.skipped.push((fp.clone(), "service_key")),
            Some(bare) if listed.contains(bare) => r.skipped.push((fp.clone(), "in_key_list")),
            Some(bare) => {
                r.remove.insert(bare.clone());
            }
        }
    }
    r
}

/// 寫進 `authorized_keys` 的 comment：`telepy:<使用者>/<金鑰名>`，空白與控制字元換成 `_`。
pub fn managed_comment(username: &str, key_name: &str) -> String {
    let clean = |s: &str| s.chars().map(|c| if c.is_whitespace() || c.is_control() { '_' } else { c }).collect::<String>();
    format!("telepy:{}/{}", clean(username), clean(key_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ED: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHAgjb8hhCbQ4/2TIVTp6pRlUi97oIezKoHrwtI5hIDU alice@laptop";
    const ED2: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC0IpUODAh6nEE6nsxVUVINtlvKLCYnrc/Xfzbp1ui1K bob";
    const SVC: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOImGUVF91v4SkbAF1fyhKvNvYOHAzaoMnVQkShaoyNY web-service";
    const RSA1024: &str = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDfJoXhbfbTVWOGa30diB5dY07RMBntvLd+q1uT8vc7qLbQhsStQ3uK6g2kj2s/fMn9J3Ayan4au4KLfcMcnWaTy+A6J/vSFogh8q3M8w/80nkQ3clT/492fRCOWb1usAmMRJsl38BgO8BfbQtY65KFxC/mPvv6zBvKMbI4Vtd6Xw== small";

    fn bare(k: &str) -> String {
        parse_public_key(k).unwrap().bare
    }

    #[test]
    fn parses_ed25519_with_fingerprint() {
        let k = parse_public_key(ED).unwrap();
        assert_eq!(k.label, "ED25519");
        assert_eq!(k.bits, Some(256));
        assert!(k.fingerprint.starts_with("SHA256:"), "{}", k.fingerprint);
        assert_eq!(k.comment, "alice@laptop");
        assert_eq!(k.bare.split(' ').count(), 2);
        assert!(weak_key_reason(&k).is_none());
    }

    #[test]
    fn flags_short_rsa() {
        let k = parse_public_key(RSA1024).unwrap();
        assert_eq!((k.label, k.bits), ("RSA", Some(1024)));
        assert!(weak_key_reason(&k).is_some());
    }

    #[test]
    fn rejects_garbage_and_multiline() {
        assert!(parse_public_key("ssh-ed25519 notbase64!!").is_none());
        assert!(parse_public_key("hello").is_none());
        assert!(parse_public_key(&format!("{ED}\n{ED2}")).is_none());
    }

    #[test]
    fn parses_options_with_quoted_spaces() {
        let content = format!("# comment\n\ncommand=\"echo hi there\",no-pty {ED}\n{ED2}\n");
        let lines = parse_authorized_keys(&content);
        assert_eq!(lines.len(), 4);
        assert!(lines[0].key.is_none() && lines[1].key.is_none());
        assert_eq!(lines[2].options.as_deref(), Some("command=\"echo hi there\",no-pty"));
        assert_eq!(lines[2].key.as_ref().unwrap().bare, bare(ED));
        assert_eq!(lines[3].options, None);
    }

    #[test]
    fn plan_appends_missing_and_keeps_everything_else() {
        let content = format!("# keep me\n{SVC}\nfrom=\"10.0.0.1\" {ED2}");
        let wanted = vec![WantedKey { bare: bare(ED), comment: "telepy:alice/laptop".into() }];
        let p = plan(&content, &wanted, &BTreeSet::new(), &BTreeSet::new());
        let c = p.content.unwrap();
        assert!(c.starts_with(&format!("# keep me\n{SVC}\nfrom=\"10.0.0.1\" {ED2}\n")), "{c}");
        assert!(c.ends_with(&format!("{} telepy:alice/laptop\n", bare(ED))));
        assert_eq!(p.added, vec![bare(ED)]);
    }

    #[test]
    fn plan_is_noop_when_already_present() {
        let wanted = vec![WantedKey { bare: bare(ED), comment: "x".into() }];
        let p = plan(&format!("{ED}\n"), &wanted, &BTreeSet::from([bare(ED)]), &BTreeSet::new());
        assert_eq!(p.content, None);
        assert_eq!(p.present, vec![bare(ED)]);
    }

    #[test]
    fn plan_removes_only_managed_keys_never_protected() {
        let content = format!("{SVC}\n{ED}\nno-pty {ED}\n{ED2}\n");
        let managed = BTreeSet::from([bare(ED), bare(SVC)]);
        let p = plan(&content, &[], &managed, &BTreeSet::from([bare(SVC)]));
        assert_eq!(p.content.unwrap(), format!("{SVC}\n{ED2}\n"));
        assert_eq!(p.removed, vec![bare(ED)]);
    }

    #[test]
    fn remove_key_drops_every_line_of_that_key() {
        let (c, n) = remove_keys(&format!("{ED}\n{ED2}\nno-pty {ED}"), &BTreeSet::from([bare(ED)]));
        assert_eq!(n, 2);
        assert_eq!(c, format!("{ED2}\n"));
    }

    #[test]
    fn remove_keys_rewrites_once_and_keeps_the_rest() {
        let content = format!("# mine\n{ED}\n{SVC}\nno-pty {ED2}\n{ED}\n");
        let (c, n) = remove_keys(&content, &BTreeSet::from([bare(ED), bare(ED2)]));
        assert_eq!(n, 3);
        assert_eq!(c, format!("# mine\n{SVC}\n"));
    }

    #[test]
    fn restore_appends_removed_lines_once() {
        let content = format!("{SVC}\n{ED}\nno-pty {ED2}\n");
        let (rest, removed) = remove_key_lines(&content, &BTreeSet::from([bare(ED), bare(ED2)]));
        assert_eq!(rest, format!("{SVC}\n"));
        assert_eq!(removed, vec![ED.to_string(), format!("no-pty {ED2}")]);
        let r = restore_lines(&rest, &removed);
        assert_eq!((r.restored, r.skipped), (2, 0));
        let back = r.content.unwrap();
        assert_eq!(back, content);
        // 再還原一次：金鑰都在了，什麼都不做。/ Restoring again is a no-op.
        let again = restore_lines(&back, &removed);
        assert_eq!((again.restored, again.skipped, again.content), (0, 2, None));
        // 檔尾沒有換行也接得對。/ A file without a trailing newline is handled.
        let r = restore_lines(SVC, &[ED.to_string()]);
        assert_eq!(r.content.unwrap(), format!("{SVC}\n{ED}\n"));
    }

    #[test]
    fn plan_removal_skips_service_listed_and_missing_keys() {
        let content = format!("{ED}\n{ED2}\n{SVC}\n{RSA1024}\n");
        let fp = |k: &str| parse_public_key(k).unwrap().fingerprint;
        let fps = vec![fp(ED), fp(SVC), fp(ED2), "SHA256:nope".to_string(), fp(RSA1024)];
        let r = plan_removal(&content, &fps, &BTreeSet::from([bare(SVC)]), &BTreeSet::from([bare(ED2)]));
        assert_eq!(r.remove, BTreeSet::from([bare(ED), bare(RSA1024)]));
        assert_eq!(r.skipped, vec![(fp(SVC), "service_key"), (fp(ED2), "in_key_list"), ("SHA256:nope".to_string(), "not_found")]);
    }

    #[test]
    fn managed_comment_has_no_whitespace() {
        assert_eq!(managed_comment("ann lee", "my\tkey"), "telepy:ann_lee/my_key");
    }
}
