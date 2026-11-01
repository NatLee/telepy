//! 後端讀的離線資料：DB-IP Lite（國家 + ASN，CC BY 4.0）在 `GEOIP_DIR`、IEEE 的 OUI 表在 `OUI_DIR`。
//! 下載：`telepy-server geoip` / `telepy-server oui`（容器裡跑，路徑就是後端讀的那個），或伺服器健康頁的面板。
//! 保持最新：網站設定 `datasets_auto_update`（預設開）時，背景每天最多看一次——已經裝好的 DB-IP 不是這個月的就抓這個月的
//! （還沒出就明天再試），廠商表超過 [`OUI_REFRESH_DAYS`] 天就重抓。還沒裝過的不會自己下載（第一次由管理員按）。
//! 檔案先寫到旁邊的暫存檔、檢查過（mmdb 能開、csv 的表頭對）才改名；DB-IP 旁邊另存一個 `.release`（哪個月的）。
//! 後端每小時看一次檔案有沒有換（大小 / 修改時間），換了就重讀，不必重啟；面板更新完立刻重讀。
//! 查詢完全在本機；這裡是唯一會連外的地方。
//!
//! The offline datasets the backend reads: DB-IP Lite (country + ASN) in `GEOIP_DIR` and IEEE's OUI registry in
//! `OUI_DIR`. Downloaded by `telepy-server geoip` / `oui` (inside the container) or from the Server health panel.
//! Staying current: with the site setting `datasets_auto_update` (on by default) a background task looks at most once
//! a day — installed DB-IP files not from this month are replaced by this month's (not published yet = try again
//! tomorrow), the vendor table is fetched again after [`OUI_REFRESH_DAYS`] days. Nothing that was never installed is
//! downloaded on its own. Files are written beside their destination, checked and renamed into place; DB-IP files get
//! a `.release` file saying which month they are. The backend notices changed files hourly (size / mtime) and reloads
//! them without a restart; the panel reloads right after an update. Lookups stay local; this is the only place that
//! connects outward.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use serde::Serialize;
use serde_json::{json, Value};

use crate::geoip::{GeoIp, InUse};
use crate::oui::Oui;
use crate::state::AppState;

pub const DBIP_BASE: &str = "https://download.db-ip.com/free";
pub const OUI_URL: &str = "https://standards-oui.ieee.org/oui/oui.csv";
/// DB-IP 的兩個免費資料庫。/ The two free DB-IP databases.
pub const GEOIP_KINDS: [&str; 2] = ["country", "asn"];
/// 面板上的三項：兩個 DB-IP 檔與廠商表。/ The panel's three items: both DB-IP files and the vendor table.
pub const ITEMS: [&str; 3] = ["country", "asn", "oui"];
pub const ATTRIBUTION: &str = "IP geolocation by DB-IP (https://db-ip.com), CC BY 4.0. Re-run monthly for fresh data.";
/// 廠商表多久重抓一次。/ How old the vendor table may get before it is fetched again.
pub const OUI_REFRESH_DAYS: i64 = 30;
/// 用中的 GeoIP 超過這麼久沒換 = doctor 警告。/ GeoIP data in use older than this = a doctor warning.
pub const GEOIP_STALE_DAYS: i64 = 70;
/// 廠商表超過這麼久沒換 = doctor 警告。/ A vendor table older than this = a doctor warning.
pub const OUI_STALE_DAYS: i64 = 120;
/// 自動更新多久看一次。/ How often the automatic update looks.
pub const CHECK_EVERY: Duration = Duration::from_secs(24 * 3600);
/// 背景迴圈多久醒一次（看檔案有沒有換、自動更新到期沒）。/ How often the background loop wakes.
const LOOP_EVERY: Duration = Duration::from_secs(3600);
/// 啟動後等多久才第一次看（不拖慢啟動）。/ The first look waits this long after start.
const FIRST_LOOK_AFTER: Duration = Duration::from_secs(180);

/// `https://download.db-ip.com/free/dbip-country-lite-2026-11.mmdb.gz`
pub fn dbip_url(kind: &str, month: &str) -> String {
    dbip_url_at(DBIP_BASE, kind, month)
}

pub fn dbip_url_at(base: &str, kind: &str, month: &str) -> String {
    format!("{}/dbip-{kind}-lite-{month}.mmdb.gz", base.trim_end_matches('/'))
}

/// 這個月與上個月（DB-IP 每月初才放新檔，月初常只有上個月的）。/ This month and the previous one (the new file appears a few days in).
pub fn months(today: NaiveDate) -> [String; 2] {
    let (y, m) = (today.year(), today.month());
    let (py, pm) = if m == 1 { (y - 1, 12) } else { (y, m - 1) };
    [format!("{y:04}-{m:02}"), format!("{py:04}-{pm:02}")]
}

