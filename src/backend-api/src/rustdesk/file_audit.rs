//! 網頁內 RustDesk「檔案」面板的稽核（純函式）：中繼看得到檔案 session 的明文 protobuf（Telepy 拒絕加密），
//! 所以把刪除與改名整理成 tunnel 的 Logs 事件——只記路徑與數量，**從不記內容**。
//!
//! RustDesk 刪資料夾的做法：`ReadAllFiles(id, 資料夾)` 遞迴列出 → 每個檔案一個 `RemoveFile(id, …)` → 最後
//! `RemoveDir(id, 資料夾, recursive)` 由下往上刪掉變空的樹；裝置對每一步回 `Done(id)` 或 `Error(id, 訊息)`。
//! 一千個檔案的資料夾不該寫一千筆事件，所以同一個 id 的刪檔先累計，等資料夾那步有回答才寫一筆。
//! 單一檔案（前面沒有同 id 的列出）與改名則等裝置回答後各寫一筆。session 結束時還沒回答的也寫出來（標「沒有回答」）。
//!
//! Audits the in-browser RustDesk Files panel from the plaintext file session: deletions and renames become the
//! tunnel's gateway events with paths and counts, never content. A folder delete (listing → one remove per file →
//! remove the emptied tree) is folded into one event once the folder step is answered; single files and renames
//! are written when the device answers; whatever is still unanswered is written when the session ends.

use std::collections::{HashMap, VecDeque};

use super::codec::{FileOp, FileReply};

/// 同時追蹤的工作上限（壞掉或惡意的客戶端不能把記憶體撐大）。/ Jobs tracked at once.
const MAX_TRACKED: usize = 256;
/// 事件裡的路徑最多幾個字元。/ Path length in an event.
const MAX_PATH_CHARS: usize = 300;

pub const EVENT_DELETE: &str = "rustdesk_file_delete";
pub const EVENT_RENAME: &str = "rustdesk_file_rename";

/// 一筆要寫進 Logs 的事件。/ One event for the Logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditEvent {
    pub kind: &'static str,
    pub message: String,
}

#[derive(Debug, Default)]
struct Deletion {
    /// 遞迴列出的資料夾（有的話 = 這是刪資料夾）。/ The folder that was listed, if any.
    folder: Option<String>,
    /// 最後一個要刪的檔案（單一檔案刪除時就是它）。/ The last file asked for.
    last_file: String,
    files_asked: u32,
    files_done: u32,
    files_failed: u32,
    first_error: Option<String>,
    /// 已送出刪資料夾那一步（之後的回答屬於它）。/ The folder step was sent.
    dir_asked: bool,
}

#[derive(Debug)]
struct Rename {
    from: String,
    to: String,
}

/// 一條檔案 session 的稽核狀態。/ The audit state of one files session.
#[derive(Debug, Default)]
pub struct FileAudit {
    deletions: HashMap<i32, Deletion>,
    renames: HashMap<i32, Rename>,
    /// 追蹤的先後（超過上限丟最舊的）。/ Tracking order, oldest first.
    order: VecDeque<i32>,
}

fn clip(path: &str) -> String {
    if path.chars().count() <= MAX_PATH_CHARS {
        return path.to_string();
    }
    let tail: String = path.chars().rev().take(MAX_PATH_CHARS - 1).collect::<Vec<_>>().into_iter().rev().collect();
    format!("…{tail}")
}

