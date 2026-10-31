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
//!
//! 保持最新：網站設定 `carrier_auto_update`（預設開）時，背景每天最多問一次 release 頁的最新 tag，快取裡從 release 抓來、
//! 版本比較舊的就在背景換新（換好之前照樣給舊的）；手動放進去的（沒有版本）不動。換了、或換失敗，寫一筆稽核事件，
//! 通知每個管理員（站內提示 + 全站 webhook `carriers.updated` / `carriers.update_failed`；同一個錯誤只說一次）。
//! 伺服器健康頁的載體面板（`api/carriers.rs`）可以立即檢查、全部更新；`telepy-server fetch-carriers` 一律抓最新。
//! Staying current: with the site setting `carrier_auto_update` (on by default) a background task asks the release
//! page for the latest tag at most once a day and replaces cached carriers that came from an older release (the old
//! one is served until the new one is in place); hand-placed ones (no version) are left alone. An update, or a failed
//! one, writes an audit event and tells every admin (in-app notice + the site-wide webhooks `carriers.updated` /
//! `carriers.update_failed`; the same error is announced once). The Server health page's carriers panel
//! (`api/carriers.rs`) checks now and updates everything; `telepy-server fetch-carriers` always fetches the latest.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::Digest;

use crate::config::Config;
use crate::state::AppState;

pub const RELEASES: &str = "https://github.com/NatLee/telepy/releases";
/// 抓失敗後多久不再試。/ How long a failed fetch is remembered.
pub const RETRY_AFTER: Duration = Duration::from_secs(600);
const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
/// 一個載體最大多少（解開後）。/ The largest binary accepted.
const MAX_BINARY: usize = 32 * 1024 * 1024;
/// 自動更新多久問一次最新版。/ How often the automatic update asks for the latest release.
pub const CHECK_EVERY: Duration = Duration::from_secs(24 * 3600);
/// 背景迴圈多久醒一次（到期才真的去問）。/ How often the background loop wakes (it only asks when due).
const LOOP_EVERY: Duration = Duration::from_secs(3600);
/// 啟動後等多久才第一次看（不拖慢啟動）。/ The first look waits this long after start.
const FIRST_LOOK_AFTER: Duration = Duration::from_secs(120);

/// `v2.12.0` → (2, 12, 0)；`-rc.1` 之類的尾巴不看；看不懂 = None。/ A release tag as numbers; unparsable = None.
pub fn parse_version(tag: &str) -> Option<(u64, u64, u64)> {
    let core = tag.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut it = core.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    let patch = it.next().unwrap_or("0").parse().ok()?;
    it.next().is_none().then_some((major, minor, patch))
}

/// `latest` 比 `current` 新（看不懂的一律不算新）。/ Whether `latest` is newer (unparsable = no).
pub fn newer(latest: &str, current: &str) -> bool {
    matches!((parse_version(latest), parse_version(current)), (Some(l), Some(c)) if l > c)
}