pub fn geoip_file(kind: &str) -> String {
    format!("dbip-{kind}-lite.mmdb")
}

/// DB-IP 檔旁邊記「哪個月的」的檔案。/ The file beside a DB-IP database saying which month it is.
pub fn release_file(kind: &str) -> String {
    format!("{}.release", geoip_file(kind))
}

/// `YYYY-MM`？/ Whether the text is a `YYYY-MM` month.
fn is_month(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[4] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || c.is_ascii_digit())
}

/// 要試哪幾個月（新的先）：這個月、上個月，遇到已經裝的那個月就停（不往回抓）。純函式。
/// The months to try, newest first: this month and the previous one, stopping at the installed month. Pure.
pub fn dbip_candidates(today: NaiveDate, installed: Option<&str>) -> Vec<String> {
    months(today).into_iter().take_while(|m| Some(m.as_str()) != installed).collect()
}

/// 自動更新：裝了、但不是這個月的 → 該看了。純函式。/ Automatic update: installed but not this month's = due. Pure.
pub fn dbip_due(present: bool, installed: Option<&str>, today: NaiveDate) -> bool {
    present && installed != Some(months(today)[0].as_str())
}

/// 自動更新：裝了、超過 [`OUI_REFRESH_DAYS`] 天（或不知道多舊）→ 該重抓了。純函式。/ The vendor table is due. Pure.
pub fn oui_due(present: bool, modified: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    present && modified.is_none_or(|m| now.signed_duration_since(m) >= chrono::Duration::days(OUI_REFRESH_DAYS))
}

/// 建置時間 → 它是哪個月的（沒有 `.release` 檔時的猜測）。/ The month a build date belongs to (when there is no `.release`).
pub fn month_of(built: DateTime<Utc>) -> String {
    format!("{:04}-{:02}", built.year(), built.month())
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder().timeout(Duration::from_secs(180)).user_agent("telepy-server").build().context("http client")
}

/// GET；404 = Ok(None)（DB-IP 這個月的還沒出）。/ GET; a 404 is Ok(None) (this month's file is not out yet).
async fn get(client: &reqwest::Client, url: &str) -> Result<Option<Vec<u8>>> {
    let r = client.get(url).send().await.with_context(|| format!("GET {url}"))?;
    if r.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !r.status().is_success() {
        bail!("{url}: HTTP {}", r.status());
    }
    Ok(Some(r.bytes().await.with_context(|| format!("reading {url}"))?.to_vec()))
}

pub fn gunzip(bytes: &[u8]) -> Result<Vec<u8>> {
    use std::io::Read;
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes).read_to_end(&mut out).context("gunzip")?;
    Ok(out)
}

/// 先寫到 `.<name>.tmp` 再改名，後端永遠只看到完整的檔案。/ Write beside, then rename: the backend never sees a half file.
pub fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf> {
    std::fs::create_dir_all(dir).with_context(|| format!("cannot create {}", dir.display()))?;
    let tmp = dir.join(format!(".{name}.tmp"));
    let dest = dir.join(name);
    std::fs::write(&tmp, bytes).with_context(|| format!("cannot write {}", tmp.display()))?;
    std::fs::rename(&tmp, &dest).with_context(|| format!("cannot move {} into place", tmp.display()))?;
    Ok(dest)
}

/// 一項更新的結果。/ What happened to one item.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// 換上新的了：從哪個（月 / 日期）到哪個。/ Replaced: from which month / date to which.
    Updated { from: Option<String>, to: String },
    /// 沒有更新的可抓（DB-IP 這個月的還沒出）。/ Nothing newer to fetch (this month's DB-IP is not out yet).
    Current,
    Failed(String),
}

