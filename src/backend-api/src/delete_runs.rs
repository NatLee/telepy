//! 正在刪除的通道：同一條同時只刪一次（再按一次 → 409），刪除中可以叫它「跳過裝置」——還沒做完的裝置步驟
//! （找出服務、金鑰、停止、觀察）立刻結束，Telepy 自己的部分（資料列、授權、斷線）照樣做完。裝置卡住時刪除就不會被它拖住。
//! 以（通道 id、建立時間）記：測試裡每個 app 各有自己的 DB，id 會重複，建立時間不會。
//!
//! Tunnels being deleted right now: one delete per tunnel at a time (a second one → 409), and a running delete can be
//! told to skip the device — the device steps not finished yet (find the service, keys, stop, watch) end at once, while
//! Telepy's own part (rows, grants, disconnect) still runs. A stuck device can no longer hold a delete up.
//! Keyed by (tunnel id, created_at): in tests every app has its own DB, so ids repeat but creation times do not.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use tokio::sync::watch;

use crate::db::tunnels::Tunnel;

type Key = (i64, String);

struct Entry {
    skip: watch::Sender<bool>,
}

static RUNS: LazyLock<Mutex<HashMap<Key, Arc<Entry>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn key(t: &Tunnel) -> Key {
    (t.id, t.created_at.clone())
}

/// 一次刪除；放掉時從清單移除。/ One running delete; dropping it takes it off the list.
pub struct Run {
    key: Key,
    skip: watch::Receiver<bool>,
}

impl Run {
    /// 已經叫它跳過裝置了嗎。/ Was it told to skip the device?
    pub fn skipped(&self) -> bool {
        *self.skip.borrow()
    }

    /// 等到被叫跳過裝置（沒被叫就一直等）。/ Resolves once it is told to skip the device (never otherwise).
    pub async fn skip_requested(&self) {
        let mut rx = self.skip.clone();
        loop {
            if *rx.borrow_and_update() {
                return;
            }
            if rx.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        RUNS.lock().unwrap().remove(&self.key);
    }
}

/// 開始刪除；這條已經在刪 → None。/ Start a delete; None when this tunnel is already being deleted.
pub fn begin(t: &Tunnel) -> Option<Run> {
    let mut runs = RUNS.lock().unwrap();
    let k = key(t);
    if runs.contains_key(&k) {
        return None;
    }
    let (tx, rx) = watch::channel(false);
    runs.insert(k.clone(), Arc::new(Entry { skip: tx }));
    Some(Run { key: k, skip: rx })
}

/// 這條正在刪嗎（改名 / 換連線方式這時不跑）。/ Is this tunnel being deleted (no rename or switch meanwhile)?
pub fn running(t: &Tunnel) -> bool {
    RUNS.lock().unwrap().contains_key(&key(t))
}

/// 叫正在跑的刪除跳過裝置；沒有在刪 → false。/ Tell a running delete to skip the device; false when none runs.
pub fn skip_device(t: &Tunnel) -> bool {
    let entry = RUNS.lock().unwrap().get(&key(t)).cloned();
    match entry {
        Some(e) => {
            e.skip.send_replace(true);
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tunnel(id: i64, created: &str) -> Tunnel {
        Tunnel {
            id,
            user_id: 1,
            host_friendly_name: "t".into(),
            key: String::new(),
            reverse_port: 40000 + id,
            description: None,
            default_username_id: None,
            created_at: created.into(),
            updated_at: String::new(),
            require_step_up: false,
            record_sessions: false,
            terminal_detach_policy: "user".into(),
            way_in: None,
        }
    }

    #[tokio::test]
    async fn one_delete_at_a_time_and_skipping_reaches_the_run() {
        let t = tunnel(9001, "2026-11-02 00:00:00.000001");
        let run = begin(&t).expect("first delete starts");
        assert!(running(&t));
        assert!(begin(&t).is_none(), "a second delete of the same tunnel is refused");
        // 另一個 app 的同 id 通道（建立時間不同）不受影響。/ Another app's tunnel with the same id is separate.
        let other = tunnel(9001, "2026-11-02 00:00:00.000002");
        assert!(!running(&other));
        assert!(!run.skipped());
        assert!(skip_device(&t));
        assert!(run.skipped());
        tokio::time::timeout(std::time::Duration::from_secs(1), run.skip_requested()).await.expect("skip resolves");
        drop(run);
        assert!(!running(&t));
        assert!(!skip_device(&t), "nothing to skip once it ended");
        assert!(begin(&t).is_some(), "it can be deleted again after the first run ended");
    }
}