/// 自動更新要換哪些：從 release 抓來（有版本）、比 `latest` 舊的。手動放的（沒有版本）不動。
/// Which cached targets an automatic update replaces: fetched from a release (a version) older than `latest`.
pub fn outdated(cached: &[(&'static str, Option<String>)], latest: &str) -> Vec<&'static str> {
    cached.iter().filter(|(_, v)| v.as_deref().is_some_and(|v| newer(latest, v))).map(|(t, _)| *t).collect()
}

/// 一次更新是誰起的。/ What started an update.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Trigger {
    /// 每天的自動檢查。/ The daily automatic check.
    Auto,
    /// 管理員在面板上按的，或 `telepy-server fetch-carriers`。/ An admin on the panel, or the subcommand.
    Manual,
}

/// 換掉的一個平台：之前是什麼。/ One replaced platform and what it was before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Updated {
    pub target: String,
    /// 之前的版本（null = 之前沒有，或是手動放的）。/ The version before (null = none, or a hand-placed one).
    pub from: Option<String>,
    /// `missing` = 之前沒有；`release` = 從 release 抓的；`manual` = 手動放的。/ What was there before.
    pub was: &'static str,
}

/// 一次更新的結果。/ The outcome of one update run.
#[derive(Debug, Clone, Serialize)]
pub struct Run {
    pub at: DateTime<Utc>,
    pub trigger: Trigger,
    /// 誰按的（自動 = null）。/ Who started it (null = automatic).
    pub by: Option<String>,
    #[serde(skip)]
    pub by_id: Option<i64>,
    /// 更新到的 tag（連最新版都問不到 = null）。/ The tag updated to (null when even the latest could not be read).
    pub tag: Option<String>,
    pub updated: Vec<Updated>,
    /// 本來就是這個版本的平台。/ Platforms already at this version.
    pub current: Vec<String>,
    /// 抓不到的平台與原因。/ Platforms that failed, with why.
    pub failed: Vec<(String, String)>,
    /// 整次失敗的原因（問不到最新版）。/ Why the whole run failed (the latest release could not be read).
    pub error: Option<String>,
}

impl Run {
    pub fn ok(&self) -> bool {
        self.error.is_none() && self.failed.is_empty()
    }
    /// 一句話的失敗原因。/ The failure in one line.
    pub fn failure(&self) -> Option<String> {
        if let Some(e) = &self.error {
            return Some(e.clone());
        }
        (!self.failed.is_empty()).then(|| self.failed.iter().map(|(t, e)| format!("{t}: {e}")).collect::<Vec<_>>().join("; "))
    }
}

/// 最近一次檢查與更新（記憶體；重啟就重來）。/ The latest check and run (memory only).
#[derive(Debug, Default)]
struct CheckState {
    latest: Option<String>,
    checked_at: Option<DateTime<Utc>>,
    error: Option<String>,
    last_run: Option<Run>,
    /// 已經通知過的自動更新錯誤（同一個錯誤只說一次）。/ The automatic-update error already announced.
    notified_error: Option<String>,
}

/// 正在更新的標記；放掉就清。/ Marks an update in progress; cleared on drop.
pub struct Busy<'a>(&'a AtomicBool);

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

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
    /// 檔案的時間（抓下來或放進去的時候）。/ When the file was written.
    pub fetched_at: Option<DateTime<Utc>>,
}

pub struct Carriers {
    dir: PathBuf,
    releases: String,
    /// 這個後端的發行版號（`TELEPY_VERSION`）：先拿同版的載體，沒有再拿最新的。/ This build's version: the same release first.
    version: Option<String>,
    http: reqwest::Client,
    no_redirect: reqwest::Client,
    /// 信任的發行公鑰（`release_key`）。/ The release keys in force.
    keys: Vec<crate::ssh_key::PublicKey>,
    /// 每個 target 一把鎖：同時來的請求只抓一次。/ One fetch per target at a time.
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// 最近失敗的（什麼時候、為什麼）。/ Recent failures (when, why).
    failures: Mutex<HashMap<String, (Instant, String)>>,
    /// 最近一次檢查與更新。/ The latest check and run.
    status: Mutex<CheckState>,
    /// 有一次更新正在跑。/ An update is running.
    updating: AtomicBool,
}

impl Carriers {
    /// 公鑰：`TELEPY_RELEASE_KEYS`（`config.release_keys`）有設就用它，否則內建的。/ The env override, else the built-in keys.
    pub fn new(config: &Config, http: reqwest::Client) -> Self {
        let keys = match config.release_keys.as_deref().filter(|k| !k.trim().is_empty()) {
            Some(k) => crate::release_key::parse_keys(k),
            None => crate::release_key::parse_keys(&crate::release_key::RELEASE_KEYS.join("\n")),
        };
        Self::with_keys(config, http, keys)
    }