/// 抓一個 DB-IP 資料庫：從這個月往回試到已經裝的那個月；成功就寫檔 + `.release`。
/// Fetch one DB-IP database: try this month, then the previous one, down to the installed month; write it and its
/// `.release` on success.
pub async fn fetch_dbip(client: &reqwest::Client, base: &str, dir: &Path, kind: &str, today: NaiveDate, installed: Option<&str>) -> Outcome {
    let tried = dbip_candidates(today, installed);
    let mut errors = Vec::new();
    for month in &tried {
        let url = dbip_url_at(base, kind, month);
        match get(client, &url).await {
            Ok(None) => continue,
            Ok(Some(gz)) => {
                let mmdb = match gunzip(&gz) {
                    Ok(m) => m,
                    Err(e) => {
                        errors.push(format!("{url}: {e:#}"));
                        continue;
                    }
                };
                if let Err(e) = maxminddb::Reader::from_source(mmdb.as_slice()) {
                    errors.push(format!("{url}: not a readable mmdb ({e})"));
                    continue;
                }
                if let Err(e) = write_atomic(dir, &geoip_file(kind), &mmdb).and_then(|_| write_atomic(dir, &release_file(kind), month.as_bytes())) {
                    return Outcome::Failed(format!("{e:#}"));
                }
                return Outcome::Updated { from: installed.map(str::to_string), to: month.clone() };
            }
            Err(e) => errors.push(format!("{e:#}")),
        }
    }
    if !errors.is_empty() {
        Outcome::Failed(errors.join("; "))
    } else if installed.is_some() {
        Outcome::Current
    } else {
        Outcome::Failed(format!("DB-IP has no {kind} file for {} yet", tried.join(" or ")))
    }
}

/// 下載兩個 DB-IP Lite 資料庫（`telepy-server geoip`：不管裝了哪個月都重抓）；回每一個的結果行。有一個失敗就整體 Err。
/// Fetch both DB-IP Lite databases (the subcommand always fetches); one line per database. Any failure = Err.
pub async fn fetch_geoip(dir: &Path, today: NaiveDate) -> Result<Vec<String>> {
    let client = client()?;
    let mut lines = Vec::new();
    let mut errors = Vec::new();
    for kind in GEOIP_KINDS {
        match fetch_dbip(&client, DBIP_BASE, dir, kind, today, None).await {
            Outcome::Updated { to, .. } => lines.push(format!("{kind}: {to} → {}", dir.join(geoip_file(kind)).display())),
            Outcome::Current => lines.push(format!("{kind}: already current")),
            Outcome::Failed(e) => errors.push(format!("{kind}: {e}")),
        }
    }
    if !errors.is_empty() {
        bail!("{}", errors.join("\n"));
    }
    Ok(lines)
}

/// IEEE 的表頭。/ The header IEEE's csv starts with.
pub const OUI_HEADER: &str = "Registry,Assignment";

/// 抓 IEEE 的 OUI 表、檢查表頭、寫進去；回幾個廠商。/ Fetch IEEE's registry, check the header, write it; the vendor count.
pub async fn fetch_oui_at(client: &reqwest::Client, url: &str, dir: &Path) -> Result<usize> {
    let Some(csv) = get(client, url).await? else { bail!("{url}: HTTP 404 Not Found") };
    let text = String::from_utf8_lossy(&csv);
    if !text.starts_with(OUI_HEADER) {
        bail!("{url}: unexpected content (no '{OUI_HEADER}' header)");
    }
    let vendors = text.lines().count().saturating_sub(1);
    write_atomic(dir, crate::oui::FILE, &csv)?;
    Ok(vendors)
}

/// 下載 IEEE 的 OUI 表（`telepy-server oui`）；回「N vendors → path」。/ The subcommand: "N vendors → path".
pub async fn fetch_oui(dir: &Path) -> Result<String> {
    let vendors = fetch_oui_at(&client()?, OUI_URL, dir).await?;
    Ok(format!("{vendors} vendors → {}", dir.join(crate::oui::FILE).display()))
}

// ---------------------------------------------------------------- what is installed

fn modified(path: &Path) -> Option<DateTime<Utc>> {
    std::fs::metadata(path).ok()?.modified().ok().map(DateTime::<Utc>::from)
}

fn read_release(dir: &Path, kind: &str) -> Option<String> {
    let s = std::fs::read_to_string(dir.join(release_file(kind))).ok()?;
    let s = s.trim();
    is_month(s).then(|| s.to_string())
}

/// 一項資料現在的樣子。/ One dataset as it is now.
#[derive(Debug, Clone, Serialize)]
pub struct Item {
    pub id: &'static str,
    /// Telepy 管的那個檔（DB-IP / IEEE）。/ The file Telepy manages.
    pub path: String,
    pub present: bool,
    pub size: Option<u64>,
    pub modified: Option<DateTime<Utc>>,
    /// DB-IP：哪個月的（`.release`，沒有就看建置時間）。/ DB-IP: which month (`.release`, else from the build date).
    pub release: Option<String>,
    /// 後端現在用的檔（可能是 MaxMind 的；沒有 = 沒資料）。/ The file the backend uses now (may be MaxMind's).
    pub in_use: Option<Value>,
    /// 廠商表：幾個廠商（讀進記憶體的）。/ Vendor table: how many vendors are loaded.
    pub vendors: Option<usize>,
    /// 自動更新現在會不會去抓它。/ Whether the automatic update would fetch it now.
    pub due: bool,
}

