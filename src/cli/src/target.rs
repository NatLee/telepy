//! 指令列上的目標：`<tunnel>[@account]`、`<tunnel>[@account]:<path>`（cp / scp）。純函式。
//! Targets on the command line: `<tunnel>[@account]` and `<tunnel>[@account]:<path>` (cp / scp). Pure.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub tunnel: String,
    pub account: Option<String>,
}

/// 可能的讀法，依序試：整串是隧道名稱 → `<tunnel>@<account>` → `<account>@<tunnel>`（ssh 的習慣）。
/// 呼叫端拿第一個對得到隧道的。/ Possible readings, in order; the caller takes the first that names a tunnel.
pub fn candidates(raw: &str) -> Vec<Target> {
    let mut out = vec![Target { tunnel: raw.to_string(), account: None }];
    if let Some((left, right)) = raw.split_once('@') {
        if !left.is_empty() && !right.is_empty() {
            out.push(Target { tunnel: left.to_string(), account: Some(right.to_string()) });
            out.push(Target { tunnel: right.to_string(), account: Some(left.to_string()) });
        }
    }
    out
}

/// 不查隧道清單時的讀法：`<tunnel>@<account>`。/ The reading without the tunnel list: `<tunnel>@<account>`.
pub fn parse_target(raw: &str) -> Target {
    candidates(raw).into_iter().nth(1).unwrap_or_else(|| Target { tunnel: raw.to_string(), account: None })
}

/// `box@pi:/etc/hosts` → (`box@pi`, path)；本機路徑（沒有冒號、`./x`、`/x`、Windows 的 `C:\x`）→ None。
/// A remote spec → (the target text, path); a local path → None.
pub fn parse_remote(raw: &str) -> Option<(String, String)> {
    if raw.starts_with('.') || raw.starts_with('/') || raw.starts_with('~') {
        return None;
    }
    let (host, path) = raw.split_once(':')?;
    // `C:\x`、`C:/x`：一個字母的磁碟機代號。/ A Windows drive letter.
    if host.len() == 1 && host.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), path.to_string()))
}

/// `--label env=prod` 對隧道標籤：`k` 對 `k` 或 `k=任何值`，`k=v` 要完全一樣。/ Label filter matching.
pub fn label_matches(labels: &[String], want: &str) -> bool {
    labels.iter().any(|l| l == want || (!want.contains('=') && l.split_once('=').is_some_and(|(k, _)| k == want)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets() {
        assert_eq!(parse_target("box"), Target { tunnel: "box".into(), account: None });
        assert_eq!(parse_target("box@pi"), Target { tunnel: "box".into(), account: Some("pi".into()) });
        let c = candidates("pi@box");
        assert_eq!(c.len(), 3);
        assert_eq!(c[2], Target { tunnel: "box".into(), account: Some("pi".into()) });
        assert_eq!(parse_target("@box"), Target { tunnel: "@box".into(), account: None });
        assert_eq!(parse_remote("box@pi:/etc/hosts"), Some(("box@pi".to_string(), "/etc/hosts".into())));
        assert_eq!(parse_remote("box:notes.txt"), Some(("box".to_string(), "notes.txt".into())));
        assert_eq!(parse_remote("./box:x"), None);
        assert_eq!(parse_remote("C:\\temp\\x"), None);
        assert_eq!(parse_remote("file.txt"), None);
    }

    #[test]
    fn labels() {
        let l = vec!["env=prod".to_string(), "edge".to_string()];
        assert!(label_matches(&l, "env=prod"));
        assert!(label_matches(&l, "env"));
        assert!(label_matches(&l, "edge"));
        assert!(!label_matches(&l, "env=dev"));
    }
}