    /// 指定公鑰（測試用假的 release 伺服器時）。/ With given keys (tests against a fake release server).
    pub fn with_keys(config: &Config, http: reqwest::Client, keys: Vec<crate::ssh_key::PublicKey>) -> Self {
        let no_redirect = reqwest::Client::builder().timeout(Duration::from_secs(20)).redirect(reqwest::redirect::Policy::none()).user_agent("telepy-server").build().expect("reqwest client");
        Self {
            dir: config.carrier_dir.clone(),
            releases: config.releases_url.clone(),
            version: option_env!("TELEPY_VERSION").map(str::to_string),
            http,
            no_redirect,
            keys,
            locks: Mutex::new(HashMap::new()),
            failures: Mutex::new(HashMap::new()),
            status: Mutex::new(CheckState::default()),
            updating: AtomicBool::new(false),
        }
    }

    /// 開始一次更新；已經有一次在跑 = None。/ Start an update; None while one is running.
    pub fn begin(&self) -> Option<Busy<'_>> {
        self.updating.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok().map(|_| Busy(&self.updating))
    }

    /// 自動更新到期了嗎（從沒問過，或上次問超過一天）。/ Whether the automatic check is due.
    pub fn check_due(&self, now: DateTime<Utc>) -> bool {
        let s = self.status.lock().unwrap();
        match s.checked_at {
            None => true,
            Some(at) => now.signed_duration_since(at).to_std().map(|d| d >= CHECK_EVERY).unwrap_or(true),
        }
    }

    /// 問 release 頁最新的 tag，記下結果。/ Ask for the latest tag and remember the answer.
    pub async fn check(&self) -> Result<String> {
        let r = self.latest_tag().await;
        let mut s = self.status.lock().unwrap();
        s.checked_at = Some(Utc::now());
        match &r {
            Ok(t) => {
                s.latest = Some(t.clone());
                s.error = None;
            }
            Err(e) => s.error = Some(format!("{e:#}")),
        }
        r
    }

    /// 快取裡每個平台的版本（沒有的不列）。/ The cached platforms and their versions.
    pub fn cached_versions(&self) -> Vec<(&'static str, Option<String>)> {
        TARGETS.iter().filter_map(|t| self.cached(t.name).map(|c| (t.name, c.version))).collect()
    }

    /// 把平台更新到最新版。`wanted` = 只更新這些（None = 全部平台：沒有的抓、舊的換、手動放的也換）；已經是最新版的不動。
    /// Update platforms to the latest release. `wanted` = only these (None = every platform: missing ones are fetched,
    /// older and hand-placed ones replaced); platforms already at that version are left as they are.
    pub async fn update(&self, wanted: Option<&[&str]>, trigger: Trigger, by: Option<(i64, String)>) -> Run {
        let mut run = Run { at: Utc::now(), trigger, by: by.as_ref().map(|b| b.1.clone()), by_id: by.map(|b| b.0), tag: None, updated: vec![], current: vec![], failed: vec![], error: None };
        let latest = match self.check().await {
            Ok(t) => t,
            Err(e) => {
                run.error = Some(format!("cannot read the latest release from {}: {e:#}", self.releases));
                self.status.lock().unwrap().last_run = Some(run.clone());
                return run;
            }
        };
        run.tag = Some(latest.clone());
        for t in TARGETS.iter().map(|t| t.name).filter(|n| wanted.is_none_or(|w| w.contains(n))) {
            let had = self.cached(t);
            match had.as_ref().map(|c| c.version.as_deref()) {
                // 已經是這版（或更新：鏡像的 latest 比較舊時不倒退）。/ Already this version, or newer (never downgraded).
                Some(Some(v)) if !newer(&latest, v) && parse_version(v).is_some() => {
                    run.current.push(t.to_string());
                    continue;
                }
                _ => {}
            }
            let lock = self.locks.lock().unwrap().entry(t.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone();
            let _held = lock.lock().await;
            match self.fetch_tag(t, &latest).await {
                Ok(_) => {
                    self.failures.lock().unwrap().remove(t);
                    let (from, was) = match &had {
                        None => (None, "missing"),
                        Some(c) => (c.version.clone(), if c.version.is_some() { "release" } else { "manual" }),
                    };
                    run.updated.push(Updated { target: t.to_string(), from, was });
                }
                Err(e) => {
                    let why = format!("{e:#}");
                    self.failures.lock().unwrap().insert(t.to_string(), (Instant::now(), format!("cannot fetch the carrier for {t} from {}: {why}", self.releases)));
                    run.failed.push((t.to_string(), why));
                }
            }
        }
        self.status.lock().unwrap().last_run = Some(run.clone());
        run
    }

    /// 這個錯誤還沒通知過嗎（通知過就記下）；成功時清掉。/ Whether this automatic-update error is new (and remember it).
    fn first_time(&self, error: Option<&str>) -> bool {
        let mut s = self.status.lock().unwrap();
        match error {
            None => {
                s.notified_error = None;
                false
            }
            Some(e) if s.notified_error.as_deref() == Some(e) => false,
            Some(e) => {
                s.notified_error = Some(e.to_string());
                true
            }
        }
    }

    /// 面板與 API 用的樣子。/ The view for the panel and the API.
    pub fn view(&self) -> Value {
        let s = self.status.lock().unwrap();
        let failures = self.failures.lock().unwrap().clone();
        let targets: Vec<Value> = TARGETS
            .iter()
            .map(|t| {
                let cached = self.cached(t.name);
                let failure = failures.get(t.name).map(|(at, why)| {
                    let when = Utc::now() - chrono::Duration::from_std(at.elapsed()).unwrap_or_default();
                    json!({ "at": when, "error": why })
                });
                let update_available = match (&s.latest, cached.as_ref()) {
                    (Some(l), Some(c)) => c.version.as_deref().is_some_and(|v| newer(l, v)),
                    _ => false,
                };
                json!({
                    "target": t.name,
                    "os": t.os,
                    "arch": t.machines.first().copied().unwrap_or(""),
                    "cached": cached.map(|c| json!({ "version": c.version, "sha256": c.sha256, "size": c.size, "fetched_at": c.fetched_at })),
                    "update_available": update_available,
                    "failure": failure,
                })
            })
            .collect();
        json!({
            "releases_url": self.releases,
            "dir": self.dir.display().to_string(),
            "keys": self.keys.iter().map(|k| json!({ "fingerprint": k.fingerprint(crate::ssh_key::HashAlg::Sha256).to_string(), "comment": k.comment().to_string() })).collect::<Vec<_>>(),
            "latest": { "tag": s.latest, "checked_at": s.checked_at, "error": s.error },
            "next_check_at": s.checked_at.map(|at| at + chrono::Duration::from_std(CHECK_EVERY).unwrap_or_default()),
            "updating": self.updating.load(Ordering::SeqCst),
            "targets": targets,
            "last_run": s.last_run,
        })
    }

    /// 給 doctor：信任哪些公鑰。/ For doctor: which keys are trusted.
    pub fn keys_description(&self) -> String {
        crate::release_key::describe(&self.keys)
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
        let fetched_at = meta.modified().ok().map(DateTime::<Utc>::from);
        Some(Cached { path, sha256, size: meta.len(), version, fetched_at })
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
        // 先驗簽：沒簽、簽錯、不是 Telepy 的發行金鑰 = 整個 release 不信。/ The signature first: unsigned or foreign = not trusted.
        let sig = self.download(&format!("{base}/SHA256SUMS.sig")).await.context("the release has no SHA256SUMS.sig (not a signed release)")?;
        let signer = crate::release_key::verify_with(&self.keys, &sums, &String::from_utf8_lossy(&sig)).map_err(|e| anyhow::anyhow!("SHA256SUMS signature: {e}"))?;
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
        tracing::info!(target, tag, size = bin.len(), signer, "device carrier fetched");
        Ok(Cached { path, sha256: sha, size: bin.len() as u64, version: Some(tag.to_string()), fetched_at: Some(Utc::now()) })
    }

    /// 全部平台更新到最新版（`telepy-server fetch-carriers`）：沒有的抓、舊的與手動放的換掉。/ Every platform to the latest release.
    pub async fn prefetch(&self) -> Run {
        self.failures.lock().unwrap().clear();
        self.update(None, Trigger::Manual, None).await
    }
}