fn in_use_json(u: &InUse) -> Value {
    json!({ "file": u.file, "source": u.source, "built": u.built })
}

/// 三項資料現在的樣子（不連外）。/ The three datasets as they are now (no network).
pub fn inspect(geoip_dir: &Path, oui_dir: &Path, geoip: &GeoIp, oui: &Oui, now: DateTime<Utc>) -> Vec<Item> {
    let today = now.date_naive();
    let (country, asn) = geoip.in_use();
    let mut out = Vec::new();
    for (kind, used) in [("country", country), ("asn", asn)] {
        let name = geoip_file(kind);
        let path = geoip_dir.join(&name);
        let meta = std::fs::metadata(&path).ok().filter(|m| m.is_file());
        let present = meta.is_some();
        // 用中的就是這個檔才拿它的建置時間猜月份。/ Only the loaded copy of this very file gives a build date.
        let built = used.as_ref().filter(|u| u.file == name).and_then(|u| u.built);
        let release = if present { read_release(geoip_dir, kind).or_else(|| built.map(month_of)) } else { None };
        out.push(Item {
            id: if kind == "country" { "country" } else { "asn" },
            path: path.display().to_string(),
            present,
            size: meta.as_ref().map(|m| m.len()),
            modified: modified(&path),
            due: dbip_due(present, release.as_deref(), today),
            release,
            in_use: used.as_ref().map(in_use_json),
            vendors: None,
        });
    }
    let path = oui_dir.join(crate::oui::FILE);
    let meta = std::fs::metadata(&path).ok().filter(|m| m.is_file());
    let present = meta.is_some();
    let when = modified(&path);
    out.push(Item {
        id: "oui",
        path: path.display().to_string(),
        present,
        size: meta.as_ref().map(|m| m.len()),
        modified: when,
        release: None,
        in_use: oui.enabled().then(|| json!({ "file": crate::oui::FILE, "source": "IEEE", "built": null })),
        vendors: oui.enabled().then(|| oui.len()),
        due: oui_due(present, when, now),
    });
    out
}

/// doctor 用：一項資料新不新。/ For doctor: how fresh a dataset is.
#[derive(Debug, Clone, PartialEq)]
pub enum Freshness {
    Missing,
    Fresh(String),
    /// (說明, 指紋的穩定部分：多舊的那一版) / (detail, the stable part of the fingerprint)
    Stale(String, String),
}

/// GeoIP 新不新：用中的檔最舊的建置時間超過 [`GEOIP_STALE_DAYS`] 天 = 舊了。純函式。
/// GeoIP freshness: the oldest build in use older than [`GEOIP_STALE_DAYS`] days = stale. Pure.
pub fn geoip_freshness(country: Option<&InUse>, asn: Option<&InUse>, releases: (Option<&str>, Option<&str>), dir: &Path, now: DateTime<Utc>) -> Freshness {
    let parts: Vec<(&str, &InUse, Option<&str>)> = [("country", country, releases.0), ("ASN", asn, releases.1)].into_iter().filter_map(|(k, u, r)| u.map(|u| (k, u, r))).collect();
    if parts.is_empty() {
        return Freshness::Missing;
    }
    let describe = |(k, u, r): &(&str, &InUse, Option<&str>)| {
        let when = r.map(str::to_string).or_else(|| u.built.map(|b| b.format("%Y-%m-%d").to_string())).unwrap_or_else(|| "unknown date".into());
        format!("{} {k} {when}", u.source)
    };
    let list = parts.iter().map(describe).collect::<Vec<_>>().join(" + ");
    let oldest = parts.iter().filter_map(|(_, u, _)| u.built).min();
    match oldest {
        Some(b) if now.signed_duration_since(b) > chrono::Duration::days(GEOIP_STALE_DAYS) => {
            let days = now.signed_duration_since(b).num_days();
            Freshness::Stale(
                format!("{list} in {}: built {} ({days} days ago). Update it on Server health → Companion services (IP and vendor data), or turn on automatic updates there", dir.display(), b.format("%Y-%m-%d")),
                b.format("%Y-%m-%d").to_string(),
            )
        }
        _ => Freshness::Fresh(format!("{list} in {}", dir.display())),
    }
}

