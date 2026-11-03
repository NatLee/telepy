//! 沒傳完的上傳：續傳與清理。
//!
//! 分段上傳把資料寫到目標旁邊的隱藏暫存檔（`.<name>.telepy-upload-<id>.part`），完成才改名成目標。分頁關掉、
//! 當機、斷網時暫存檔會留在裝置上，所以 Telepy 把**自己放的**每個暫存檔記在帳本（`db::upload_parts`）：
//! - **續傳**：同一個人、同一個目標、同一個本機檔案（名字 + 大小 + 修改時間）再上傳一次，就從裝置上已有的地方接著傳。
//!   接之前檢查兩件事：裝置上的暫存檔還在、大小合理（[`decide`]）；它最後 [`CHECK_LEN`] 位元組的 SHA-256 跟瀏覽器
//!   本機檔案同一段的一樣（不一樣 = 有人動過暫存檔、或本機檔案其實不同：刪掉從頭來）。
//! - **一次只有一個視窗寫**：開始 / 續傳時發一個 lease，每一段都要帶；另一個視窗在 [`BUSY_FOR`] 內有寫過就不給續傳
//!   （`upload_busy`），被接手的舊視窗下一段會拿到 `upload_taken`。不同的人永遠不會共用暫存檔（id 不同、帳本照人分）。
//! - **清理**：[`run`] 每 [`EVERY`] 看一次，閒置超過 [`RETENTION`] 的，裝置在線就刪掉帳上那個確切的路徑（還是一般檔案
//!   才刪；不是 Telepy 放的東西從不掃描、從不刪），記一筆 `files_upload_cleaned`；裝置一直不在線超過 [`GIVE_UP`]
//!   就只把帳本那筆拿掉。隧道刪掉時帳本跟著刪。
//!
//! Unfinished uploads: resuming and cleanup. Telepy records every part file it puts on a device. The same person
//! uploading the same local file (name + size + mtime) to the same target again continues from what the device has,
//! after checking the part file is still there and its last [`CHECK_LEN`] bytes hash like the same range of the local
//! file. One window writes at a time (a lease per start; a window active within [`BUSY_FOR`] is not taken over).
//! Different people never share a part file. Idle parts are removed after [`RETENTION`] when the device is online —
//! only the exact recorded path, only while it is still a regular file.

use std::time::Duration;

use chrono::{DateTime, Utc};

use crate::db::upload_parts::{self, PartRow};
use crate::state::AppState;
use crate::util::{db_time, parse_db_datetime};

/// 閒置多久就清掉。/ How long an unfinished upload is kept after its last activity.
pub const RETENTION: Duration = Duration::from_secs(24 * 3600);
/// 裝置一直不在線，多久之後只把帳本那筆拿掉。/ After this long offline, only the ledger entry goes.
pub const GIVE_UP: Duration = Duration::from_secs(30 * 24 * 3600);
/// 這麼久內有寫過 = 另一個視窗正在傳。/ Written within this = another window is uploading it now.
pub const BUSY_FOR: Duration = Duration::from_secs(30);
/// 寫一段的途中多久更新一次「還在寫」。/ How often a part being written refreshes its activity.
pub const HEARTBEAT: Duration = Duration::from_secs(10);
/// 續傳前比對的長度（暫存檔最後這麼多位元組）。/ Bytes compared before resuming (the end of the part file).
pub const CHECK_LEN: u64 = 64 * 1024;
/// 背景清理多久看一次。/ How often the cleanup looks.
pub const EVERY: Duration = Duration::from_secs(600);

/// 一筆未完成的上傳能不能接著傳。/ Whether an unfinished upload can be continued.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resume {
    /// 從 `offset` 接著傳；先比對 `[check_from, offset)`。/ Continue at `offset` after checking `[check_from, offset)`.
    Continue { offset: u64, check_from: u64 },
    /// 另一個視窗正在傳。/ Another window is uploading it right now.
    Busy,
    /// 暫存檔不見了、是空的或比檔案還大：帳本那筆（和還在的暫存檔）丟掉，從頭來。
    /// The part file is gone, empty or larger than the file: drop it and start over.
    Stale,
}

/// 決定（純函式）：`idle` = 離最後動作多久，`same_window` = 同一個 lease（自己的視窗回來接），`part_size` = 裝置上
/// 暫存檔現在的大小（沒有 = None），`total` = 檔案大小。
/// Decide from how long it has been idle, whether it's the same window, the part file's size on the device and the total.
pub fn decide(idle: Duration, same_window: bool, part_size: Option<u64>, total: u64) -> Resume {
    if idle < BUSY_FOR && !same_window {
        return Resume::Busy;
    }
    match part_size {
        Some(s) if s > 0 && s <= total => Resume::Continue { offset: s, check_from: s.saturating_sub(CHECK_LEN) },
        _ => Resume::Stale,
    }
}

/// 離 `at`（DB 時間）多久；讀不懂當成很久。/ Time since a DB timestamp; unreadable = long ago.
pub fn idle_for(at: &str, now: DateTime<Utc>) -> Duration {
    parse_db_datetime(at).map(|t| (now.naive_utc() - t).to_std().unwrap_or_default()).unwrap_or(GIVE_UP)
}

/// 清理時這一筆要怎麼辦（純函式）。/ What the cleanup does with an entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sweep {
    /// 還在保留期內。/ Still kept.
    Keep,
    /// 裝置在線：刪暫存檔與帳本。/ Device online: remove the file and the entry.
    Remove,
    /// 裝置不在線：等它回來。/ Device offline: wait for it.
    Wait,
    /// 不在線太久：只拿掉帳本。/ Offline too long: drop the entry only.
    Forget,
}

