use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

#[derive(Debug, Clone, FromRow)]
pub struct User {
    pub id: i64,
    pub password: String,
    pub last_login: Option<String>,
    pub is_superuser: bool,
    pub username: String,
    pub last_name: String,
    pub email: String,
    pub is_staff: bool,
    pub is_active: bool,
    pub date_joined: String,
    pub first_name: String,
}

#[derive(Debug, Clone, FromRow)]
pub struct UserSettings {
    pub id: i64,
    pub user_id: i64,
    pub language: Option<String>,
    pub theme: String,
    pub terminal_font_size: i64,
}

#[derive(Debug, Clone, FromRow)]
pub struct SocialAccount {
    pub id: i64,
    pub provider: String,
    pub unique_id: String,
    pub user_id: i64,
}

const USER_COLS: &str = "id, password, last_login, is_superuser, username, last_name, email, is_staff, is_active, date_joined, first_name";

pub async fn count(db: &Db) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM auth_user").fetch_one(&db.read).await
}

pub async fn by_id(db: &Db, id: i64) -> sqlx::Result<Option<User>> {
    sqlx::query_as(&format!("SELECT {USER_COLS} FROM auth_user WHERE id = ?"))
        .bind(id)
        .fetch_optional(&db.read)
        .await
}

pub async fn by_username(db: &Db, username: &str) -> sqlx::Result<Option<User>> {
    sqlx::query_as(&format!("SELECT {USER_COLS} FROM auth_user WHERE username = ?"))
        .bind(username)
        .fetch_optional(&db.read)
        .await
}

pub async fn all_ordered(db: &Db) -> sqlx::Result<Vec<User>> {
    sqlx::query_as(&format!("SELECT {USER_COLS} FROM auth_user ORDER BY id"))
        .fetch_all(&db.read)
        .await
}

/// `User.objects.exclude(id__in=...)`，回 (id, username, email)。
pub async fn all_except(db: &Db, exclude: &[i64]) -> sqlx::Result<Vec<(i64, String, String)>> {
    let users: Vec<(i64, String, String)> =
        sqlx::query_as("SELECT id, username, email FROM auth_user ORDER BY id").fetch_all(&db.read).await?;
    Ok(users.into_iter().filter(|(id, _, _)| !exclude.contains(id)).collect())
}

pub struct NewUser<'a> {
    pub username: &'a str,
    pub password_hash: &'a str,
    pub email: &'a str,
    pub first_name: &'a str,
    pub last_name: &'a str,
}

/// `User.objects.create_user(...)` + `make_first_user_as_superuser` signal：第一位使用者自動成為
/// superuser/staff。/ Create a user; the first user becomes superuser+staff (Django signal parity).
pub async fn create(db: &Db, new: NewUser<'_>) -> sqlx::Result<User> {
    let mut tx = db.write.begin().await?;
    let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM auth_user").fetch_one(&mut *tx).await?;
    let first = existing == 0;
    let now = now_db();
    let id = sqlx::query(
        "INSERT INTO auth_user (password, last_login, is_superuser, username, last_name, email, is_staff, is_active, date_joined, first_name) \
         VALUES (?, NULL, ?, ?, ?, ?, ?, 1, ?, ?)",
    )
    .bind(new.password_hash)
    .bind(first)
    .bind(new.username)
    .bind(new.last_name)
    .bind(new.email)
    .bind(first)
    .bind(&now)
    .bind(new.first_name)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    tx.commit().await?;
    Ok(by_id(db, id).await?.expect("user just inserted"))
}

pub async fn touch_last_login(db: &Db, id: i64) -> sqlx::Result<()> {
    sqlx::query("UPDATE auth_user SET last_login = ? WHERE id = ?")
        .bind(now_db())
        .bind(id)
        .execute(&db.write)
        .await?;
    Ok(())
}

pub async fn set_password(db: &Db, id: i64, password_hash: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE auth_user SET password = ? WHERE id = ?")
        .bind(password_hash)
        .bind(id)
        .execute(&db.write)
        .await?;
    Ok(())
}

