//! 更新：發行版一天最多問一次 GitHub 最新的 Telepy 發行版（背景、短逾時），有新版就在指令結束後印一行提示；
//! `telepy update` 下載這個平台的檔案、對 `SHA256SUMS`、換掉自己（先留備份、跑一次新的 `--version`，不行就換回來）。
//! 版號就是 Telepy 發行版的 tag（CLI 跟伺服器同一個版號，見 `crate::VERSION`）。
//! Updates: a release build asks GitHub for the latest Telepy release at most once a day (in the background, short
//! timeout) and prints one line after the command when it is newer; `telepy update` downloads this platform's
//! archive, checks it against `SHA256SUMS` and replaces itself (a backup first, then the new binary's `--version`,
//! rolled back when that fails). The version is the Telepy release tag (the CLI shares it, see `crate::VERSION`).

use std::io::{IsTerminal, Read};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::VERSION;

/// 發行版的網址（`<這裡>/latest`、`<這裡>/download/<tag>/<檔名>`）；`TELEPY_RELEASES_URL` 可換成鏡像。
/// Where releases live (`<this>/latest`, `<this>/download/<tag>/<file>`); `TELEPY_RELEASES_URL` points at a mirror.
pub const RELEASES: &str = "https://github.com/NatLee/telepy/releases";
/// 多久問一次。/ How often to ask.
pub const CHECK_EVERY: i64 = 24 * 3600;
/// 背景檢查的逾時；指令結束後最多再等這麼久。/ The background check's timeout, and the most a command waits for it.
const CHECK_TIMEOUT: Duration = Duration::from_secs(2);
const WAIT_AT_EXIT: Duration = Duration::from_millis(1200);

pub fn releases_url() -> String {
    std::env::var("TELEPY_RELEASES_URL").ok().map(|s| s.trim().trim_end_matches('/').to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| RELEASES.to_string())
}

/// 這個平台的發行檔名稱（跟 `.github/workflows/release-cli.yml` 的矩陣一樣）；沒有預編的平台 = None。
/// This platform's release target (the matrix of `.github/workflows/release-cli.yml`); None = no prebuilt binary.
pub fn target() -> Option<&'static str> {
    target_for(std::env::consts::OS, std::env::consts::ARCH)
}

pub fn target_for(os: &str, arch: &str) -> Option<&'static str> {
    Some(match (os, arch) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("linux", "x86_64") => "x86_64-unknown-linux-musl",
        ("linux", "aarch64") => "aarch64-unknown-linux-musl",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        _ => return None,
    })
}

/// `telepy-<target>.tar.gz`，Windows 是 `.zip`。/ The archive name; `.zip` on Windows.
pub fn archive_name(target: &str) -> String {
    if target.contains("windows") {
        format!("telepy-{target}.zip")
    } else {
        format!("telepy-{target}.tar.gz")
    }
}

/// `v2.9.0` / `2.9.0` / `cli-v0.1.0` / `2.9.0-rc.1+abc` → (2, 9, 0)。看不懂 = None。/ Parse a version or tag.
pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.trim();
    let s = s.strip_prefix("cli-").unwrap_or(s);
    let s = s.strip_prefix('v').unwrap_or(s);
    let core = s.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let v = (parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next().unwrap_or("0").parse().ok()?);
    parts.next().is_none().then_some(v)
}

/// `latest` 比 `current` 新嗎（看不懂的一律不算新）。/ Whether `latest` is newer (unparsable = no).
pub fn newer(latest: &str, current: &str) -> bool {
    matches!((parse_version(latest), parse_version(current)), (Some(l), Some(c)) if l > c)
}

/// tag → `telepy --version` 印的版號（去掉 `v`）。/ A tag → the version `telepy --version` prints.
pub fn plain(tag: &str) -> &str {
    tag.trim().strip_prefix('v').unwrap_or(tag.trim())
}

/// 發行版編的（CI 帶了 `TELEPY_VERSION`，而且不是試編）才自己檢查更新；自己編的不吵。
/// Only release builds (CI stamped `TELEPY_VERSION`, not a trial build) check on their own; local builds stay quiet.
pub fn release_build() -> bool {
    option_env!("TELEPY_VERSION").is_some() && !VERSION.contains("dev")
}

