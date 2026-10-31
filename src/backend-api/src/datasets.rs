//! `telepy-server geoip` / `telepy-server oui`：把後端讀的離線資料下載到它自己的目錄——DB-IP Lite（國家 + ASN，CC BY 4.0）
//! 到 `GEOIP_DIR`、IEEE 的 OUI 表到 `OUI_DIR`。以前是主機上的 `telepy.sh geoip / oui` 用 curl 下載到 `./telepy-data`；現在在
//! 容器裡跑（`docker compose exec backend telepy-server geoip`），路徑直接就是後端讀的那個。檔案先寫到旁邊的暫存檔、檢查
//! 過（mmdb 能開、csv 的表頭對）才改名，後端重啟時才會讀到。查詢完全在本機；這裡是唯一會連外的地方，而且只在被叫到時。
//!
//! Downloads of the offline datasets the backend reads: DB-IP Lite (country + ASN) into `GEOIP_DIR` and IEEE's OUI
//! registry into `OUI_DIR`. They run inside the container, so the destination is exactly the folder the backend reads.
//! Each file is written beside its destination, checked (the mmdb opens, the csv header matches) and renamed into place;
//! the backend picks it up on its next start.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use chrono::{Datelike, NaiveDate};

pub const DBIP_BASE: &str = "https://download.db-ip.com/free";
pub const OUI_URL: &str = "https://standards-oui.ieee.org/oui/oui.csv";
/// DB-IP 的兩個免費資料庫。/ The two free DB-IP databases.
pub const GEOIP_KINDS: [&str; 2] = ["country", "asn"];
pub const ATTRIBUTION: &str = "IP geolocation by DB-IP (https://db-ip.com), CC BY 4.0. Re-run monthly for fresh data.";

/// `https://download.db-ip.com/free/dbip-country-lite-2026-11.mmdb.gz`
pub fn dbip_url(kind: &str, month: &str) -> String {
    format!("{DBIP_BASE}/dbip-{kind}-lite-{month}.mmdb.gz")
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

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder().timeout(Duration::from_secs(180)).user_agent("telepy-server").build().context("http client")
}

async fn download(client: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    let r = client.get(url).send().await.with_context(|| format!("GET {url}"))?;
    if !r.status().is_success() {
        bail!("{url}: HTTP {}", r.status());
    }
    Ok(r.bytes().await.with_context(|| format!("reading {url}"))?.to_vec())
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

/// 下載兩個 DB-IP Lite 資料庫；回每一個的結果行。有一個失敗就整體 Err（另一個照樣寫好）。
/// Fetch both DB-IP Lite databases; one line per database. Any failure = Err after the others were written.
pub async fn fetch_geoip(dir: &Path, today: NaiveDate) -> Result<Vec<String>> {
    let client = client()?;
    let mut lines = Vec::new();
    let mut errors = Vec::new();
    for kind in GEOIP_KINDS {
        let mut done = false;
        let mut why = Vec::new();
        for month in months(today) {
            let url = dbip_url(kind, &month);
            match download(&client, &url).await.and_then(|gz| gunzip(&gz)) {
                Ok(mmdb) => {
                    if let Err(e) = maxminddb::Reader::from_source(mmdb.clone()) {
                        why.push(format!("{url}: not a readable mmdb ({e})"));
                        continue;
                    }
                    let dest = write_atomic(dir, &geoip_file(kind), &mmdb)?;
                    lines.push(format!("{kind}: {month} → {}", dest.display()));
                    done = true;
                    break;
                }
                Err(e) => why.push(format!("{e:#}")),
            }
        }
        if !done {
            errors.push(format!("{kind}: {}", why.join("; ")));
        }
    }
    if !errors.is_empty() {
        bail!("{}", errors.join("\n"));
    }
    Ok(lines)
}

/// IEEE 的表頭。/ The header IEEE's csv starts with.
pub const OUI_HEADER: &str = "Registry,Assignment";

/// 下載 IEEE 的 OUI 表；回「N vendors → path」。/ Fetch IEEE's registry; "N vendors → path".
pub async fn fetch_oui(dir: &Path) -> Result<String> {
    let client = client()?;
    let csv = download(&client, OUI_URL).await?;
    let text = String::from_utf8_lossy(&csv);
    if !text.starts_with(OUI_HEADER) {
        bail!("{OUI_URL}: unexpected content (no '{OUI_HEADER}' header)");
    }
    let vendors = text.lines().count().saturating_sub(1);
    let dest = write_atomic(dir, crate::oui::FILE, &csv)?;
    Ok(format!("{vendors} vendors → {}", dest.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_month_and_the_previous_one() {
        assert_eq!(months(NaiveDate::from_ymd_opt(2026, 11, 1).unwrap()), ["2026-11".to_string(), "2026-10".to_string()]);
        assert_eq!(months(NaiveDate::from_ymd_opt(2027, 1, 15).unwrap()), ["2027-01".to_string(), "2026-12".to_string()]);
        assert_eq!(dbip_url("country", "2026-11"), "https://download.db-ip.com/free/dbip-country-lite-2026-11.mmdb.gz");
        assert_eq!(geoip_file("asn"), "dbip-asn-lite.mmdb");
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
}