pub async fn set_flags(db: &Db, id: i64, is_active: Option<bool>, is_superuser: Option<bool>) -> sqlx::Result<()> {
    if let Some(a) = is_active {
        sqlx::query("UPDATE auth_user SET is_active = ? WHERE id = ?").bind(a).bind(id).execute(&db.write).await?;
    }
    if let Some(s) = is_superuser {
        // 與 first-user signal 一致：superuser 同時給 is_staff。
        sqlx::query("UPDATE auth_user SET is_superuser = ?, is_staff = ? WHERE id = ?")
            .bind(s)
            .bind(s)
            .bind(id)
            .execute(&db.write)
            .await?;
    }
    Ok(())
}

// ---------------------------------------------------------------- settings

pub async fn settings_for(db: &Db, user_id: i64) -> sqlx::Result<Option<UserSettings>> {
    sqlx::query_as("SELECT id, user_id, language, theme, terminal_font_size FROM user_management_usersettings WHERE user_id = ?")
        .bind(user_id)
        .fetch_optional(&db.read)
        .await
}

/// `UserSettings.for_user()`：沒有就建立。/ get_or_create.
pub async fn settings_get_or_create(db: &Db, user_id: i64) -> sqlx::Result<UserSettings> {
    if let Some(s) = settings_for(db, user_id).await? {
        return Ok(s);
    }
    sqlx::query("INSERT OR IGNORE INTO user_management_usersettings (language, theme, terminal_font_size, user_id) VALUES (NULL, 'system', 14, ?)")
        .bind(user_id)
        .execute(&db.write)
        .await?;
    Ok(settings_for(db, user_id).await?.expect("settings row just inserted"))
}

pub async fn settings_update(
    db: &Db,
    user_id: i64,
    language: Option<Option<String>>,
    theme: Option<String>,
    terminal_font_size: Option<i64>,
) -> sqlx::Result<UserSettings> {
    settings_get_or_create(db, user_id).await?;
    if let Some(lang) = language {
        sqlx::query("UPDATE user_management_usersettings SET language = ? WHERE user_id = ?")
            .bind(lang)
            .bind(user_id)
            .execute(&db.write)
            .await?;
    }
    if let Some(t) = theme {
        sqlx::query("UPDATE user_management_usersettings SET theme = ? WHERE user_id = ?")
            .bind(t)
            .bind(user_id)
            .execute(&db.write)
            .await?;
    }
    if let Some(f) = terminal_font_size {
        sqlx::query("UPDATE user_management_usersettings SET terminal_font_size = ? WHERE user_id = ?")
            .bind(f)
            .bind(user_id)
            .execute(&db.write)
            .await?;
    }
    Ok(settings_for(db, user_id).await?.expect("settings row exists"))
}

/// 一次載入所有使用者的 language（admin 使用者列表用，避免 N+1）。
pub async fn settings_language_map(db: &Db) -> sqlx::Result<std::collections::HashMap<i64, Option<String>>> {
    let rows: Vec<(i64, Option<String>)> =
        sqlx::query_as("SELECT user_id, language FROM user_management_usersettings").fetch_all(&db.read).await?;
    Ok(rows.into_iter().collect())
}

// ---------------------------------------------------------------- social accounts

pub async fn social_for(db: &Db, user_id: i64, provider: &str) -> sqlx::Result<Option<SocialAccount>> {
    sqlx::query_as("SELECT id, provider, unique_id, user_id FROM social_account WHERE user_id = ? AND provider = ?")
        .bind(user_id)
        .bind(provider)
        .fetch_optional(&db.read)
        .await
}

pub async fn social_create(db: &Db, user_id: i64, provider: &str, unique_id: &str) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO social_account (provider, unique_id, user_id) VALUES (?, ?, ?)")
        .bind(provider)
        .bind(unique_id)
        .bind(user_id)
        .execute(&db.write)
        .await?;
    Ok(())
}
