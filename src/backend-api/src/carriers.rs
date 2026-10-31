//! 裝置端載體 `telepy-carrier` 的快取：各平台的靜態 binary 從 GitHub release 拿（`TELEPY_RELEASES_URL` 可換鏡像），放在
//! `CARRIER_DIR`（預設 `<DATA_DIR>/carriers`），`GET /api/join/carrier/<target>` 給裝置下載。裝置常常只連得到 Telepy、連不到
//! GitHub，所以由伺服器代拿；第一次有裝置要才抓（之後都從快取），`telepy-server fetch-carriers` 可以先抓齊（離線的伺服器
//! 也可以手動把檔案放進去）。每個 release 的 `SHA256SUMS` 先驗過才存；抓失敗記 10 分鐘，不會每個裝置都去撞 GitHub。
//! 平台對照（`uname -s` / `uname -m` → target）與 `.github/workflows/release-cli.yml` 的矩陣、`join_install.sh` 的
//! `carrier_target` 一致。
//!
//! The cache of the device-side carrier (`telepy-carrier`): static binaries per platform, fetched from the GitHub
//! release (`TELEPY_RELEASES_URL` = a mirror) into `CARRIER_DIR` and served at `GET /api/join/carrier/<target>`.
//! Devices often reach Telepy but not GitHub, so the server fetches on the first request (then from the cache);
//! `telepy-server fetch-carriers` prefetches, and an offline server can be filled by hand. Every archive is checked
//! against the release's `SHA256SUMS` first; a failed fetch is remembered for 10 minutes.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use sha2::Digest;

use crate::config::Config;

pub const RELEASES: &str = "https://github.com/NatLee/telepy/releases";
/// 抓失敗後多久不再試。/ How long a failed fetch is remembered.
pub const RETRY_AFTER: Duration = Duration::from_secs(600);
const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
/// 一個載體最大多少（解開後）。/ The largest binary accepted.
const MAX_BINARY: usize = 32 * 1024 * 1024;

/// 一個有預編 binary 的平台。/ A platform with a prebuilt binary.
pub struct Target {
    /// Rust 的 target triple，也是發行檔名的一部分。/ The Rust target triple (part of the archive name).
    pub name: &'static str,
    /// `uname -s`（小寫）。/ `uname -s`, lower-cased.
    pub os: &'static str,
    /// `uname -m` 的寫法。/ Spellings of `uname -m`.
    pub machines: &'static [&'static str],
}

/// 跟 release 工作流程的矩陣一樣（測試 `targets_match_the_release_workflow`）。/ The release workflow's matrix.
pub const TARGETS: &[Target] = &[
    Target { name: "x86_64-unknown-linux-musl", os: "linux", machines: &["x86_64", "amd64"] },
    Target { name: "aarch64-unknown-linux-musl", os: "linux", machines: &["aarch64", "arm64"] },
    Target { name: "armv7-unknown-linux-musleabihf", os: "linux", machines: &["armv7l", "armv7", "armv8l"] },
    Target { name: "arm-unknown-linux-musleabihf", os: "linux", machines: &["armv6l", "armv6"] },
    Target { name: "x86_64-apple-darwin", os: "darwin", machines: &["x86_64"] },
    Target { name: "aarch64-apple-darwin", os: "darwin", machines: &["arm64", "aarch64"] },
    Target { name: "x86_64-pc-windows-msvc", os: "windows", machines: &["x86_64", "amd64"] },
];

/// `uname -s` / `uname -m` → target；沒有預編的（MIPS 路由器…）= None。/ The target for a device; None = no prebuilt binary.
pub fn target_for(os: &str, machine: &str) -> Option<&'static str> {
    let os = os.trim().to_ascii_lowercase();
    let os = if os.starts_with("windows") || os.starts_with("msys") || os.starts_with("mingw") || os.starts_with("cygwin") { "windows" } else { os.as_str() };
    let m = machine.trim().to_ascii_lowercase();
    TARGETS.iter().find(|t| t.os == os && t.machines.contains(&m.as_str())).map(|t| t.name)
}