/// 廠商表新不新。純函式。/ Vendor table freshness. Pure.
pub fn oui_freshness(vendors: usize, modified: Option<DateTime<Utc>>, dir: &Path, now: DateTime<Utc>) -> Freshness {
    if vendors == 0 {
        return Freshness::Missing;
    }
    let date = modified.map(|m| m.format("%Y-%m-%d").to_string()).unwrap_or_else(|| "unknown date".into());
    match modified {
        Some(m) if now.signed_duration_since(m) > chrono::Duration::days(OUI_STALE_DAYS) => Freshness::Stale(
            format!("{vendors} vendors from {}, downloaded {date} ({} days ago). Update it on Server health → Companion services (IP and vendor data)", dir.display(), now.signed_duration_since(m).num_days()),
            date,
        ),
        _ => Freshness::Fresh(format!("{vendors} vendors from {}, downloaded {date}", dir.display())),
    }
}

// ---------------------------------------------------------------- keeping them current

/// 一次更新是誰起的。/ What started an update.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Trigger {
    /// 每天的自動檢查。/ The daily automatic check.
    Auto,
    /// 管理員在面板上按的。/ An admin on the panel.
    Manual,
}

/// 一項在這次更新裡的結果。/ One item's result in a run.
#[derive(Debug, Clone, Serialize)]
pub struct RunItem {
    pub id: &'static str,
    /// updated | current | failed
    pub outcome: &'static str,
    pub from: Option<String>,
    pub to: Option<String>,
    pub error: Option<String>,
}

/// 一次更新做了什麼。/ What one update did.
#[derive(Debug, Clone, Serialize)]
pub struct Run {
    pub at: DateTime<Utc>,
    pub trigger: Trigger,
    pub by: Option<String>,
    #[serde(skip)]
    pub by_id: Option<i64>,
    pub items: Vec<RunItem>,
}

impl Run {
    pub fn updated(&self) -> Vec<&RunItem> {
        self.items.iter().filter(|i| i.outcome == "updated").collect()
    }

    /// 失敗的合在一起（沒有 = None）。/ The failures joined (None = none).
    pub fn failure(&self) -> Option<String> {
        let f: Vec<String> = self.items.iter().filter_map(|i| i.error.as_ref().map(|e| format!("{}: {e}", i.id))).collect();
        (!f.is_empty()).then(|| f.join("; "))
    }
}

/// 下載來源（測試指到假的伺服器）。/ Where downloads come from (tests point them at a fake server).
#[derive(Debug, Clone)]
pub struct Sources {
    pub dbip: String,
    pub oui: String,
}

impl Default for Sources {
    fn default() -> Self {
        Self { dbip: DBIP_BASE.into(), oui: OUI_URL.into() }
    }
}

#[derive(Default)]
struct Status {
    checked_at: Option<DateTime<Utc>>,
    last_run: Option<Run>,
    /// 每項最近一次失敗。/ The latest failure per item.
    failures: HashMap<&'static str, (DateTime<Utc>, String)>,
    /// 自動更新上次說過的錯誤（同一個不再說）。/ The automatic error already announced.
    notified_error: Option<String>,
}

/// 檔案的「指紋」：大小 + 修改時間。/ A file's signature: size + mtime.
type Signature = Vec<(String, u64, Option<SystemTime>)>;

fn signature(dir: &Path, names: &[&str]) -> Signature {
    names
        .iter()
        .filter_map(|n| std::fs::metadata(dir.join(n)).ok().filter(|m| m.is_file()).map(|m| (n.to_string(), m.len(), m.modified().ok())))
        .collect()
}

fn geoip_names() -> Vec<&'static str> {
    crate::geoip::FILES.to_vec()
}

/// 標記「正在更新」；drop 時放掉。/ Marks an update as running; released on drop.
pub struct Busy<'a>(&'a AtomicBool);

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub struct Datasets {
    geoip_dir: PathBuf,
    oui_dir: PathBuf,
    http: reqwest::Client,
    sources: Mutex<Sources>,
    status: Mutex<Status>,
    updating: AtomicBool,
    /// 後端讀進來的檔案指紋：(GeoIP, OUI)。/ The signatures of what the backend has loaded: (GeoIP, OUI).
    loaded: Mutex<(Signature, Signature)>,
}

impl Datasets {
    pub fn new(geoip_dir: PathBuf, oui_dir: PathBuf) -> Self {
        let loaded = (signature(&geoip_dir, &geoip_names()), signature(&oui_dir, &[crate::oui::FILE]));
        Self {
            geoip_dir,
            oui_dir,
            http: client().expect("reqwest client"),
            sources: Mutex::new(Sources::default()),
            status: Mutex::new(Status::default()),
            updating: AtomicBool::new(false),
            loaded: Mutex::new(loaded),
        }
    }

