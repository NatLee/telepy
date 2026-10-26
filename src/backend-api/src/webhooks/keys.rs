//! 個人 SSH 金鑰（金鑰頁上的、筆電用來經 gateway 連裝置的那把）快到期與已到期的事件。每 10 分鐘看一次：
//! 7 天內到期發 `key.expiring`，到期了發 `key.expired`（只發最近 48 小時內到期的，舊的到期是歷史，不補發）。
//! 每把金鑰每個階段每個到期時間只發一次；續期改了到期時間就重新算。只發給金鑰的擁有者。
//! Personal SSH keys (the ones on the Keys page) about to expire or expired. Checked every 10 minutes:
//! `key.expiring` within 7 days, `key.expired` once it passed (only expiries in the last 48 hours: older ones are
//! history). Once per key, stage and expiry time; a renewal changes the expiry and re-arms it. Owner only.

use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use serde_json::json;

use super::{Event, Kind};
use crate::db;
use crate::state::AppState;

pub const SOON_DAYS: i64 = 7;
pub const EXPIRED_WITHIN_HOURS: i64 = 48;
const INTERVAL: StdDuration = StdDuration::from_secs(600);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Soon,
    Expired,
}

impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Stage::Soon => "soon",
            Stage::Expired => "expired",
        }
    }
    pub fn kind(self) -> Kind {
        match self {
            Stage::Soon => Kind::KeyExpiring,
            Stage::Expired => Kind::KeyExpired,
        }
    }
}

/// 這把金鑰現在該發哪個通知（純函式）。/ Which notice a key needs now (pure).
pub fn stage(expires: NaiveDateTime, now: NaiveDateTime) -> Option<Stage> {
    if expires <= now {
        (now - expires <= Duration::hours(EXPIRED_WITHIN_HOURS)).then_some(Stage::Expired)
    } else if expires - now <= Duration::days(SOON_DAYS) {
        Some(Stage::Soon)
    } else {
        None
    }
}

/// 還剩幾天（無條件進位，至少 1）。/ Days left, rounded up, at least 1.
pub fn days_left(expires: NaiveDateTime, now: NaiveDateTime) -> i64 {
    let secs = (expires - now).num_seconds().max(0);
    ((secs + 86_399) / 86_400).max(1)
}

/// 看一輪，回傳發了幾則。/ One pass; returns how many events went out.
pub async fn run_once(state: &AppState, now: DateTime<Utc>) -> sqlx::Result<usize> {
    db::webhooks::prune_expiry_notices(&state.db).await?;
    let now = now.naive_utc();
    let mut sent = 0;
    for (id, user_id, name, key, expires_at) in db::webhooks::expiring_keys(&state.db).await? {
        let Some(expires) = crate::util::parse_db_datetime(&expires_at) else { continue };
        let Some(stage) = stage(expires, now) else { continue };
        if db::webhooks::expiry_notice_sent(&state.db, id, stage.as_str(), &expires_at).await? {
            continue;
        }
        let fingerprint = crate::device_keys::authorized_keys::parse_public_key(&key).map(|p| p.fingerprint);
        state.webhooks.emit(
            Event::new(stage.kind())
                .to([user_id], None)
                .data(json!({
                    "key_id": id,
                    "name": name,
                    "fingerprint": fingerprint,
                    "expires_at": crate::util::db_to_iso_utc_z(&expires_at),
                    "expires_label": expires.format("%Y-%m-%d %H:%M UTC").to_string(),
                    "days_left": days_left(expires, now),
                }))
                .link("/tunnels/keys"),
        );
        db::webhooks::mark_expiry_notice(&state.db, id, stage.as_str(), &expires_at).await?;
        sent += 1;
    }
    Ok(sent)
}

pub async fn run(state: AppState) {
    loop {
        if let Err(e) = run_once(&state, Utc::now()).await {
            tracing::warn!(error = %e, "webhooks: key expiry check failed");
        }
        tokio::time::sleep(INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }

    #[test]
    fn stages() {
        let now = t("2026-10-26 12:00");
        assert_eq!(stage(t("2026-11-10 12:00"), now), None, "two weeks away");
        assert_eq!(stage(t("2026-11-02 12:00"), now), Some(Stage::Soon), "exactly 7 days");
        assert_eq!(stage(t("2026-10-26 12:30"), now), Some(Stage::Soon));
        assert_eq!(stage(t("2026-10-26 12:00"), now), Some(Stage::Expired), "expires now");
        assert_eq!(stage(t("2026-10-24 12:00"), now), Some(Stage::Expired), "48 hours ago");
        assert_eq!(stage(t("2026-10-20 12:00"), now), None, "long expired: history");
    }

    #[test]
    fn days_round_up() {
        let now = t("2026-10-26 12:00");
        assert_eq!(days_left(t("2026-10-26 12:30"), now), 1);
        assert_eq!(days_left(t("2026-10-27 12:00"), now), 1);
        assert_eq!(days_left(t("2026-10-27 12:01"), now), 2);
        assert_eq!(days_left(t("2026-11-02 12:00"), now), 7);
    }
}
