//! 一次性下載連結：讓瀏覽器**自己**下載（直接寫到磁碟、有自己的進度列），而不是 `fetch` 整個檔案進記憶體再存檔。
//!
//! 網頁的登入在 localStorage，瀏覽器自己發的請求帶不了 `Authorization`。所以網頁先用登入呼叫
//! `POST /api/sftp/download-link/…`（檢查權限、step-up、路徑），拿到一個 60 秒、只能用一次的連結，再讓瀏覽器打開
//! `GET /api/sftp/fetch/<token>`；打開時再檢查一次權限。連結只在記憶體裡（重啟就沒了）。
//!
//! One-time download links so the browser downloads natively (straight to disk, with its own progress) instead of
//! fetching the whole file into memory. The web sign-in lives in localStorage, so the page mints a 60-second
//! single-use link with its bearer token (access, step-up and paths checked) and the browser opens
//! `GET /api/sftp/fetch/<token>`, where access is checked again. Links live in memory only.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 連結多久內要打開。/ How long a link stays valid.
pub const TTL: Duration = Duration::from_secs(60);
/// 每個人同時最多幾條沒用掉的連結（多的丟最舊的）。/ Unused links kept per person (the oldest goes).
pub const MAX_PER_USER: usize = 20;

/// 一條連結要下載的東西。/ What one link downloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub user_id: i64,
    pub tunnel_id: i64,
    pub username: String,
    /// 已解析的 SFTP 路徑。/ Resolved SFTP paths.
    pub paths: Vec<String>,
    /// 一個資料夾或好幾個東西 = zip；一個檔案 = 檔案本身。/ Zip for a folder or several paths; else the file itself.
    pub zip: bool,
    /// 存檔的名字（zip 含 `.zip`）。/ The file name to save as (`.zip` included).
    pub name: String,
}

#[derive(Default)]
pub struct DownloadLinks {
    inner: Mutex<HashMap<String, (Link, Instant)>>,
}

impl DownloadLinks {
    /// 發一條連結，回 token。/ Issue a link; returns its token.
    pub fn issue(&self, link: Link) -> String {
        self.issue_at(link, Instant::now())
    }

    fn issue_at(&self, link: Link, now: Instant) -> String {
        let token = format!("tpd_{}", crate::util::random_alnum(32));
        let mut map = self.inner.lock().unwrap();
        map.retain(|_, (_, at)| now.duration_since(*at) < TTL);
        let mine: Vec<(String, Instant)> = map.iter().filter(|(_, (l, _))| l.user_id == link.user_id).map(|(k, (_, at))| (k.clone(), *at)).collect();
        if mine.len() >= MAX_PER_USER {
            if let Some((oldest, _)) = mine.into_iter().min_by_key(|(_, at)| *at) {
                map.remove(&oldest);
            }
        }
        map.insert(token.clone(), (link, now));
        token
    }

    /// 用掉一條連結（只能一次；過期 = None）。/ Use a link up (once; expired = None).
    pub fn take(&self, token: &str) -> Option<Link> {
        self.take_at(token, Instant::now())
    }

    fn take_at(&self, token: &str, now: Instant) -> Option<Link> {
        let (link, at) = self.inner.lock().unwrap().remove(token)?;
        (now.duration_since(at) < TTL).then_some(link)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(user_id: i64) -> Link {
        Link { user_id, tunnel_id: 1, username: "u".into(), paths: vec!["/x".into()], zip: false, name: "x".into() }
    }

    #[test]
    fn links_are_single_use_and_expire() {
        let links = DownloadLinks::default();
        let now = Instant::now();
        let t = links.issue_at(link(1), now);
        assert!(t.starts_with("tpd_") && t.len() == 36);
        assert_eq!(links.take_at(&t, now), Some(link(1)));
        assert_eq!(links.take_at(&t, now), None, "only once");
        let late = links.issue_at(link(1), now);
        assert_eq!(links.take_at(&late, now + TTL), None, "expired");
        assert_eq!(links.take_at("tpd_nope", now), None);
    }

    #[test]
    fn each_person_keeps_a_bounded_number() {
        let links = DownloadLinks::default();
        let now = Instant::now();
        let first = links.issue_at(link(1), now);
        let mut last = String::new();
        for i in 1..=MAX_PER_USER {
            last = links.issue_at(link(1), now + Duration::from_millis(i as u64));
        }
        let other = links.issue_at(link(2), now);
        assert_eq!(links.take_at(&first, now), None, "the oldest went");
        assert!(links.take_at(&last, now + Duration::from_secs(1)).is_some());
        assert!(links.take_at(&other, now).is_some(), "someone else's are untouched");
    }
}
