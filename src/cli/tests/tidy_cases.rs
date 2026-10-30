//! 網頁的 SSH config 編輯器（src/frontend/src/lib/sshConfigTidy.ts）和 `telepy config tidy` 必須給同一個結果：
//! `tidy_cases.json` 由網頁的測試產生（`UPDATE_TIDY_CASES=1 npm test`），這裡逐字比對輸出、提醒與改動種類。
//! The web's SSH config editor and `telepy config tidy` must give the same result: `tidy_cases.json` is written by
//! the web's tests, and this compares output, notes and change kinds byte for byte.

use serde_json::Value;
use telepy_cli::tidy::{tidy, Change};

#[test]
fn the_cli_simplifies_exactly_like_the_web() {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/tidy_cases.json")).unwrap();
    let cases: Vec<Value> = serde_json::from_str(&raw).unwrap();
    assert!(cases.len() > 80);
    let mut changed = 0;
    for c in &cases {
        let name = format!("{} (wildcards {})", c["name"].as_str().unwrap(), c["wildcards"]);
        let input = c["input"].as_str().unwrap();
        let r = tidy(input, c["wildcards"].as_bool().unwrap());
        assert_eq!(r.text, c["output"].as_str().unwrap(), "{name}: output differs\n--- input\n{input}");
        let notes: Vec<(String, u64)> = r.notes.iter().map(|n| (n.kind().to_string(), n.line() as u64)).collect();
        let want: Vec<(String, u64)> = c["notes"].as_array().unwrap().iter().map(|n| (n[0].as_str().unwrap().to_string(), n[1].as_u64().unwrap())).collect();
        assert_eq!(notes, want, "{name}: notes differ");
        let kinds: Vec<&str> = r
            .changes
            .iter()
            .map(|c| match c {
                Change::Duplicate { .. } => "duplicate",
                Change::Repeat { .. } => "repeat",
                Change::Shared { .. } => "shared",
                Change::Wildcard { .. } => "wildcard",
            })
            .collect();
        let want: Vec<&str> = c["changes"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
        assert_eq!(kinds, want, "{name}: changes differ");
        assert!(r.failed.is_empty(), "{name}: self-check failed");
        if r.text != input {
            changed += 1;
        }
    }
    assert!(changed > 30, "only {changed} cases changed anything");
}
