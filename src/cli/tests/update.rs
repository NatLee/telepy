//! `telepy update` 對著一個假的發行版伺服器（`TELEPY_RELEASES_URL`）：`--check` 說有新版；雜湊對不上 → 什麼都沒換；
//! 新的 binary 跑不起來 → 換回原本的；正常的 → 換成新版、不留備份檔。編好的 `telepy` 複製到暫存目錄再跑，不碰真的安裝。
//! `telepy update` against a fake release server (`TELEPY_RELEASES_URL`): `--check` reports the newer release; a
//! checksum mismatch changes nothing; a new binary that doesn't start is rolled back; a good one replaces it and
//! leaves no backup behind. The built `telepy` is copied to a temp dir first, never touching a real install.
#![cfg(unix)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;

use telepy_cli::update::{archive_name, sha256_hex, target};

const TAG: &str = "v99.0.0";

/// 一個只會發這幾個檔的發行版伺服器；回 base URL（`…/releases`）。/ A release server for these files; returns its base.
fn serve(files: HashMap<String, Vec<u8>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut stream = stream;
            let mut line = String::new();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            reader.read_line(&mut line).unwrap_or(0);
            loop {
                let mut h = String::new();
                if reader.read_line(&mut h).unwrap_or(0) == 0 || h.trim().is_empty() {
                    break;
                }
            }
            let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
            let reply = if path == "/releases/latest" {
                // 跟 GitHub 一樣：轉址到那個 tag 的頁面。/ Like GitHub: a redirect to the tag's page.
                format!("HTTP/1.1 302 Found\r\nlocation: /releases/tag/{TAG}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").into_bytes()
            } else if let Some(body) = path.strip_prefix(&format!("/releases/download/{TAG}/")).and_then(|f| files.get(f)) {
                let mut r = format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len()).into_bytes();
                r.extend_from_slice(body);
                r
            } else {
                b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_vec()
            };
            let _ = stream.write_all(&reply);
        }
    });
    format!("http://127.0.0.1:{port}/releases")
}

/// 跟發行一樣打包：`telepy` + LICENSE。/ Packed like a release: `telepy` plus LICENSE.
fn archive(binary: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let gz = flate2::write::GzEncoder::new(&mut out, flate2::Compression::default());
        let mut b = tar::Builder::new(gz);
        for (name, data, mode) in [("telepy", binary, 0o755), ("LICENSE", &b"AGPL"[..], 0o644)] {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(mode);
            h.set_cksum();
            b.append_data(&mut h, name, data).unwrap();
        }
        b.into_inner().unwrap().finish().unwrap();
    }
    out
}

/// 發行版的檔案：archive + SHA256SUMS（`good_sum` = 雜湊是否正確）。/ The release files, with a right or wrong checksum.
fn release(binary: &[u8], good_sum: bool) -> HashMap<String, Vec<u8>> {
    let name = archive_name(target().expect("a release target for this platform"));
    let bytes = archive(binary);
    let hash = if good_sum { sha256_hex(&bytes) } else { "0".repeat(64) };
    HashMap::from([(name.clone(), bytes), ("SHA256SUMS".to_string(), format!("{hash}  {name}\n").into_bytes())])
}

/// 把編好的 telepy 複製到自己的目錄。/ A private copy of the built telepy.
fn install(dir: &Path) -> PathBuf {
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let exe = bin.join("telepy");
    std::fs::copy(env!("CARGO_BIN_EXE_telepy"), &exe).unwrap();
    exe
}

fn telepy(exe: &Path, home: &Path, releases: &str, args: &[&str]) -> (bool, String, String) {
    let out = Command::new(exe)
        .args(args)
        .env("HOME", home)
        .env("TELEPY_CONFIG_DIR", home.join("config"))
        .env("TELEPY_RELEASES_URL", releases)
        .env("TELEPY_NO_KEYRING", "1")
        .output()
        .unwrap();
    (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

fn version(exe: &Path) -> String {
    String::from_utf8_lossy(&Command::new(exe).arg("--version").output().unwrap().stdout).trim().to_string()
}

fn leftovers(exe: &Path) -> Vec<String> {
    std::fs::read_dir(exe.parent().unwrap()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n != "telepy").collect()
}

#[test]
fn update_checks_verifies_rolls_back_and_replaces() {
    let tmp = tempfile::tempdir().unwrap();
    let exe = install(tmp.path());
    let before = version(&exe);
    assert!(before.starts_with("telepy "), "{before}");

    // 雜湊對不上：拒絕，什麼都沒換。/ A wrong checksum: refused, nothing changed.
    let bad_sum = serve(release(b"#!/bin/sh\necho 'telepy 99.0.0'\n", false));
    let (ok, out, err) = telepy(&exe, tmp.path(), &bad_sum, &["update", "--check"]);
    assert!(ok, "{err}");
    assert!(out.contains("telepy 99.0.0 is out"), "{out}");
    let (ok, _, err) = telepy(&exe, tmp.path(), &bad_sum, &["update"]);
    assert!(!ok && err.contains("doesn't match its checksum"), "{err}");
    assert_eq!(version(&exe), before);
    assert_eq!(leftovers(&exe), Vec::<String>::new());

    // 新的 binary 跑不起來：換回原本的。/ A new binary that doesn't start: the old one comes back.
    let broken = serve(release(b"#!/bin/sh\nexit 3\n", true));
    let (ok, _, err) = telepy(&exe, tmp.path(), &broken, &["update"]);
    assert!(!ok && err.contains("didn't start"), "{err}");
    assert_eq!(version(&exe), before, "rolled back");
    assert_eq!(leftovers(&exe), Vec::<String>::new());

    // 正常的：換上新版，不留備份。/ A good one: replaced, no backup left behind.
    let good = serve(release(b"#!/bin/sh\necho 'telepy 99.0.0'\n", true));
    let (ok, out, err) = telepy(&exe, tmp.path(), &good, &["update"]);
    assert!(ok, "{err}");
    assert!(out.contains("to 99.0.0 (telepy 99.0.0)"), "{out}");
    assert_eq!(version(&exe), "telepy 99.0.0");
    assert_eq!(leftovers(&exe), Vec::<String>::new());
    // 記下最新的版本（一天一次的檢查用）。/ The latest version is remembered for the daily check.
    let cache = std::fs::read_to_string(tmp.path().join("config/update-check.json")).unwrap();
    assert!(cache.contains("v99.0.0"), "{cache}");
}

#[test]
fn update_refuses_a_version_that_isnt_one() {
    let tmp = tempfile::tempdir().unwrap();
    let exe = install(tmp.path());
    let (ok, _, err) = telepy(&exe, tmp.path(), "http://127.0.0.1:9/releases", &["update", "--to", "latest-and-greatest"]);
    assert!(!ok && err.contains("is not a version"), "{err}");
}