/// `…/releases/tag/v2.9.0` → `v2.9.0`（GitHub 的 `/releases/latest` 轉址到這裡）。/ The tag GitHub's `/latest` redirects to.
pub fn tag_from_location(location: &str) -> Option<String> {
    let path = location.split(['?', '#']).next()?;
    let (_, tag) = path.rsplit_once("/tag/")?;
    let tag = urlencoding::decode(tag.trim_end_matches('/')).ok()?.into_owned();
    (!tag.is_empty() && !tag.contains('/')).then_some(tag)
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
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// 從發行檔裡拿出 `telepy`（Windows：`telepy.exe`）。/ Take `telepy` (`telepy.exe` on Windows) out of a release archive.
pub fn extract_binary(archive: &[u8], archive_name: &str) -> Result<Vec<u8>> {
    if archive_name.ends_with(".zip") {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive)).context("read the zip archive")?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i)?;
            if entry.is_file() && is_binary_name(entry.name()) {
                let mut out = Vec::new();
                entry.read_to_end(&mut out)?;
                return Ok(out);
            }
        }
    } else {
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive));
        for entry in tar.entries().context("read the tar.gz archive")? {
            let mut entry = entry?;
            let name = entry.path()?.to_string_lossy().into_owned();
            if entry.header().entry_type().is_file() && is_binary_name(&name) {
                let mut out = Vec::new();
                entry.read_to_end(&mut out)?;
                return Ok(out);
            }
        }
    }
    bail!("{archive_name} has no telepy binary in it")
}

fn is_binary_name(name: &str) -> bool {
    let base = name.trim_start_matches("./").rsplit('/').next().unwrap_or(name);
    base == "telepy" || base == "telepy.exe"
}

// ---------------------------------------------------------------- the once-a-day check

/// 設定目錄裡的 `update-check.json`。/ `update-check.json` in the config directory.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cache {
    pub checked_at: i64,
    /// 那時最新的 tag（`v2.9.0`）。/ The latest tag then.
    pub latest: String,
}

fn cache_path() -> PathBuf {
    crate::creds::config_dir().join("update-check.json")
}

pub fn read_cache() -> Option<Cache> {
    serde_json::from_slice(&std::fs::read(cache_path()).ok()?).ok()
}

pub fn write_cache(c: &Cache) {
    let path = cache_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, serde_json::to_vec(c).unwrap_or_default());
}

/// 這次要不要問（純函式）：發行版、stderr 是終端機、不在 CI、沒關掉、上次問是一天以前。
/// Whether to ask this time (pure): a release build, stderr a terminal, not CI, not turned off, last asked a day ago.
pub fn due(now: i64, cache: Option<&Cache>, release: bool, terminal: bool, ci: bool, off: bool) -> bool {
    release && terminal && !ci && !off && cache.is_none_or(|c| now - c.checked_at >= CHECK_EVERY || c.checked_at > now)
}

/// 提示的那一行（有新版才有）。/ The notice line, only when there is something newer.
pub fn notice(current: &str, latest: &str) -> Option<String> {
    newer(latest, current).then(|| format!("telepy {} is out (you have {current}): run `telepy update`. Turn this off with TELEPY_NO_UPDATE_CHECK=1.", plain(latest)))
}

fn env_on(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| !v.is_empty() && v != "0" && !v.eq_ignore_ascii_case("false"))
}

/// 背景檢查。/ The background check.
pub struct Background {
    rx: mpsc::Receiver<Option<String>>,
}

/// 該問就開一條執行緒去問（不擋指令）。/ Start the check on a thread when it is due (never blocks the command).
pub fn start() -> Option<Background> {
    let due = due(crate::now(), read_cache().as_ref(), release_build(), std::io::stderr().is_terminal(), env_on("CI"), env_on("TELEPY_NO_UPDATE_CHECK"));
    if !due {
        return None;
    }
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let latest = latest_tag(CHECK_TIMEOUT).ok();
        // 問不到也記下時間：離線時不要每個指令都再試。/ Record the attempt even offline, so it isn't retried every command.
        let latest_str = latest.clone().unwrap_or_else(|| read_cache().map(|c| c.latest).unwrap_or_default());
        write_cache(&Cache { checked_at: crate::now(), latest: latest_str });
        let _ = tx.send(latest);
    });
    Some(Background { rx })
}