/// 背景：啟動兩分鐘後第一次看，之後每小時醒一次，到期才真的去問。/ Background: first look after two minutes, then hourly.
pub async fn run(state: AppState) {
    tokio::time::sleep(FIRST_LOOK_AFTER).await;
    let mut tick = tokio::time::interval(LOOP_EVERY);
    loop {
        tick.tick().await;
        let _ = auto_update_once(&state).await;
    }
}

/// 自動更新一輪：設定開著、快取裡有從 release 抓來的、到了該問的時間 → 問最新版，比較舊的換掉，結果通知管理員。
/// 什麼都沒快取（沒有裝置用過網頁 port）就完全不連外。回這一輪做了什麼（None = 沒做）。
/// One automatic round: with the setting on, something cached from a release and the check due → ask for the latest
/// release, replace older carriers, tell the admins. Nothing cached (no device used the web port) = no network at all.
pub async fn auto_update_once(state: &AppState) -> Option<Run> {
    let on = crate::db::settings::get_solo(&state.db).await.map(|s| s.carrier_auto_update).unwrap_or(true);
    if !on {
        return None;
    }
    let c = &state.carriers;
    let cached = c.cached_versions();
    if !cached.iter().any(|(_, v)| v.is_some()) || !c.check_due(Utc::now()) {
        return None;
    }
    let _busy = c.begin()?;
    let latest = match c.check().await {
        Ok(t) => t,
        Err(e) => {
            let why = format!("cannot read the latest release from {}: {e:#}", c.releases);
            if c.first_time(Some(&why)) {
                let run = Run { at: Utc::now(), trigger: Trigger::Auto, by: None, by_id: None, tag: None, updated: vec![], current: vec![], failed: vec![], error: Some(why) };
                c.status.lock().unwrap().last_run = Some(run.clone());
                announce(state, &run).await;
                return Some(run);
            }
            return None;
        }
    };
    let targets = outdated(&cached, &latest);
    if targets.is_empty() {
        c.first_time(None);
        return None;
    }
    let run = c.update(Some(&targets), Trigger::Auto, None).await;
    // 同一個失敗只說一次；成功（或部分成功）一定說。/ A repeated failure is said once; any update is always said.
    let say = !run.updated.is_empty() || c.first_time(run.failure().as_deref());
    if run.ok() {
        c.first_time(None);
    }
    if say {
        announce(state, &run).await;
    }
    Some(run)
}