fn plural(n: u32, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

impl FileAudit {
    pub fn new() -> Self {
        Self::default()
    }

    fn track(&mut self, id: i32) {
        if !self.order.contains(&id) {
            self.order.push_back(id);
        }
        while self.order.len() > MAX_TRACKED {
            if let Some(old) = self.order.pop_front() {
                self.deletions.remove(&old);
                self.renames.remove(&old);
            }
        }
    }

    fn forget(&mut self, id: i32) {
        self.order.retain(|x| *x != id);
    }

    /// 瀏覽器 → 裝置的一個檔案動作。/ A file action from the browser.
    pub fn on_action(&mut self, op: &FileOp) -> Vec<AuditEvent> {
        match op {
            FileOp::AllFiles { id, path } => {
                // 列出不一定是要刪（下載資料夾前也會列）：先記著，有刪檔跟上才算數。
                // A listing may precede a download too: remembered, counted only if removals follow.
                self.track(*id);
                let d = self.deletions.entry(*id).or_default();
                if d.files_asked == 0 && !d.dir_asked {
                    d.folder = Some(path.clone());
                }
            }
            FileOp::RemoveFile { id, path } => {
                self.track(*id);
                let d = self.deletions.entry(*id).or_default();
                d.files_asked += 1;
                d.last_file = path.clone();
            }
            FileOp::RemoveDir { id, path, .. } => {
                self.track(*id);
                let d = self.deletions.entry(*id).or_default();
                if d.folder.is_none() {
                    d.folder = Some(path.clone());
                }
                d.dir_asked = true;
            }
            FileOp::Rename { id, path, new_name } => {
                self.track(*id);
                self.renames.insert(*id, Rename { from: path.clone(), to: new_name.clone() });
            }
            FileOp::Create { .. } | FileOp::Other => {}
        }
        Vec::new()
    }

    /// 裝置 → 瀏覽器的一個回答。/ An answer from the device.
    pub fn on_reply(&mut self, reply: &FileReply) -> Vec<AuditEvent> {
        let (id, error) = match reply {
            FileReply::Done { id } => (*id, None),
            FileReply::Error { id, error } => (*id, Some(error.clone())),
            FileReply::Other => return Vec::new(),
        };
        if let Some(r) = self.renames.remove(&id) {
            self.forget(id);
            return vec![rename_event(&r, error.as_deref())];
        }
        let Some(d) = self.deletions.get_mut(&id) else { return Vec::new() };
        // 列出本身失敗（資料夾不存在、沒權限）：沒有刪任何東西。/ The listing failed: nothing was deleted.
        if d.files_asked == 0 && !d.dir_asked {
            self.deletions.remove(&id);
            self.forget(id);
            return Vec::new();
        }
        let answered = d.files_done + d.files_failed;
        if answered < d.files_asked {
            match error {
                None => d.files_done += 1,
                Some(e) => {
                    d.files_failed += 1;
                    d.first_error.get_or_insert(e);
                }
            }
            // 單一檔案（沒有資料夾那步要等）：回答了就寫。/ A single file: written once answered.
            if d.folder.is_none() && !d.dir_asked && d.files_done + d.files_failed == d.files_asked {
                let d = self.deletions.remove(&id).unwrap_or_default();
                self.forget(id);
                return vec![delete_event(&d, None, true)];
            }
            return Vec::new();
        }
        if d.dir_asked {
            let d = self.deletions.remove(&id).unwrap_or_default();
            self.forget(id);
            return vec![delete_event(&d, error.as_deref(), true)];
        }
        Vec::new()
    }

    /// session 結束：還沒回答的動作也寫出來。/ The session ended: write what is still unanswered.
    pub fn finish(&mut self) -> Vec<AuditEvent> {
        let mut out = Vec::new();
        let order: Vec<i32> = self.order.drain(..).collect();
        for id in order {
            if let Some(r) = self.renames.remove(&id) {
                out.push(AuditEvent { kind: EVENT_RENAME, message: format!("asked to rename {} to {} (no answer before the session ended)", clip(&r.from), clip(&r.to)) });
            }
            if let Some(d) = self.deletions.remove(&id) {
                if d.files_asked > 0 || d.dir_asked {
                    out.push(delete_event(&d, None, false));
                }
            }
        }
        out
    }
}

fn rename_event(r: &Rename, error: Option<&str>) -> AuditEvent {
    let message = match error {
        None => format!("renamed {} to {}", clip(&r.from), clip(&r.to)),
        Some(e) => format!("could not rename {} to {}: {}", clip(&r.from), clip(&r.to), clip(e)),
    };
    AuditEvent { kind: EVENT_RENAME, message }
}

/// `dir_error` = 刪資料夾那步的錯誤；`answered` = false 表示 session 在裝置回答前結束。
fn delete_event(d: &Deletion, dir_error: Option<&str>, answered: bool) -> AuditEvent {
    let message = match &d.folder {
        None => {
            let path = clip(&d.last_file);
            match (&d.first_error, answered) {
                (_, false) => format!("asked to delete file {path} (no answer before the session ended)"),
                (Some(e), true) => format!("could not delete file {path}: {}", clip(e)),
                (None, true) => format!("deleted file {path}"),
            }
        }
        Some(folder) => {
            let folder = clip(folder);
            let files = plural(d.files_done, "file", "files");
            let mut msg = match (dir_error, answered) {
                (_, false) => format!("deleted {files} in folder {folder}, the session ended before the folder itself was removed"),
                (Some(e), true) => format!("deleted {files} in folder {folder}, but not the folder: {}", clip(e)),
                (None, true) => format!("deleted folder {folder} ({files})"),
            };
            if d.files_failed > 0 {
                msg.push_str(&format!("; {} could not be deleted", plural(d.files_failed, "file", "files")));
                if let Some(e) = &d.first_error {
                    msg.push_str(&format!(" (first error: {})", clip(e)));
                }
            }
            let unanswered = d.files_asked.saturating_sub(d.files_done + d.files_failed);
            if unanswered > 0 {
                msg.push_str(&format!("; {} unanswered", plural(unanswered, "file", "files")));
            }
            msg
        }
    };
    AuditEvent { kind: EVENT_DELETE, message }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(id: i32, p: &str) -> FileOp {
        FileOp::AllFiles { id, path: p.into() }
    }
    fn rm(id: i32, p: &str) -> FileOp {
        FileOp::RemoveFile { id, path: p.into() }
    }
    fn rmdir(id: i32, p: &str) -> FileOp {
        FileOp::RemoveDir { id, path: p.into(), recursive: true }
    }
    fn done(id: i32) -> FileReply {
        FileReply::Done { id }
    }
    fn err(id: i32, e: &str) -> FileReply {
        FileReply::Error { id, error: e.into() }
    }

    #[test]
    fn a_folder_delete_is_one_event_after_the_folder_step() {
        let mut a = FileAudit::new();
        assert!(a.on_action(&all(4, "/home/dev/photos")).is_empty());
        for i in 0..3 {
            a.on_action(&rm(4, &format!("/home/dev/photos/{i}.jpg")));
            assert!(a.on_reply(&done(4)).is_empty(), "each file is folded in");
        }
        a.on_action(&rmdir(4, "/home/dev/photos"));
        let ev = a.on_reply(&done(4));
        assert_eq!(ev, vec![AuditEvent { kind: EVENT_DELETE, message: "deleted folder /home/dev/photos (3 files)".into() }]);
        assert!(a.finish().is_empty(), "nothing left over");
    }

    #[test]
    fn failures_inside_a_folder_and_on_the_folder_are_reported() {
        let mut a = FileAudit::new();
        a.on_action(&all(5, "/srv"));
        a.on_action(&rm(5, "/srv/a"));
        a.on_action(&rm(5, "/srv/b"));
        a.on_reply(&done(5));
        a.on_reply(&err(5, "Permission denied (os error 13)"));
        a.on_action(&rmdir(5, "/srv"));
        let ev = a.on_reply(&err(5, "Directory not empty (os error 39)"));
        assert_eq!(ev[0].message, "deleted 1 file in folder /srv, but not the folder: Directory not empty (os error 39); 1 file could not be deleted (first error: Permission denied (os error 13))");
    }

    #[test]
    fn single_files_and_renames_wait_for_the_answer() {
        let mut a = FileAudit::new();
        a.on_action(&rm(9, "/tmp/x.log"));
        assert_eq!(a.on_reply(&done(9))[0].message, "deleted file /tmp/x.log");
        a.on_action(&rm(10, "/etc/shadow"));
        assert_eq!(a.on_reply(&err(10, "Permission denied"))[0].message, "could not delete file /etc/shadow: Permission denied");
        a.on_action(&FileOp::Rename { id: 11, path: "/home/a.txt".into(), new_name: "../b/a.txt".into() });
        let ev = a.on_reply(&done(11));
        assert_eq!(ev, vec![AuditEvent { kind: EVENT_RENAME, message: "renamed /home/a.txt to ../b/a.txt".into() }]);
        a.on_action(&FileOp::Rename { id: 12, path: "/x".into(), new_name: "y".into() });
        assert_eq!(a.on_reply(&err(12, "exists"))[0].message, "could not rename /x to y: exists");
    }

    #[test]
    fn listings_alone_and_other_actions_write_nothing() {
        let mut a = FileAudit::new();
        // 下載資料夾前的列出：沒有刪檔就不算。/ A listing before a download is not a deletion.
        a.on_action(&all(1, "/home/dev/src"));
        assert!(a.on_reply(&FileReply::Other).is_empty());
        a.on_action(&FileOp::Create { id: 2, path: "/home/dev/new".into() });
        assert!(a.on_reply(&done(2)).is_empty());
        assert!(a.on_reply(&done(77)).is_empty(), "answers to unknown jobs (downloads, uploads) are ignored");
        // 列出失敗 = 什麼都沒刪。/ A failed listing deleted nothing.
        assert!(a.on_reply(&err(1, "No such file")).is_empty());
        assert!(a.finish().is_empty());
    }

    #[test]
    fn the_session_ending_flushes_what_is_unanswered() {
        let mut a = FileAudit::new();
        a.on_action(&all(3, "/data"));
        a.on_action(&rm(3, "/data/1"));
        a.on_reply(&done(3));
        a.on_action(&rm(3, "/data/2"));
        a.on_action(&rm(8, "/tmp/z"));
        a.on_action(&FileOp::Rename { id: 6, path: "/a".into(), new_name: "b".into() });
        let ev = a.finish();
        let msgs: Vec<&str> = ev.iter().map(|e| e.message.as_str()).collect();
        assert_eq!(msgs, vec![
            "deleted 1 file in folder /data, the session ended before the folder itself was removed; 1 file unanswered",
            "asked to delete file /tmp/z (no answer before the session ended)",
            "asked to rename /a to b (no answer before the session ended)",
        ]);
    }

    #[test]
    fn tracking_is_bounded_and_paths_are_clipped() {
        let mut a = FileAudit::new();
        for id in 0..(MAX_TRACKED as i32 + 50) {
            a.on_action(&rm(id, "/x"));
        }
        assert_eq!(a.deletions.len(), MAX_TRACKED);
        assert!(!a.deletions.contains_key(&0), "the oldest is dropped");
        let long = format!("/{}", "a".repeat(1000));
        let mut a = FileAudit::new();
        a.on_action(&rm(1, &long));
        let msg = &a.on_reply(&done(1))[0].message;
        assert!(msg.chars().count() < 340 && msg.contains('…'), "{msg}");
    }
}