pub fn is_target(name: &str) -> bool {
    TARGETS.iter().any(|t| t.name == name)
}

/// `telepy-carrier-<target>.tar.gz`（Windows `.zip`）。/ The archive name on the release.
pub fn archive_name(target: &str) -> String {
    if target.contains("windows") {
        format!("telepy-carrier-{target}.zip")
    } else {
        format!("telepy-carrier-{target}.tar.gz")
    }
}

pub fn binary_name(target: &str) -> &'static str {
    if target.contains("windows") {
        "telepy-carrier.exe"
    } else {
        "telepy-carrier"
    }
}

/// `SHA256SUMS`（`<hex>  <檔名>`，`*<檔名>` 也行）裡某個檔的雜湊。/ One file's hash from `SHA256SUMS`.
pub fn sum_for(sums: &str, file: &str) -> Option<String> {
    sums.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        let hash = it.next()?;
        let name = it.next()?.trim_start_matches('*');
        (name == file && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())).then(|| hash.to_ascii_lowercase())
    })
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// `…/releases/tag/v2.9.0` → `v2.9.0`（GitHub 的 `/releases/latest` 轉址到這裡）。/ The tag `/releases/latest` redirects to.
pub fn tag_from_location(location: &str) -> Option<String> {
    let path = location.split(['?', '#']).next()?;
    let (_, tag) = path.rsplit_once("/tag/")?;
    let tag = urlencoding::decode(tag.trim_end_matches('/')).ok()?.into_owned();
    (!tag.is_empty() && !tag.contains('/')).then_some(tag)
}

/// 從發行檔裡拿出 `telepy-carrier`（Windows `.exe`）。/ Take the binary out of a release archive.
pub fn extract_binary(archive: &[u8], archive_name: &str) -> Result<Vec<u8>> {
    let wanted = |name: &str| {
        let base = name.trim_start_matches("./").rsplit('/').next().unwrap_or(name).to_string();
        base == "telepy-carrier" || base == "telepy-carrier.exe"
    };
    if archive_name.ends_with(".zip") {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive)).context("read the zip archive")?;
        for i in 0..zip.len() {
            let entry = zip.by_index(i)?;
            if entry.is_file() && wanted(entry.name()) {
                let mut out = Vec::new();
                entry.take(MAX_BINARY as u64 + 1).read_to_end(&mut out)?;
                return Ok(out);
            }
        }
    } else {
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive));
        for entry in tar.entries().context("read the tar.gz archive")? {
            let entry = entry?;
            let name = entry.path()?.to_string_lossy().into_owned();
            if entry.header().entry_type().is_file() && wanted(&name) {
                let mut out = Vec::new();
                entry.take(MAX_BINARY as u64 + 1).read_to_end(&mut out)?;
                return Ok(out);
            }
        }
    }
    bail!("{archive_name} has no telepy-carrier in it")
}

/// 快取裡的一個載體。/ One cached carrier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cached {
    pub path: PathBuf,
    pub sha256: String,
    pub size: u64,
    /// 哪個 release（抓的時候記的；手動放進去的沒有）。/ Which release it came from (none when placed by hand).
    pub version: Option<String>,
}

pub struct Carriers {
    dir: PathBuf,
    releases: String,
    /// 這個後端的發行版號（`TELEPY_VERSION`）：先拿同版的載體，沒有再拿最新的。/ This build's version: the same release first.
    version: Option<String>,
    http: reqwest::Client,
    no_redirect: reqwest::Client,
    /// 每個 target 一把鎖：同時來的請求只抓一次。/ One fetch per target at a time.
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// 最近失敗的（什麼時候、為什麼）。/ Recent failures (when, why).
    failures: Mutex<HashMap<String, (Instant, String)>>,
}

