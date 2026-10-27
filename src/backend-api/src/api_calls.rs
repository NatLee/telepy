//! 委派 token 呼叫紀錄的寫入端：請求路徑上只做一次 `try_send`（有界 channel），背景 task 每秒或每 500 筆批次寫入
//! （`db::api_calls::insert_batch`）。channel 滿了就丟掉並計數，永遠不讓請求等 DB。
//! The writer of the delegated-token call log: the request path only does one `try_send` into a bounded channel; a
//! background task writes batches every second or every 500 calls. A full channel drops the call and counts it —
//! a request never waits on the database.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};

pub use crate::db::api_calls::NewCall;
use crate::db::Db;

/// channel 容量。/ Channel capacity.
pub const QUEUE: usize = 10_000;
/// 一批最多幾筆、最多等多久。/ Batch size and how long a batch may wait.
pub const BATCH: usize = 500;
pub const FLUSH_EVERY: Duration = Duration::from_secs(1);

enum Msg {
    Call(Box<NewCall>),
    Flush(oneshot::Sender<()>),
}

pub struct ApiCalls {
    tx: Option<mpsc::Sender<Msg>>,
    dropped: Arc<AtomicU64>,
}

impl ApiCalls {
    /// 有 tokio runtime 時開背景 writer；沒有（例如離線子命令）就什麼都不記。
    /// Starts the background writer when a tokio runtime is around; without one nothing is recorded.
    pub fn new(db: Db) -> Self {
        let dropped = Arc::new(AtomicU64::new(0));
        let Ok(handle) = tokio::runtime::Handle::try_current() else { return Self { tx: None, dropped } };
        let (tx, rx) = mpsc::channel(QUEUE);
        handle.spawn(writer(db, rx));
        Self { tx: Some(tx), dropped }
    }

    /// 記一筆（不等）。/ Record one call without waiting.
    pub fn record(&self, call: NewCall) {
        let Some(tx) = &self.tx else { return };
        if tx.try_send(Msg::Call(Box::new(call))).is_err() {
            let n = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
            if n == 1 || n.is_multiple_of(1000) {
                tracing::warn!(dropped = n, "API call log queue is full; dropping calls");
            }
        }
    }

    /// 因 channel 滿而丟掉的筆數（啟動以來）。/ Calls dropped because the queue was full, since startup.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// 等目前排隊的都寫進 DB（測試與關機用）。/ Wait until everything queued so far is written (tests, shutdown).
    pub async fn flush(&self) {
        let Some(tx) = &self.tx else { return };
        let (done, wait) = oneshot::channel();
        if tx.send(Msg::Flush(done)).await.is_ok() {
            let _ = wait.await;
        }
    }
}

async fn write(db: &Db, batch: &mut Vec<NewCall>) {
    if batch.is_empty() {
        return;
    }
    match crate::db::api_calls::insert_batch(db, batch).await {
        Ok(max) => {
            // 偶爾修剪（跨過 1000 的倍數時）。/ Trim now and then (when crossing a multiple of 1000).
            if max / 1000 != (max - batch.len() as i64) / 1000 {
                if let Err(e) = crate::db::api_calls::trim(db, max).await {
                    tracing::warn!(error = %e, "cannot trim the API call log");
                }
            }
        }
        Err(e) => tracing::warn!(error = %e, rows = batch.len(), "cannot write the API call log"),
    }
    batch.clear();
}

fn take(m: Msg, batch: &mut Vec<NewCall>, flushes: &mut Vec<oneshot::Sender<()>>) {
    match m {
        Msg::Call(c) => batch.push(*c),
        Msg::Flush(done) => flushes.push(done),
    }
}

async fn writer(db: Db, mut rx: mpsc::Receiver<Msg>) {
    let mut batch: Vec<NewCall> = Vec::with_capacity(BATCH);
    loop {
        // 等第一筆，再收一秒內（或滿 500 筆）的其他筆。/ Wait for the first message, then gather for up to a second.
        let Some(first) = rx.recv().await else { break };
        let mut flushes = Vec::new();
        take(first, &mut batch, &mut flushes);
        let deadline = tokio::time::Instant::now() + FLUSH_EVERY;
        while batch.len() < BATCH && flushes.is_empty() {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(m)) => take(m, &mut batch, &mut flushes),
                Ok(None) | Err(_) => break,
            }
        }
        write(&db, &mut batch).await;
        for done in flushes {
            let _ = done.send(());
        }
    }
    write(&db, &mut batch).await;
}