    /// 測試：下載來源指到假的伺服器。/ Tests: point the downloads at a fake server.
    pub fn set_sources(&self, sources: Sources) {
        *self.sources.lock().unwrap() = sources;
    }

    /// 開始一次更新；已經有一次在跑 = None。/ Start an update; None while one is running.
    pub fn begin(&self) -> Option<Busy<'_>> {
        self.updating.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok().map(|_| Busy(&self.updating))
    }

    /// 自動更新到期了嗎（從沒看過，或上次看超過一天）。/ Whether the automatic check is due.
    pub fn check_due(&self, now: DateTime<Utc>) -> bool {
        match self.status.lock().unwrap().checked_at {
            None => true,
            // 上次檢查比 `now` 還晚（剛手動更新過、時鐘往回調）= 還沒到。/ Checked after `now` = not due yet.
            Some(at) => now.signed_duration_since(at).to_std().is_ok_and(|d| d >= CHECK_EVERY),
        }
    }

    fn mark_checked(&self, now: DateTime<Utc>) {
        self.status.lock().unwrap().checked_at = Some(now);
    }

    pub fn items(&self, geoip: &GeoIp, oui: &Oui, now: DateTime<Utc>) -> Vec<Item> {
        inspect(&self.geoip_dir, &self.oui_dir, geoip, oui, now)
    }

    /// 檔案換了（自動更新、子指令、手動放的）就重讀；回有沒有重讀。/ Reload whatever changed on disk; whether anything did.
    pub fn pick_up_changes(&self, geoip: &GeoIp, oui: &Oui) -> bool {
        let g = signature(&self.geoip_dir, &geoip_names());
        let o = signature(&self.oui_dir, &[crate::oui::FILE]);
        let mut loaded = self.loaded.lock().unwrap();
        let mut changed = false;
        if g != loaded.0 {
            geoip.reload(&self.geoip_dir);
            tracing::info!(dir = %self.geoip_dir.display(), "geoip databases reloaded");
            loaded.0 = g;
            changed = true;
        }
        if o != loaded.1 {
            oui.reload(&self.oui_dir);
            tracing::info!(dir = %self.oui_dir.display(), "OUI vendor table reloaded");
            loaded.1 = o;
            changed = true;
        }
        changed
    }

    /// 更新 `wanted` 這幾項（DB-IP：抓比裝的新的那個月；廠商表：重抓）。/ Update the given items.
    pub async fn update(&self, wanted: &[&'static str], trigger: Trigger, by: Option<(i64, String)>, geoip: &GeoIp, oui: &Oui, now: DateTime<Utc>) -> Run {
        let sources = self.sources.lock().unwrap().clone();
        let items = self.items(geoip, oui, now);
        let mut run = Run { at: now, trigger, by: by.as_ref().map(|b| b.1.clone()), by_id: by.map(|b| b.0), items: vec![] };
        for id in ITEMS.into_iter().filter(|i| wanted.contains(i)) {
            let item = items.iter().find(|i| i.id == id);
            let outcome = if id == "oui" {
                let from = item.and_then(|i| i.modified).map(|m| m.format("%Y-%m-%d").to_string());
                match fetch_oui_at(&self.http, &sources.oui, &self.oui_dir).await {
                    Ok(_) => Outcome::Updated { from, to: now.format("%Y-%m-%d").to_string() },
                    Err(e) => Outcome::Failed(format!("{e:#}")),
                }
            } else {
                let installed = item.filter(|i| i.present).and_then(|i| i.release.clone());
                fetch_dbip(&self.http, &sources.dbip, &self.geoip_dir, id, now.date_naive(), installed.as_deref()).await
            };
            let mut status = self.status.lock().unwrap();
            run.items.push(match outcome {
                Outcome::Updated { from, to } => {
                    status.failures.remove(id);
                    RunItem { id, outcome: "updated", from, to: Some(to), error: None }
                }
                Outcome::Current => {
                    status.failures.remove(id);
                    RunItem { id, outcome: "current", from: None, to: None, error: None }
                }
                Outcome::Failed(e) => {
                    status.failures.insert(id, (now, e.clone()));
                    RunItem { id, outcome: "failed", from: None, to: None, error: Some(e) }
                }
            });
        }
        let mut status = self.status.lock().unwrap();
        status.checked_at = Some(now);
        status.last_run = Some(run.clone());
        run
    }

    /// 這個錯誤還沒說過嗎（說過就記下）；成功時清掉。/ Whether this automatic-update error is new (and remember it).
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
    pub fn view(&self, geoip: &GeoIp, oui: &Oui) -> Value {
        let now = Utc::now();
        let items = self.items(geoip, oui, now);
        let s = self.status.lock().unwrap();
        let sources = self.sources.lock().unwrap().clone();
        let items: Vec<Value> = items
            .into_iter()
            .map(|i| {
                let failure = s.failures.get(i.id).map(|(at, e)| json!({ "at": at, "error": e }));
                let mut v = serde_json::to_value(&i).unwrap_or(Value::Null);
                v["failure"] = failure.unwrap_or(Value::Null);
                v
            })
            .collect();
        json!({
            "items": items,
            "geoip_dir": self.geoip_dir.display().to_string(),
            "oui_dir": self.oui_dir.display().to_string(),
            "sources": { "dbip": sources.dbip, "oui": sources.oui },
            "checked_at": s.checked_at,
            "next_check_at": s.checked_at.map(|at| at + chrono::Duration::from_std(CHECK_EVERY).unwrap_or_default()),
            "updating": self.updating.load(Ordering::SeqCst),
            "last_run": s.last_run,
            "attribution": ATTRIBUTION,
            "refresh_days": OUI_REFRESH_DAYS,
        })
    }
}