impl Carriers {
    pub fn new(config: &Config, http: reqwest::Client) -> Self {
        let no_redirect = reqwest::Client::builder().timeout(Duration::from_secs(20)).redirect(reqwest::redirect::Policy::none()).user_agent("telepy-server").build().expect("reqwest client");
        Self {
            dir: config.carrier_dir.clone(),
            releases: config.releases_url.clone(),
            version: option_env!("TELEPY_VERSION").map(str::to_string),
            http,
            no_redirect,
            locks: Mutex::new(HashMap::new()),
            failures: Mutex::new(HashMap::new()),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn releases(&self) -> &str {
        &self.releases
    }

    fn binary_path(&self, target: &str) -> PathBuf {
        self.dir.join(target).join(binary_name(target))
    }

    /// 快取裡有的話（binary + 旁邊的 `sha256`；手動放的沒有 sha256 檔就現算）。/ From the cache, if there.
    pub fn cached(&self, target: &str) -> Option<Cached> {
        let path = self.binary_path(target);
        let meta = std::fs::metadata(&path).ok()?;
        if !meta.is_file() || meta.len() == 0 {
            return None;
        }
        let sums = std::fs::read_to_string(self.dir.join(target).join("sha256")).ok();
        let (sha256, version) = match sums.as_deref().map(|s| s.split_whitespace().map(str::to_string).collect::<Vec<_>>()) {
            Some(parts) if parts.first().is_some_and(|h| h.len() == 64) => (parts[0].clone(), parts.get(1).cloned()),
            _ => (sha256_hex(&std::fs::read(&path).ok()?), None),
        };
        Some(Cached { path, sha256, size: meta.len(), version })
    }

    pub fn cached_targets(&self) -> Vec<&'static str> {
        TARGETS.iter().map(|t| t.name).filter(|t| self.cached(t).is_some()).collect()
    }

    /// 快取裡的，不然就去抓。/ The cached binary, else fetched.
    pub async fn get(&self, target: &str) -> Result<Cached> {
        if !is_target(target) {
            bail!("no carrier is built for {target}");
        }
        if let Some(c) = self.cached(target) {
            return Ok(c);
        }
        if let Some((at, why)) = self.failures.lock().unwrap().get(target).cloned() {
            if at.elapsed() < RETRY_AFTER {
                bail!("{why} (not retried for {} min)", RETRY_AFTER.as_secs() / 60);
            }
        }
        let lock = self.locks.lock().unwrap().entry(target.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone();
        let _held = lock.lock().await;
        if let Some(c) = self.cached(target) {
            return Ok(c);
        }
        match self.fetch(target).await {
            Ok(c) => {
                self.failures.lock().unwrap().remove(target);
                Ok(c)
            }
            Err(e) => {
                let why = format!("cannot fetch the carrier for {target} from {}: {e:#}", self.releases);
                self.failures.lock().unwrap().insert(target.to_string(), (Instant::now(), why.clone()));
                bail!("{why}")
            }
        }
    }

    /// 最新發行版的 tag（`<releases>/latest` 轉址到 `…/tag/<tag>`；不用 GitHub API，沒有次數限制）。
    /// The latest release tag from the `/latest` redirect (no GitHub API, so no rate limit).
    pub async fn latest_tag(&self) -> Result<String> {
        let url = format!("{}/latest", self.releases);
        let r = self.no_redirect.get(&url).send().await.with_context(|| format!("GET {url}"))?;
        let loc = r.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).ok_or_else(|| anyhow::anyhow!("{url} did not redirect to a release"))?;
        tag_from_location(loc).ok_or_else(|| anyhow::anyhow!("{url} redirected somewhere unexpected: {loc}"))
    }

    async fn download(&self, url: &str) -> Result<Vec<u8>> {
        let r = self.http.get(url).timeout(FETCH_TIMEOUT).send().await.with_context(|| format!("GET {url}"))?;
        if !r.status().is_success() {
            bail!("{url}: HTTP {}", r.status());
        }
        Ok(r.bytes().await.with_context(|| format!("reading {url}"))?.to_vec())
    }

    /// 先試同版的 release（有 `TELEPY_VERSION` 時），沒有就最新的。/ The same release first (stamped builds), else the latest.
    async fn fetch(&self, target: &str) -> Result<Cached> {
        let mut tags: Vec<String> = Vec::new();
        if let Some(v) = &self.version {
            tags.push(format!("v{}", v.trim_start_matches('v')));
        }
        match self.latest_tag().await {
            Ok(t) => {
                if !tags.contains(&t) {
                    tags.push(t);
                }
            }
            Err(e) => {
                if tags.is_empty() {
                    return Err(e);
                }
            }
        }
        let mut errors = Vec::new();
        for tag in tags {
            match self.fetch_tag(target, &tag).await {
                Ok(c) => return Ok(c),
                Err(e) => errors.push(format!("{tag}: {e:#}")),
            }
        }
        bail!("{}", errors.join("; "))
    }

    async fn fetch_tag(&self, target: &str, tag: &str) -> Result<Cached> {
        let base = format!("{}/download/{tag}", self.releases);
        let name = archive_name(target);
        let sums = self.download(&format!("{base}/SHA256SUMS")).await.context("the release has no SHA256SUMS")?;
        let want = sum_for(&String::from_utf8_lossy(&sums), &name).ok_or_else(|| anyhow::anyhow!("SHA256SUMS lists no {name} (the release carries no carrier for {target})"))?;
        let archive = self.download(&format!("{base}/{name}")).await?;
        let got = sha256_hex(&archive);
        if got != want {
            bail!("{name} does not match SHA256SUMS ({got} ≠ {want})");
        }
        let bin = tokio::task::spawn_blocking(move || extract_binary(&archive, &name)).await.context("join")??;
        if bin.len() > MAX_BINARY {
            bail!("the carrier in the archive is larger than {} MB", MAX_BINARY / 1024 / 1024);
        }
        let sha = sha256_hex(&bin);
        let dir = self.dir.join(target);
        std::fs::create_dir_all(&dir).with_context(|| format!("cannot create {}", dir.display()))?;
        let path = self.binary_path(target);
        let tmp = dir.join(".telepy-carrier.tmp");
        std::fs::write(&tmp, &bin).with_context(|| format!("cannot write {}", tmp.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
        }
        std::fs::rename(&tmp, &path).with_context(|| format!("cannot move {} into place", tmp.display()))?;
        std::fs::write(dir.join("sha256"), format!("{sha} {tag}\n")).with_context(|| "cannot write the checksum file")?;
        tracing::info!(target, tag, size = bin.len(), "device carrier fetched");
        Ok(Cached { path, sha256: sha, size: bin.len() as u64, version: Some(tag.to_string()) })
    }

    /// 全部抓齊（`telepy-server fetch-carriers`）。/ Fetch every target.
    pub async fn prefetch(&self) -> Vec<(&'static str, Result<Cached>)> {
        let mut out = Vec::new();
        for t in TARGETS {
            self.failures.lock().unwrap().remove(t.name);
            out.push((t.name, self.get(t.name).await));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_map_to_targets_by_uname() {
        assert_eq!(target_for("Linux", "x86_64"), Some("x86_64-unknown-linux-musl"));
        assert_eq!(target_for("Linux", "aarch64"), Some("aarch64-unknown-linux-musl"));
        assert_eq!(target_for("Linux", "armv7l"), Some("armv7-unknown-linux-musleabihf"));
        assert_eq!(target_for("Linux", "armv6l"), Some("arm-unknown-linux-musleabihf"));
        assert_eq!(target_for("Darwin", "arm64"), Some("aarch64-apple-darwin"));
        assert_eq!(target_for("Darwin", "x86_64"), Some("x86_64-apple-darwin"));
        assert_eq!(target_for("MINGW64_NT-10.0", "x86_64"), Some("x86_64-pc-windows-msvc"));
        assert_eq!(target_for("Linux", "mips"), None, "MIPS routers have no prebuilt carrier");
        assert_eq!(target_for("FreeBSD", "amd64"), None);
        assert!(is_target("x86_64-unknown-linux-musl") && !is_target("x86_64-unknown-linux-gnu"));
        assert_eq!(archive_name("x86_64-pc-windows-msvc"), "telepy-carrier-x86_64-pc-windows-msvc.zip");
        assert_eq!(archive_name("aarch64-apple-darwin"), "telepy-carrier-aarch64-apple-darwin.tar.gz");
        assert_eq!(binary_name("x86_64-pc-windows-msvc"), "telepy-carrier.exe");
    }

    /// 平台表跟 release 工作流程的矩陣一致。/ The table matches the release workflow's matrix.
    #[test]
    fn targets_match_the_release_workflow() {
        let wf = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.github/workflows/release-cli.yml")).unwrap();
        for t in TARGETS {
            assert!(wf.contains(&format!("target: {}", t.name)), "{} is not in release-cli.yml", t.name);
        }
    }

    #[test]
    fn sums_tags_and_archives() {
        let sums = "abc  telepy-x.tar.gz\n0123456789abcdef0123456789abcdef0123456789abcdef0123456789ABCDEF *telepy-carrier-x86_64-unknown-linux-musl.tar.gz\n";
        assert_eq!(sum_for(sums, "telepy-carrier-x86_64-unknown-linux-musl.tar.gz").as_deref(), Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"));
        assert_eq!(sum_for(sums, "telepy-x.tar.gz"), None, "a short hash is not a hash");
        assert_eq!(tag_from_location("https://github.com/NatLee/telepy/releases/tag/v2.11.0").as_deref(), Some("v2.11.0"));
        assert_eq!(tag_from_location("https://github.com/NatLee/telepy/releases"), None);
        // tar.gz 與 zip 都解得出來。/ Both archive kinds.
        let mut tar_bytes = Vec::new();
        {
            let enc = flate2::write::GzEncoder::new(&mut tar_bytes, flate2::Compression::fast());
            let mut b = tar::Builder::new(enc);
            let data = b"#!/bin/sh\necho carrier\n";
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o755);
            h.set_cksum();
            b.append_data(&mut h, "telepy-carrier", &data[..]).unwrap();
            let mut h2 = tar::Header::new_gnu();
            h2.set_size(1);
            h2.set_cksum();
            b.append_data(&mut h2, "LICENSE", &b"x"[..]).unwrap();
            b.into_inner().unwrap().finish().unwrap();
        }
        assert_eq!(extract_binary(&tar_bytes, "telepy-carrier-x.tar.gz").unwrap(), b"#!/bin/sh\necho carrier\n");
        let mut zip_bytes = std::io::Cursor::new(Vec::new());
        {
            use std::io::Write;
            let mut z = zip::ZipWriter::new(&mut zip_bytes);
            z.start_file("telepy-carrier.exe", zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(b"MZ").unwrap();
            z.finish().unwrap();
        }
        assert_eq!(extract_binary(zip_bytes.get_ref(), "telepy-carrier-w.zip").unwrap(), b"MZ");
        assert!(extract_binary(b"junk", "telepy-carrier-x.tar.gz").is_err());
    }

    #[tokio::test]
    async fn the_cache_serves_files_placed_by_hand_and_refuses_unknown_targets() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::from_env();
        config.carrier_dir = dir.path().join("carriers");
        config.releases_url = "http://127.0.0.1:9/releases".into(); // 沒人聽：抓一定失敗。/ Nobody listens: a fetch always fails.
        let c = Carriers::new(&config, reqwest::Client::new());
        assert!(c.cached_targets().is_empty());
        let t = "aarch64-unknown-linux-musl";
        std::fs::create_dir_all(config.carrier_dir.join(t)).unwrap();
        std::fs::write(config.carrier_dir.join(t).join("telepy-carrier"), b"bin").unwrap();
        let got = c.get(t).await.unwrap();
        assert_eq!((got.size, got.version.as_deref(), got.sha256.as_str()), (3, None, sha256_hex(b"bin").as_str()));
        assert_eq!(c.cached_targets(), vec![t]);
        assert!(c.get("mips-unknown-linux-musl").await.unwrap_err().to_string().contains("no carrier is built"));
        // 抓不到：記下來，第二次馬上回同一個錯。/ A failed fetch is remembered.
        let e1 = c.get("x86_64-unknown-linux-musl").await.unwrap_err().to_string();
        assert!(e1.contains("cannot fetch the carrier"), "{e1}");
        let e2 = c.get("x86_64-unknown-linux-musl").await.unwrap_err().to_string();
        assert!(e2.contains("not retried for 10 min"), "{e2}");
    }
}