/// 指令結束：等一下背景檢查，有新版就在 stderr 印一行。/ After the command: wait briefly, then the one-line notice.
pub fn finish(bg: Option<Background>) {
    if let Some(bg) = bg {
        if let Ok(Some(latest)) = bg.rx.recv_timeout(WAIT_AT_EXIT) {
            if let Some(line) = notice(VERSION, &latest) {
                eprintln!("\n{line}");
            }
        }
    }
}

// ---------------------------------------------------------------- talking to the releases

fn client(timeout: Duration) -> Result<reqwest::blocking::Client> {
    Ok(reqwest::blocking::Client::builder().user_agent(crate::api::user_agent()).timeout(timeout).redirect(reqwest::redirect::Policy::none()).build()?)
}

/// 最新的發行版 tag：`<releases>/latest` 轉址到 `…/tag/<tag>`（不用 GitHub API，沒有次數限制）。
/// The latest release tag: `<releases>/latest` redirects to `…/tag/<tag>` (no GitHub API, so no rate limit).
pub fn latest_tag(timeout: Duration) -> Result<String> {
    let url = format!("{}/latest", releases_url());
    let res = client(timeout)?.get(&url).send().with_context(|| format!("cannot reach {url}"))?;
    let location = res.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).map(str::to_string);
    match location.as_deref().and_then(tag_from_location) {
        Some(tag) => Ok(tag),
        None => bail!("{url} did not point at a release (HTTP {})", res.status().as_u16()),
    }
}

fn download(url: &str) -> Result<Vec<u8>> {
    // 下載要跟著轉址（GitHub 的檔案在別的主機）。/ Downloads follow redirects (GitHub serves files from another host).
    let http = reqwest::blocking::Client::builder().user_agent(crate::api::user_agent()).timeout(Duration::from_secs(300)).build()?;
    let res = http.get(url).send().with_context(|| format!("download {url}"))?;
    if !res.status().is_success() {
        bail!("download {url}: HTTP {}", res.status().as_u16());
    }
    Ok(res.bytes()?.to_vec())
}

/// 下載並檢查一個發行版的 binary。/ Download a release's binary and check it.
pub fn fetch_binary(tag: &str, target: &str) -> Result<Vec<u8>> {
    let base = format!("{}/download/{tag}", releases_url());
    let name = archive_name(target);
    let archive = download(&format!("{base}/{name}"))?;
    let sums = download(&format!("{base}/SHA256SUMS")).or_else(|_| download(&format!("{base}/{name}.sha256"))).context("the release has no checksums, so it can't be checked")?;
    let want = sum_for(&String::from_utf8_lossy(&sums), &name).ok_or_else(|| anyhow!("the release's checksums don't list {name}"))?;
    let got = sha256_hex(&archive);
    if got != want {
        bail!("{name} doesn't match its checksum (expected {want}, got {got}); nothing was changed");
    }
    extract_binary(&archive, &name)
}

// ---------------------------------------------------------------- replacing ourselves

/// 不是用發行檔裝的（cargo / Homebrew）就不自己換，說用什麼更新。/ Installs managed elsewhere say how to update instead.
pub fn managed_by(exe: &Path) -> Option<&'static str> {
    let p = exe.to_string_lossy().replace('\\', "/");
    if p.contains("/.cargo/bin/") {
        Some("cargo (run `cargo install` again)")
    } else if p.contains("/Cellar/") || p.contains("/homebrew/") || p.contains("/linuxbrew/") {
        Some("Homebrew (use `brew upgrade`)")
    } else {
        None
    }
}

fn sibling(exe: &Path, what: &str) -> PathBuf {
    let mut rnd = [0u8; 4];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut rnd);
    let tag: String = rnd.iter().map(|b| format!("{b:02x}")).collect();
    exe.with_file_name(format!(".telepy-{what}-{tag}"))
}