/// 背景：啟動三分鐘後第一次看，之後每小時醒一次——檔案換了就重讀，自動更新到期就去看。
/// Background: first look three minutes after start, then hourly — reload changed files, run the automatic update when due.
pub async fn run(state: AppState) {
    tokio::time::sleep(FIRST_LOOK_AFTER).await;
    let mut tick = tokio::time::interval(LOOP_EVERY);
    loop {
        tick.tick().await;
        state.datasets.pick_up_changes(&state.geoip, &state.oui);
        let _ = auto_update_once(&state, Utc::now()).await;
    }
}

/// 自動更新一輪：設定開著、到了該看的時間 → 舊了的（裝過的才算）抓新的、重讀、記稽核事件。回這一輪做了什麼（None = 沒做）。
/// One automatic round: with the setting on and the check due, fetch what is outdated (installed items only), reload,
/// and write an audit event. Returns what the round did (None = nothing).
pub async fn auto_update_once(state: &AppState, now: DateTime<Utc>) -> Option<Run> {
    let on = crate::db::settings::get_solo(&state.db).await.map(|s| s.datasets_auto_update).unwrap_or(true);
    let d = &state.datasets;
    if !on || !d.check_due(now) {
        return None;
    }
    let due: Vec<&'static str> = d.items(&state.geoip, &state.oui, now).into_iter().filter(|i| i.due).map(|i| i.id).collect();
    if due.is_empty() {
        d.mark_checked(now);
        return None;
    }
    let _busy = d.begin()?;
    let run = d.update(&due, Trigger::Auto, None, &state.geoip, &state.oui, now).await;
    d.pick_up_changes(&state.geoip, &state.oui);
    let failure = run.failure();
    // 同一個失敗只說一次；換上新的一定說。/ A repeated failure is said once; an update is always said.
    let say = !run.updated().is_empty() || d.first_time(failure.as_deref());
    if failure.is_none() {
        d.first_time(None);
    }
    if say {
        announce(state, &run).await;
    }
    Some(run)
}

/// 一項的名字（稽核事件用）。/ An item's name for the audit event.
fn item_name(id: &str) -> &'static str {
    match id {
        "country" => "DB-IP country",
        "asn" => "DB-IP ASN",
        _ => "IEEE vendor table",
    }
}

