//! 登入紀錄（成功與失敗）：誰、何時、從哪個 IP / 瀏覽器、用什麼方式。只記存在的帳號（亂打的帳號名不記，
//! 免得被灌爆）。帶 IP（個資）：保留 90 天（`db::retention`）、最多 100k 列。
//! Sign-in history (successes and failures) for existing accounts only. Rows carry IPs, so they are
//! kept for 90 days and capped at 100k rows.

use std::sync::atomic::{AtomicU64, Ordering};

use sqlx::FromRow;

use super::audit_chain::{self, Field, Table};
use super::Db;
use crate::util::now_db;

const RETENTION_ROWS: i64 = 100_000;
static INSERTS: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, FromRow)]
pub struct SignIn {
    pub id: i64,
    pub at: String,
    pub user_id: i64,
    pub ok: bool,
    /// 第一關：password / google / passkey（免密碼）。/ First factor.
    pub method: String,
    /// 第二關：totp / recovery_code / passkey；沒有 2FA 時 None。/ Second factor, when there was one.
    pub second_factor: Option<String>,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    /// 失敗原因（機器可讀）：bad_password / inactive / mfa_failed / google_account_conflict。
    pub reason: Option<String>,
}

pub struct NewSignIn<'a> {
    pub user_id: i64,
    pub ok: bool,
    pub method: &'a str,
    pub second_factor: Option<&'a str>,
    pub ip: Option<&'a str>,
    pub user_agent: Option<&'a str>,
    pub reason: Option<&'a str>,
}

const COLS: &str = "id, at, user_id, ok, method, second_factor, ip, user_agent, reason";

pub async fn insert(db: &Db, e: &NewSignIn<'_>) -> sqlx::Result<()> {
    let row = [
        ("at", Field::text(now_db())),
        ("user_id", Field::Int(Some(e.user_id))),
        ("ok", Field::Bool(e.ok)),
        ("method", Field::text(e.method)),
        ("second_factor", Field::opt_text(e.second_factor)),
        ("ip", Field::opt_text(e.ip)),
        ("user_agent", Field::opt_text(e.user_agent)),
        ("reason", Field::opt_text(e.reason)),
    ];
    audit_chain::append(db, Table::SignIn, &row).await?;
    // 列數上限：每 64 筆順手清一次（90 天由 `db::retention` 清；先寫 prune 錨點）。/ Row cap, every 64 inserts.
    if INSERTS.fetch_add(1, Ordering::Relaxed) % 64 == 0 {
        let cut: Option<i64> = sqlx::query_scalar("SELECT id FROM telepy_sign_in_event ORDER BY id DESC LIMIT 1 OFFSET ?")
            .bind(RETENTION_ROWS)
            .fetch_optional(&db.read)
            .await?;
        if let Some(cut) = cut {
            audit_chain::prune_through(db, Table::SignIn, cut).await?;
        }
    }
    Ok(())
}

/// 最新的在前。/ Newest first.
pub async fn for_user(db: &Db, user_id: i64, limit: i64) -> sqlx::Result<Vec<SignIn>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM telepy_sign_in_event WHERE user_id = ? ORDER BY id DESC LIMIT ?"))
        .bind(user_id)
        .bind(limit)
        .fetch_all(&db.read)
        .await
}