/// 換掉 `exe`：新檔寫在旁邊 → 舊的改名當備份 → 新的放上去 → 跑 `--version`；不行就換回來。回新 binary 印的版本。
/// Windows 可以改名正在跑的 exe，但刪不掉，所以備份留到下次（`clean_leftovers`）。
/// Replace `exe`: write the new file beside it → move the old one aside → put the new one in place → run
/// `--version`; on failure put the old one back. Returns what the new binary prints. Windows can rename a running
/// exe but not delete it, so the backup is left for next time (`clean_leftovers`).
pub fn replace(exe: &Path, bytes: &[u8]) -> Result<String> {
    let new = sibling(exe, "new");
    std::fs::write(&new, bytes).map_err(|e| writable_hint(exe, e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(exe).map(|m| m.permissions().mode() | 0o111).unwrap_or(0o755);
        std::fs::set_permissions(&new, std::fs::Permissions::from_mode(mode))?;
    }
    let old = sibling(exe, "old");
    if let Err(e) = std::fs::rename(exe, &old) {
        let _ = std::fs::remove_file(&new);
        return Err(writable_hint(exe, e));
    }
    if let Err(e) = std::fs::rename(&new, exe) {
        let _ = std::fs::rename(&old, exe);
        let _ = std::fs::remove_file(&new);
        return Err(writable_hint(exe, e));
    }
    let check = std::process::Command::new(exe).arg("--version").output();
    match check {
        Ok(out) if out.status.success() && String::from_utf8_lossy(&out.stdout).starts_with("telepy ") => {
            if !cfg!(windows) {
                let _ = std::fs::remove_file(&old);
            }
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
        other => {
            let _ = std::fs::remove_file(exe);
            let _ = std::fs::rename(&old, exe);
            let why = match other {
                Ok(out) => format!("it exited with {} ({})", out.status, String::from_utf8_lossy(&out.stderr).trim()),
                Err(e) => e.to_string(),
            };
            bail!("the new binary didn't start ({why}); kept the one you had")
        }
    }
}

fn writable_hint(exe: &Path, e: std::io::Error) -> anyhow::Error {
    let dir = exe.parent().map(|d| d.display().to_string()).unwrap_or_default();
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        let how = if cfg!(windows) { "run it from an administrator PowerShell" } else { "run `sudo telepy update`" };
        anyhow!("can't write to {dir} ({e}); {how}, or reinstall with the command on Telepy's CLI page")
    } else {
        anyhow!("can't replace {} ({e})", exe.display())
    }
}

/// 上次更新留下的 `.telepy-old-*` / `.telepy-new-*`（Windows 刪不掉正在跑的檔）。/ Leftovers of an earlier update.
pub fn clean_leftovers(exe: &Path) {
    let Some(dir) = exe.parent() else { return };
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with(".telepy-old-") || name.starts_with(".telepy-new-") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_and_tags() {
        assert_eq!(parse_version("v2.9.0"), Some((2, 9, 0)));
        assert_eq!(parse_version("2.10.1"), Some((2, 10, 1)));
        assert_eq!(parse_version("cli-v0.1.0"), Some((0, 1, 0)));
        assert_eq!(parse_version("2.9.0-rc.1+abc"), Some((2, 9, 0)));
        assert_eq!(parse_version("2.9"), Some((2, 9, 0)));
        assert_eq!(parse_version("nope"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
        assert!(newer("v2.10.0", "2.9.0"), "numbers, not strings");
        assert!(!newer("v2.9.0", "2.9.0"));
        assert!(!newer("v2.8.0", "2.9.0"));
        assert!(!newer("garbage", "2.9.0"));
        assert!(newer("v2.9.0", "0.1.0"), "a local build is older than any release");
        assert_eq!(plain("v2.9.0"), "2.9.0");
        assert_eq!(tag_from_location("https://github.com/NatLee/telepy/releases/tag/v2.9.0"), Some("v2.9.0".into()));
        assert_eq!(tag_from_location("/NatLee/telepy/releases/tag/v2.9.0?x=1"), Some("v2.9.0".into()));
        assert_eq!(tag_from_location("https://github.com/NatLee/telepy/releases"), None, "no release yet");
    }

    #[test]
    fn targets_follow_the_release_matrix() {
        let workflow = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.github/workflows/release-cli.yml")).unwrap();
        for (os, arch) in [("macos", "aarch64"), ("macos", "x86_64"), ("linux", "x86_64"), ("linux", "aarch64"), ("windows", "x86_64")] {
            let t = target_for(os, arch).unwrap();
            assert!(workflow.contains(&format!("target: {t}")), "{t} is built by the release workflow");
        }
        assert_eq!(target_for("freebsd", "x86_64"), None);
        assert_eq!(archive_name("x86_64-pc-windows-msvc"), "telepy-x86_64-pc-windows-msvc.zip");
        assert_eq!(archive_name("aarch64-apple-darwin"), "telepy-aarch64-apple-darwin.tar.gz");
    }

    #[test]
    fn checksums_and_archives() {
        let hash = "a".repeat(64);
        let sums = format!("{hash}  telepy-aarch64-apple-darwin.tar.gz\n{}  *telepy-x86_64-pc-windows-msvc.zip\n", "B".repeat(64));
        assert_eq!(sum_for(&sums, "telepy-aarch64-apple-darwin.tar.gz"), Some(hash));
        assert_eq!(sum_for(&sums, "telepy-x86_64-pc-windows-msvc.zip"), Some("b".repeat(64)));
        assert_eq!(sum_for(&sums, "telepy-other.tar.gz"), None);
        assert_eq!(sum_for("short  telepy-x.tar.gz", "telepy-x.tar.gz"), None);
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

        // 跟發行的打包方式一樣：binary + LICENSE + NOTICE。/ Packed like a release: the binary plus LICENSE and NOTICE.
        let mut tar_bytes = Vec::new();
        {
            let gz = flate2::write::GzEncoder::new(&mut tar_bytes, flate2::Compression::default());
            let mut b = tar::Builder::new(gz);
            for (name, data) in [("LICENSE", &b"agpl"[..]), ("telepy", &b"\x7fELF binary"[..]), ("NOTICE", &b"n"[..])] {
                let mut h = tar::Header::new_gnu();
                h.set_size(data.len() as u64);
                h.set_mode(0o755);
                h.set_cksum();
                b.append_data(&mut h, name, data).unwrap();
            }
            b.into_inner().unwrap().finish().unwrap();
        }
        assert_eq!(extract_binary(&tar_bytes, "telepy-aarch64-apple-darwin.tar.gz").unwrap(), b"\x7fELF binary");

        let mut zip_bytes = Vec::new();
        {
            let mut z = zip::ZipWriter::new(std::io::Cursor::new(&mut zip_bytes));
            let opts = zip::write::SimpleFileOptions::default();
            for (name, data) in [("LICENSE", &b"agpl"[..]), ("telepy.exe", &b"MZ binary"[..])] {
                z.start_file(name, opts).unwrap();
                std::io::Write::write_all(&mut z, data).unwrap();
            }
            z.finish().unwrap();
        }
        assert_eq!(extract_binary(&zip_bytes, "telepy-x86_64-pc-windows-msvc.zip").unwrap(), b"MZ binary");
        assert!(extract_binary(&zip_bytes[..10], "telepy-x86_64-pc-windows-msvc.zip").is_err());
    }

    #[test]
    fn when_to_ask_and_what_to_say() {
        let day = CHECK_EVERY;
        let fresh = Cache { checked_at: 1_000_000, latest: "v2.9.0".into() };
        assert!(due(1_000_000 + day, Some(&fresh), true, true, false, false), "a day later");
        assert!(!due(1_000_000 + day - 1, Some(&fresh), true, true, false, false), "not yet");
        assert!(due(5, None, true, true, false, false), "never asked");
        assert!(due(5, Some(&fresh), true, true, false, false), "a clock that went backwards asks again");
        assert!(!due(5, None, false, true, false, false), "local builds stay quiet");
        assert!(!due(5, None, true, false, false, false), "stderr not a terminal");
        assert!(!due(5, None, true, true, true, false), "CI");
        assert!(!due(5, None, true, true, false, true), "turned off");
        assert_eq!(notice("2.9.0", "v2.9.0"), None);
        assert_eq!(
            notice("2.8.0", "v2.9.0").as_deref(),
            Some("telepy 2.9.0 is out (you have 2.8.0): run `telepy update`. Turn this off with TELEPY_NO_UPDATE_CHECK=1.")
        );
        assert_eq!(managed_by(Path::new("/Users/a/.cargo/bin/telepy")), Some("cargo (run `cargo install` again)"));
        assert_eq!(managed_by(Path::new("/opt/homebrew/Cellar/telepy/2.9.0/bin/telepy")), Some("Homebrew (use `brew upgrade`)"));
        assert_eq!(managed_by(Path::new("/usr/local/bin/telepy")), None);
    }
}