/// 稽核事件：換上了什麼、哪裡失敗。/ Audit events: what was replaced and what failed.
pub async fn announce(state: &AppState, run: &Run) {
    let who = match &run.by {
        Some(b) => format!("by {b}"),
        None => "automatically".to_string(),
    };
    let updated = run.updated();
    if !updated.is_empty() {
        let list = updated
            .iter()
            .map(|i| match &i.from {
                Some(f) => format!("{} {f} → {}", item_name(i.id), i.to.as_deref().unwrap_or("")),
                None => format!("{} {}", item_name(i.id), i.to.as_deref().unwrap_or("")),
            })
            .collect::<Vec<_>>()
            .join(", ");
        state.gateway.event("datasets_updated", None, None, None, format!("IP and vendor data updated {who}: {list}")).await;
    }
    if let Some(why) = run.failure() {
        state.gateway.event("datasets_update_failed", None, None, None, format!("IP and vendor data update {who} failed: {why}")).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    #[test]
    fn this_month_and_the_previous_one() {
        assert_eq!(months(day(2026, 11, 1)), ["2026-11".to_string(), "2026-10".to_string()]);
        assert_eq!(months(day(2027, 1, 15)), ["2027-01".to_string(), "2026-12".to_string()]);
        assert_eq!(dbip_url("country", "2026-11"), "https://download.db-ip.com/free/dbip-country-lite-2026-11.mmdb.gz");
        assert_eq!(dbip_url_at("http://127.0.0.1:9/free/", "asn", "2026-11"), "http://127.0.0.1:9/free/dbip-asn-lite-2026-11.mmdb.gz");
        assert_eq!(geoip_file("asn"), "dbip-asn-lite.mmdb");
        assert_eq!(release_file("asn"), "dbip-asn-lite.mmdb.release");
    }

    #[test]
    fn which_months_to_try_and_when_db_ip_is_due() {
        let nov = day(2026, 11, 2);
        assert_eq!(dbip_candidates(nov, None), ["2026-11", "2026-10"], "nothing installed: this month, else the last");
        assert_eq!(dbip_candidates(nov, Some("2026-10")), ["2026-11"], "never fetch the month that is already there");
        assert!(dbip_candidates(nov, Some("2026-11")).is_empty());
        assert_eq!(dbip_candidates(nov, Some("2026-07")), ["2026-11", "2026-10"]);
        assert!(dbip_due(true, Some("2026-10"), nov));
        assert!(dbip_due(true, None, nov), "a file of unknown month is refreshed");
        assert!(!dbip_due(true, Some("2026-11"), nov));
        assert!(!dbip_due(false, None, nov), "never installed = never downloaded on its own");
        assert_eq!(month_of(at("2026-10-01T03:00:00Z")), "2026-10");
        assert!(is_month("2026-11") && !is_month("2026-1") && !is_month("2026/11") && !is_month("garbage"));
    }

    #[test]
    fn the_vendor_table_is_due_after_thirty_days() {
        let now = at("2026-11-30T00:00:00Z");
        assert!(!oui_due(true, Some(at("2026-11-01T00:00:00Z")), now));
        assert!(oui_due(true, Some(at("2026-10-31T00:00:00Z")), now));
        assert!(oui_due(true, None, now));
        assert!(!oui_due(false, None, now));
    }

    #[test]
    fn freshness_for_doctor() {
        let dir = Path::new("/data/geoip");
        let now = at("2026-11-02T00:00:00Z");
        let fresh = InUse { file: "dbip-country-lite.mmdb", source: "DB-IP", built: Some(at("2026-10-01T00:00:00Z")) };
        let old = InUse { file: "dbip-asn-lite.mmdb", source: "DB-IP", built: Some(at("2026-07-01T00:00:00Z")) };
        assert_eq!(geoip_freshness(None, None, (None, None), dir, now), Freshness::Missing);
        assert_eq!(geoip_freshness(Some(&fresh), Some(&fresh), (Some("2026-10"), Some("2026-10")), dir, now), Freshness::Fresh("DB-IP country 2026-10 + DB-IP ASN 2026-10 in /data/geoip".into()));
        match geoip_freshness(Some(&fresh), Some(&old), (Some("2026-10"), None), dir, now) {
            Freshness::Stale(d, fp) => {
                assert!(d.contains("DB-IP ASN 2026-07-01") && d.contains("124 days ago"), "{d}");
                assert_eq!(fp, "2026-07-01", "the fingerprint follows the data, not the day count");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(oui_freshness(0, None, dir, now), Freshness::Missing);
        assert!(matches!(oui_freshness(3, Some(at("2026-10-30T00:00:00Z")), dir, now), Freshness::Fresh(d) if d.contains("downloaded 2026-10-30")));
        assert!(matches!(oui_freshness(3, Some(at("2026-05-01T00:00:00Z")), dir, now), Freshness::Stale(..)));
    }

    #[test]
    fn gunzip_round_trip_and_atomic_write() {
        use std::io::Write;
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        enc.write_all(b"hello mmdb").unwrap();
        let gz = enc.finish().unwrap();
        assert_eq!(gunzip(&gz).unwrap(), b"hello mmdb");
        assert!(gunzip(b"not gzip").is_err());
        let dir = tempfile::tempdir().unwrap();
        let dest = write_atomic(&dir.path().join("geoip"), "a.mmdb", b"x").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"x");
        assert!(!dir.path().join("geoip/.a.mmdb.tmp").exists());
    }

    #[test]
    fn a_release_file_must_hold_a_month() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_release(dir.path(), "country"), None);
        std::fs::write(dir.path().join(release_file("country")), "2026-11\n").unwrap();
        assert_eq!(read_release(dir.path(), "country").as_deref(), Some("2026-11"));
        std::fs::write(dir.path().join(release_file("asn")), "not a month").unwrap();
        assert_eq!(read_release(dir.path(), "asn"), None);
    }
}