pub fn sweep(idle: Duration, online: bool) -> Sweep {
    match (idle >= RETENTION, online, idle >= GIVE_UP) {
        (false, _, _) => Sweep::Keep,
        (true, true, _) => Sweep::Remove,
        (true, false, true) => Sweep::Forget,
        (true, false, false) => Sweep::Wait,
    }
}

/// 背景清理：每 [`EVERY`] 一次（開機後先等一下，讓裝置連回來）。/ The cleanup loop.
pub async fn run(state: AppState) {
    tokio::time::sleep(Duration::from_secs(120)).await;
    loop {
        let n = reap_once(&state, Utc::now()).await;
        if n > 0 {
            tracing::info!(removed = n, "unfinished uploads cleaned");
        }
        tokio::time::sleep(EVERY).await;
    }
}

/// 一輪清理（`now` 給測試用）；回傳刪了幾個暫存檔。/ One pass (`now` for tests); returns how many part files went.
pub async fn reap_once(state: &AppState, now: DateTime<Utc>) -> usize {
    let before = db_time(now - chrono::Duration::from_std(RETENTION).unwrap_or_default());
    let Ok(rows) = upload_parts::idle_since(&state.db, &before, 200).await else { return 0 };
    let mut removed = 0;
    for row in rows {
        let Ok(Some(t)) = crate::db::tunnels::by_id(&state.db, row.tunnel_id).await else {
            let _ = upload_parts::remove(&state.db, row.id).await;
            continue;
        };
        let port = u16::try_from(t.reverse_port).unwrap_or(0);
        match sweep(idle_for(&row.updated_at, now), state.gateway.has_forward(port)) {
            Sweep::Keep | Sweep::Wait => {}
            Sweep::Forget => {
                tracing::info!(tunnel = t.id, part = %row.part_path, "unfinished upload: device offline too long, forgetting it");
                let _ = upload_parts::remove(&state.db, row.id).await;
            }
            Sweep::Remove => {
                if remove_part_file(state, t.reverse_port, &row).await {
                    removed += 1;
                    let msg = format!(
                        "Removed an unfinished upload of {} ({} of {} bytes) as {}, idle for {} h",
                        row.target,
                        row.received,
                        row.total,
                        row.username,
                        RETENTION.as_secs() / 3600
                    );
                    state.gateway.event("files_upload_cleaned", None, Some(port), Some(t.id), msg).await;
                }
            }
        }
    }
    removed
}

/// 刪帳上那個暫存檔：還是一般檔案才刪（被換成資料夾 / 連結就不碰），不見了也算處理完。成功處理就拿掉帳本那筆，
/// 回傳真的刪了檔案沒有。連不上裝置就保留帳本，下次再試。
/// Remove the recorded part file — only while it is still a regular file; already gone counts as done. The entry
/// goes once handled; returns whether a file was deleted. When the device can't be reached, the entry stays.
pub async fn remove_part_file(state: &AppState, reverse_port: i64, row: &PartRow) -> bool {
    use russh_sftp::client::error::Error as E;
    use russh_sftp::protocol::StatusCode;
    let Ok(sftp) = state.pool.sftp(state, reverse_port, &row.username).await else { return false };
    let deleted = match sftp.symlink_metadata(row.part_path.as_str()).await {
        Ok(m) if !m.is_dir() && !m.is_symlink() => sftp.remove_file(row.part_path.as_str()).await.is_ok(),
        Ok(_) => false,
        Err(E::Status(s)) if s.status_code == StatusCode::NoSuchFile => false,
        Err(_) => return false,
    };
    let _ = upload_parts::remove(&state.db, row.id).await;
    deleted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resuming_needs_an_idle_upload_and_a_sane_part_file() {
        let idle = Duration::from_secs(120);
        assert_eq!(decide(idle, false, Some(8_000_000), 20_000_000), Resume::Continue { offset: 8_000_000, check_from: 8_000_000 - CHECK_LEN });
        assert_eq!(decide(idle, false, Some(1000), 20_000_000), Resume::Continue { offset: 1000, check_from: 0 }, "a short part checks all of it");
        assert_eq!(decide(Duration::from_secs(5), false, Some(10), 20), Resume::Busy, "another window wrote just now");
        assert_eq!(decide(Duration::from_secs(5), true, Some(10), 20), Resume::Continue { offset: 10, check_from: 0 }, "the same window comes back");
        assert_eq!(decide(idle, false, None, 20), Resume::Stale, "the part file is gone");
        assert_eq!(decide(idle, false, Some(0), 20), Resume::Stale, "nothing to keep");
        assert_eq!(decide(idle, false, Some(21), 20), Resume::Stale, "larger than the file");
        assert_eq!(decide(idle, false, Some(20), 20), Resume::Continue { offset: 20, check_from: 0 }, "complete, waiting to be renamed");
    }

    #[test]
    fn cleanup_waits_for_the_device_and_gives_up_eventually() {
        assert_eq!(sweep(Duration::from_secs(3600), true), Sweep::Keep);
        assert_eq!(sweep(RETENTION, true), Sweep::Remove);
        assert_eq!(sweep(RETENTION, false), Sweep::Wait);
        assert_eq!(sweep(GIVE_UP, false), Sweep::Forget);
        assert_eq!(sweep(GIVE_UP, true), Sweep::Remove, "online: the file still goes");
    }

    #[test]
    fn idle_time_from_the_db() {
        let now = Utc::now();
        assert!(idle_for(&db_time(now - chrono::Duration::seconds(30)), now) >= Duration::from_secs(29));
        assert_eq!(idle_for("garbage", now), GIVE_UP);
    }
}
