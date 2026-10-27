//! 隧道的釘選（每個使用者自己的）與標籤（隧道共用，owner / EDIT 以上可改）。隧道刪除時一起刪；被取消分享時
//! 那個人的釘選也刪掉。
//! Per-user pins and shared per-tunnel labels (owner / EDIT and up may change them). Both go away with the
//! tunnel; a sharee's pin goes away when they lose access.

use std::collections::{HashMap, HashSet};

use super::Db;

const PIN: &str = "telepy_tunnel_pin";
const LABEL: &str = "telepy_tunnel_label";
const T: &str = "authorized_keys_reverseserverauthorizedkeys";

/// 一條隧道最多幾個標籤。/ Labels per tunnel.
pub const MAX_LABELS: usize = 12;
/// 標籤最長幾個字元。/ Longest label.
pub const MAX_LABEL_LEN: usize = 32;

/// 整理使用者給的標籤：去空白、轉小寫、去重複、排序；格式 `[a-z0-9]` 開頭，後面可以有 `. _ - =`
/// （`env=prod` 這種鍵值也行）。不合規就回錯誤訊息。
/// Normalise user-supplied labels: trimmed, lower-cased, de-duplicated and sorted. A label starts with a
/// letter or digit and may contain `. _ - =` (so `env=prod` works). Returns the error message otherwise.
pub fn normalize_labels(input: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for raw in input {
        let l = raw.trim().to_lowercase();
        if l.is_empty() {
            continue;
        }
        let ok_chars = l.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-' | '='));
        let ok_start = l.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
        if !ok_chars || !ok_start || l.len() > MAX_LABEL_LEN {
            return Err(format!(
                "\"{}\" is not a valid label: use up to {MAX_LABEL_LEN} lowercase letters, digits and . _ - =, starting with a letter or digit.",
                raw.trim()
            ));
        }
        if !out.contains(&l) {
            out.push(l);
        }
    }
    if out.len() > MAX_LABELS {
        return Err(format!("Use at most {MAX_LABELS} labels."));
    }
    out.sort();
    Ok(out)
}

/// 這個使用者釘選的隧道。/ Tunnels this user pinned.
pub async fn pinned_by(db: &Db, user_id: i64) -> sqlx::Result<HashSet<i64>> {
    let rows: Vec<(i64,)> = sqlx::query_as(&format!("SELECT tunnel_id FROM {PIN} WHERE user_id = ?")).bind(user_id).fetch_all(&db.read).await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

pub async fn set_pin(db: &Db, user_id: i64, tunnel_id: i64, pinned: bool) -> sqlx::Result<()> {
    if pinned {
        sqlx::query(&format!("INSERT OR IGNORE INTO {PIN} (user_id, tunnel_id, created_at) VALUES (?, ?, ?)"))
            .bind(user_id)
            .bind(tunnel_id)
            .bind(crate::util::now_db())
            .execute(&db.write)
            .await?;
    } else {
        sqlx::query(&format!("DELETE FROM {PIN} WHERE user_id = ? AND tunnel_id = ?")).bind(user_id).bind(tunnel_id).execute(&db.write).await?;
    }
    Ok(())
}

/// 看得到的隧道（owned ∪ shared）的標籤，以 tunnel id 為鍵、已排序。/ Labels of the tunnels a user can see.
pub async fn labels_visible_to(db: &Db, user_id: i64) -> sqlx::Result<HashMap<i64, Vec<String>>> {
    let rows: Vec<(i64, String)> = sqlx::query_as(&format!(
        "SELECT tunnel_id, label FROM {LABEL} \
         WHERE tunnel_id IN (SELECT id FROM {T} WHERE user_id = ? UNION SELECT tunnel_id FROM tunnels_tunnelsharing WHERE shared_with_id = ?) \
         ORDER BY label"
    ))
    .bind(user_id)
    .bind(user_id)
    .fetch_all(&db.read)
    .await?;
    let mut map: HashMap<i64, Vec<String>> = HashMap::new();
    for (id, label) in rows {
        map.entry(id).or_default().push(label);
    }
    Ok(map)
}

pub async fn labels_of(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(&format!("SELECT label FROM {LABEL} WHERE tunnel_id = ? ORDER BY label")).bind(tunnel_id).fetch_all(&db.read).await?;
    Ok(rows.into_iter().map(|(l,)| l).collect())
}

/// 整組換掉（呼叫前先 [`normalize_labels`]）。/ Replace the whole set (normalise first).
pub async fn replace_labels(db: &Db, tunnel_id: i64, labels: &[String]) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    sqlx::query(&format!("DELETE FROM {LABEL} WHERE tunnel_id = ?")).bind(tunnel_id).execute(&mut *tx).await?;
    for l in labels {
        sqlx::query(&format!("INSERT INTO {LABEL} (tunnel_id, label) VALUES (?, ?)")).bind(tunnel_id).bind(l).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn labels_are_normalised() {
        assert_eq!(normalize_labels(&s(&[" Prod ", "home", "prod", "", "env=lab"])).unwrap(), s(&["env=lab", "home", "prod"]));
    }

    #[test]
    fn bad_labels_are_rejected() {
        for bad in ["-x", "has space", "a/b", "ünïcode", &"x".repeat(MAX_LABEL_LEN + 1)] {
            assert!(normalize_labels(&s(&[bad])).is_err(), "{bad}");
        }
        let many: Vec<String> = (0..=MAX_LABELS).map(|i| format!("l{i}")).collect();
        assert!(normalize_labels(&many).is_err());
    }
}