/// 把一次更新的結果告訴大家：稽核事件、每個管理員的站內提示（按的人除外）、全站 webhook。手動更新的失敗只記事件
/// （按的人在面板上就看得到）。/ Announce a run: an audit event, an in-app notice to every admin but the one who
/// clicked, the site-wide webhooks. A manual run's failure is only an event (whoever clicked sees it on the panel).
pub async fn announce(state: &AppState, run: &Run) {
    let tag = run.tag.clone().unwrap_or_default();
    let who = match &run.by {
        Some(b) => format!("by {b}"),
        None => "automatically".to_string(),
    };
    let targets: Vec<String> = run.updated.iter().map(|u| u.target.clone()).collect();
    if !run.updated.is_empty() {
        let list = run.updated.iter().map(|u| format!("{} ({})", u.target, u.from.as_deref().unwrap_or(if u.was == "manual" { "hand-placed" } else { "new" }))).collect::<Vec<_>>().join(", ");
        state.gateway.event("carriers_updated", None, None, None, format!("device carriers updated to {tag} {who}: {list}")).await;
    }
    let failure = run.failure();
    if let Some(why) = &failure {
        state.gateway.event("carriers_update_failed", None, None, None, format!("device carrier update {who} failed: {why}")).await;
    }
    let notify_failure = failure.is_some() && run.trigger == Trigger::Auto;
    if run.updated.is_empty() && !notify_failure {
        return;
    }
    let admins: Vec<i64> = sqlx::query_scalar("SELECT id FROM auth_user WHERE is_superuser = 1 AND is_active = 1").fetch_all(&state.db.read).await.unwrap_or_default();
    let admins: Vec<i64> = admins.into_iter().filter(|id| Some(*id) != run.by_id).collect();
    let link = "/tunnels/admin/health?tab=services#carriers";
    if !run.updated.is_empty() {
        state.hub.notify_users(
            admins.clone(),
            &json!({ "action": "CARRIERS-UPDATED", "tag": tag, "targets": targets, "by": run.by, "details": format!("Device carriers updated to {tag} ({})", targets.join(", ")) }),
        );
        state.webhooks.emit(crate::webhooks::Event::new(crate::webhooks::Kind::CarriersUpdated).data(json!({ "tag": tag, "targets": targets, "by": run.by })).link(link));
    }
    if notify_failure {
        let why = failure.unwrap_or_default();
        state.hub.notify_users(admins, &json!({ "action": "CARRIERS-UPDATE-FAILED", "tag": run.tag, "error": why, "details": format!("Updating the device carriers failed: {why}") }));
        state.webhooks.emit(crate::webhooks::Event::new(crate::webhooks::Kind::CarriersUpdateFailed).data(json!({ "tag": run.tag, "error": why })).link(link));
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

    /// 一個 tar.gz，裡面是 telepy-carrier。/ A tar.gz holding a telepy-carrier.
    fn targz(bin: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let enc = flate2::write::GzEncoder::new(&mut out, flate2::Compression::fast());
            let mut b = tar::Builder::new(enc);
            let mut h = tar::Header::new_gnu();
            h.set_size(bin.len() as u64);
            h.set_mode(0o755);
            h.set_cksum();
            b.append_data(&mut h, "telepy-carrier", bin).unwrap();
            b.into_inner().unwrap().finish().unwrap();
        }
        out
    }

    /// 假的 release 伺服器：`/releases/latest` 轉址到 `vtest`，`/releases/download/vtest/<file>` 給檔案。
    /// A fake release server: `/releases/latest` redirects to `vtest`, `/releases/download/vtest/<file>` serves the files.
    async fn fake_release(files: HashMap<String, Vec<u8>>) -> String {
        fake_release_tag("vtest", files).await
    }

    async fn fake_release_tag(tag: &'static str, files: HashMap<String, Vec<u8>>) -> String {
        use axum::extract::{Path as AxPath, State};
        use axum::http::{header, StatusCode};
        use axum::response::IntoResponse;
        use axum::routing::get;
        let files = Arc::new(files);
        let app = axum::Router::new()
            .route("/releases/latest", get(move || async move { (StatusCode::FOUND, [(header::LOCATION, format!("/releases/tag/{tag}"))]).into_response() }))
            .route(
                &format!("/releases/download/{tag}/{{file}}"),
                get(|State(files): State<Arc<HashMap<String, Vec<u8>>>>, AxPath(file): AxPath<String>| async move {
                    match files.get(&file) {
                        Some(b) => (StatusCode::OK, b.clone()).into_response(),
                        None => StatusCode::NOT_FOUND.into_response(),
                    }
                }),
            )
            .with_state(files);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}/releases")
    }

    /// 抓載體：release 的 SHA256SUMS 要是信任的發行金鑰簽的；別人簽的、沒簽的都不要。/ A fetch needs SHA256SUMS signed by a trusted key.
    #[tokio::test]
    async fn carriers_come_only_from_a_release_signed_with_a_trusted_key() {
        use crate::release_key::NAMESPACE;
        use crate::ssh_key::{Algorithm, HashAlg, LineEnding, PrivateKey};
        let key = PrivateKey::random(&mut rand10::rng(), Algorithm::Ed25519).unwrap();
        let other = PrivateKey::random(&mut rand10::rng(), Algorithm::Ed25519).unwrap();
        let target = "x86_64-unknown-linux-musl";
        let name = archive_name(target);
        let bin = b"#!/bin/sh\necho carrier\n";
        let archive = targz(bin);
        let sums = format!("{}  {name}\n", sha256_hex(&archive));
        let sign = |k: &PrivateKey| k.sign(NAMESPACE, HashAlg::Sha512, sums.as_bytes()).unwrap().to_pem(LineEnding::LF).unwrap().into_bytes();
        let files = |sig: Option<Vec<u8>>| {
            let mut m = HashMap::from([(name.clone(), archive.clone()), ("SHA256SUMS".to_string(), sums.clone().into_bytes())]);
            if let Some(s) = sig {
                m.insert("SHA256SUMS.sig".to_string(), s);
            }
            m
        };
        let dir = tempfile::tempdir().unwrap();
        let trusted = vec![key.public_key().clone()];
        let mut config = Config::from_env();

        // 信任的金鑰簽的：抓下來、解開、快取。/ Signed by the trusted key: fetched, extracted, cached.
        config.carrier_dir = dir.path().join("a");
        config.releases_url = fake_release(files(Some(sign(&key)))).await;
        let c = Carriers::with_keys(&config, reqwest::Client::new(), trusted.clone());
        let got = c.get(target).await.unwrap();
        assert_eq!((got.size as usize, got.version.as_deref()), (bin.len(), Some("vtest")));
        assert_eq!(std::fs::read(&got.path).unwrap(), bin);
        assert_eq!(c.cached(target).map(|x| x.sha256), Some(sha256_hex(bin)));

        // 別人簽的。/ Signed by someone else.
        config.carrier_dir = dir.path().join("b");
        config.releases_url = fake_release(files(Some(sign(&other)))).await;
        let c = Carriers::with_keys(&config, reqwest::Client::new(), trusted.clone());
        let e = c.get(target).await.unwrap_err().to_string();
        assert!(e.contains("none of the Telepy release keys"), "{e}");
        assert!(c.cached(target).is_none());

        // 沒簽。/ Unsigned.
        config.carrier_dir = dir.path().join("c");
        config.releases_url = fake_release(files(None)).await;
        let c = Carriers::with_keys(&config, reqwest::Client::new(), trusted);
        let e = c.get(target).await.unwrap_err().to_string();
        assert!(e.contains("SHA256SUMS.sig"), "{e}");
        assert!(c.keys_description().starts_with("SHA256:"));
    }

    #[test]
    fn versions_compare_by_number_and_only_release_copies_are_outdated() {
        assert_eq!(parse_version("v2.12.0"), Some((2, 12, 0)));
        assert_eq!(parse_version("2.12"), Some((2, 12, 0)));
        assert_eq!(parse_version("v2.12.0-rc.1"), Some((2, 12, 0)));
        assert_eq!(parse_version("vtest"), None);
        assert_eq!(parse_version("v1.2.3.4"), None);
        assert!(newer("v2.13.0", "v2.12.0") && newer("v2.10.0", "v2.9.0"), "numbers, not text");
        assert!(!newer("v2.12.0", "v2.12.0") && !newer("v2.11.0", "v2.12.0") && !newer("vtest", "v2.12.0"));
        let cached = [("a", Some("v2.11.0".to_string())), ("b", None), ("c", Some("v2.12.0".to_string())), ("d", Some("v3.0.0".to_string()))];
        assert_eq!(outdated(&cached, "v2.12.0"), vec!["a"], "hand-placed, current and newer ones stay");
    }

    /// 更新：舊的換、手動放的換、沒有的抓、比最新還新的不倒退；第二次什麼都不做。/ An update run, then a second one that does nothing.
    #[tokio::test]
    async fn an_update_brings_platforms_to_the_latest_release_and_never_downgrades() {
        use crate::release_key::NAMESPACE;
        use crate::ssh_key::{Algorithm, HashAlg, LineEnding, PrivateKey};
        let key = PrivateKey::random(&mut rand10::rng(), Algorithm::Ed25519).unwrap();
        let picked = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl", "armv7-unknown-linux-musleabihf", "arm-unknown-linux-musleabihf"];
        let mut files = HashMap::new();
        let mut sums = String::new();
        for t in picked {
            let a = targz(format!("bin for {t}").as_bytes());
            sums.push_str(&format!("{}  {}\n", sha256_hex(&a), archive_name(t)));
            files.insert(archive_name(t), a);
        }
        files.insert("SHA256SUMS.sig".to_string(), key.sign(NAMESPACE, HashAlg::Sha512, sums.as_bytes()).unwrap().to_pem(LineEnding::LF).unwrap().into_bytes());
        files.insert("SHA256SUMS".to_string(), sums.into_bytes());
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::from_env();
        config.carrier_dir = dir.path().join("carriers");
        config.releases_url = fake_release_tag("v9.9.9", files).await;
        let c = Carriers::with_keys(&config, reqwest::Client::new(), vec![key.public_key().clone()]);
        let put = |t: &str, version: Option<&str>| {
            let d = config.carrier_dir.join(t);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("telepy-carrier"), b"old").unwrap();
            if let Some(v) = version {
                std::fs::write(d.join("sha256"), format!("{} {v}\n", sha256_hex(b"old"))).unwrap();
            }
        };
        put(picked[0], Some("v0.0.1"));
        put(picked[1], None);
        put(picked[3], Some("v99.0.0"));
        // 自動只換從 release 抓來、比較舊的。/ Automatic: only the older release copy.
        let auto = outdated(&c.cached_versions(), "v9.9.9");
        assert_eq!(auto, vec![picked[0]]);
        let run = c.update(Some(&auto), Trigger::Auto, None).await;
        assert!(run.ok() && run.tag.as_deref() == Some("v9.9.9"), "{run:?}");
        assert_eq!(run.updated, vec![Updated { target: picked[0].into(), from: Some("v0.0.1".into()), was: "release" }]);
        assert_eq!(c.cached(picked[0]).unwrap().version.as_deref(), Some("v9.9.9"));
        assert_eq!(c.cached(picked[1]).unwrap().version, None, "the hand-placed one is untouched by the automatic run");
        // 手動「全部」：手動放的換、沒有的抓、比最新還新的不動；沒有發行檔的平台記成失敗。
        // Manual "everything": the hand-placed one replaced, the missing one fetched, the newer one kept.
        let run = c.update(Some(&picked[1..]), Trigger::Manual, Some((7, "alice".into()))).await;
        assert_eq!(run.by.as_deref(), Some("alice"));
        let was: Vec<(&str, &str)> = run.updated.iter().map(|u| (u.target.as_str(), u.was)).collect();
        assert_eq!(was, vec![(picked[1], "manual"), (picked[2], "missing")]);
        assert_eq!(run.current, vec![picked[3].to_string()], "never downgraded");
        assert_eq!(std::fs::read(c.cached(picked[2]).unwrap().path).unwrap(), format!("bin for {}", picked[2]).as_bytes());
        let again = c.update(Some(&picked), Trigger::Manual, None).await;
        assert!(again.updated.is_empty() && again.current.len() == 4, "{again:?}");
        let v = c.view();
        assert_eq!(v["latest"]["tag"], "v9.9.9");
        assert_eq!(v["targets"].as_array().unwrap().len(), TARGETS.len());
        assert!(v["last_run"]["current"].as_array().unwrap().len() == 4);
        // 抓不到 release 頁：整次失敗，記下原因。/ The release page unreachable: the whole run fails with why.
        config.releases_url = "http://127.0.0.1:9/releases".into();
        let off = Carriers::with_keys(&config, reqwest::Client::new(), vec![key.public_key().clone()]);
        let run = off.update(None, Trigger::Auto, None).await;
        assert!(!run.ok() && run.failure().unwrap().contains("cannot read the latest release"), "{run:?}");
        assert!(off.begin().is_some() && off.begin().is_some(), "the busy flag is released on drop");
        let held = off.begin();
        assert!(held.is_some() && off.begin().is_none(), "one update at a time");
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
