//! 冪等 schema：以 Django 的表名/欄名建表（新安裝），並對既有 DB 補齊缺少的欄位（舊 DB）。
//! 不動既有欄位、不刪任何東西 —— 切回 Django image 永遠可行。
//! Idempotent schema reconciliation against the Django-named tables: creates missing tables on a
//! fresh install and adds missing columns on an older DB. Never alters or drops existing columns,
//! so rolling back to the Django image stays possible.

use sqlx::SqlitePool;

const TABLES: &[(&str, &str)] = &[
    (
        "auth_user",
        r#"CREATE TABLE "auth_user" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "password" varchar(128) NOT NULL,
            "last_login" datetime NULL,
            "is_superuser" bool NOT NULL,
            "username" varchar(150) NOT NULL UNIQUE,
            "last_name" varchar(150) NOT NULL,
            "email" varchar(254) NOT NULL,
            "is_staff" bool NOT NULL,
            "is_active" bool NOT NULL,
            "date_joined" datetime NOT NULL,
            "first_name" varchar(150) NOT NULL
        )"#,
    ),
    (
        "social_account",
        r#"CREATE TABLE "social_account" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "provider" varchar(200) NOT NULL,
            "unique_id" varchar(200) NOT NULL,
            "user_id" integer NOT NULL REFERENCES "auth_user" ("id") DEFERRABLE INITIALLY DEFERRED
        )"#,
    ),
    (
        "authorized_keys_serviceauthorizedkeys",
        r#"CREATE TABLE "authorized_keys_serviceauthorizedkeys" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "service" varchar(128) NOT NULL UNIQUE,
            "key" varchar(19200) NOT NULL UNIQUE,
            "description" text NULL,
            "created_at" datetime NOT NULL,
            "updated_at" datetime NOT NULL
        )"#,
    ),
    (
        "authorized_keys_reverseserverauthorizedkeys",
        r#"CREATE TABLE "authorized_keys_reverseserverauthorizedkeys" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "key" varchar(19200) NOT NULL UNIQUE,
            "created_at" datetime NOT NULL,
            "description" text NULL,
            "updated_at" datetime NOT NULL,
            "reverse_port" integer unsigned NOT NULL UNIQUE CHECK ("reverse_port" >= 0),
            "user_id" integer NOT NULL REFERENCES "auth_user" ("id") DEFERRABLE INITIALLY DEFERRED,
            "host_friendly_name" varchar(128) NOT NULL UNIQUE,
            "default_username_id" INTEGER NULL
        )"#,
    ),
    (
        "authorized_keys_reverseserverusernames",
        r#"CREATE TABLE "authorized_keys_reverseserverusernames" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "username" varchar(128) NOT NULL,
            "created_at" datetime NOT NULL,
            "updated_at" datetime NOT NULL,
            "reverse_server_id" bigint NOT NULL REFERENCES "authorized_keys_reverseserverauthorizedkeys" ("id") DEFERRABLE INITIALLY DEFERRED,
            "user_id" integer NOT NULL REFERENCES "auth_user" ("id") DEFERRABLE INITIALLY DEFERRED
        )"#,
    ),
    (
        "authorized_keys_userauthorizedkeys",
        r#"CREATE TABLE "authorized_keys_userauthorizedkeys" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "key" varchar(19200) NOT NULL UNIQUE,
            "description" text NULL,
            "created_at" datetime NOT NULL,
            "updated_at" datetime NOT NULL,
            "user_id" integer NOT NULL REFERENCES "auth_user" ("id") DEFERRABLE INITIALLY DEFERRED,
            "host_friendly_name" varchar(128) NOT NULL UNIQUE
        )"#,
    ),
    (
        "tunnels_tunnelsharing",
        r#"CREATE TABLE "tunnels_tunnelsharing" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "shared_at" datetime NOT NULL,
            "updated_at" datetime NOT NULL,
            "shared_by_id" integer NOT NULL REFERENCES "auth_user" ("id") DEFERRABLE INITIALLY DEFERRED,
            "shared_with_id" integer NOT NULL REFERENCES "auth_user" ("id") DEFERRABLE INITIALLY DEFERRED,
            "tunnel_id" bigint NOT NULL REFERENCES "authorized_keys_reverseserverauthorizedkeys" ("id") DEFERRABLE INITIALLY DEFERRED,
            "permission_type" varchar(10) NOT NULL
        )"#,
    ),
    (
        "tunnels_tunnelsharingallowedusername",
        r#"CREATE TABLE "tunnels_tunnelsharingallowedusername" (
            "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
            "tunnel_sharing_id" INTEGER NOT NULL REFERENCES "tunnels_tunnelsharing"("id") ON DELETE CASCADE,
            "reverse_server_username_id" INTEGER NOT NULL REFERENCES "authorized_keys_reverseserverusernames"("id") ON DELETE CASCADE
        )"#,
    ),
    (
        "site_settings_sitesettings",
        r#"CREATE TABLE "site_settings_sitesettings" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "allow_registration" bool NOT NULL,
            "remote_browser_session_idle_timeout" integer NOT NULL DEFAULT 60
        )"#,
    ),
    (
        "user_management_usersettings",
        r#"CREATE TABLE "user_management_usersettings" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "language" varchar(8) NULL,
            "theme" varchar(8) NOT NULL DEFAULT 'system',
            "terminal_font_size" smallint unsigned NOT NULL DEFAULT 14 CHECK ("terminal_font_size" >= 0),
            "user_id" integer NOT NULL UNIQUE REFERENCES "auth_user" ("id") DEFERRABLE INITIALLY DEFERRED
        )"#,
    ),
    // Rust 自有：remote-browser session 記錄（後端重啟後據此回收 kasm 側孤兒）。
    (
        "telepy_remote_browser_session",
        r#"CREATE TABLE "telepy_remote_browser_session" (
            "session_id" varchar(64) NOT NULL PRIMARY KEY,
            "server_id" integer NOT NULL,
            "kasm_session_id" varchar(64) NULL,
            "ws_port" integer NULL,
            "proxy_port" integer NULL,
            "created_at" datetime NOT NULL
        )"#,
    ),
];

const INDEXES: &[&str] = &[
    r#"CREATE INDEX IF NOT EXISTS "social_account_user_id_5e6e9a7d" ON "social_account" ("user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "authorized_keys_reverseserverusernames_reverse_server_id_567b60c7" ON "authorized_keys_reverseserverusernames" ("reverse_server_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "authorized_keys_reverseserverusernames_user_id_9104f26d" ON "authorized_keys_reverseserverusernames" ("user_id")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "authorized_keys_reverseserverusernames_user_id_reverse_server_id_username_f134e4dd_uniq" ON "authorized_keys_reverseserverusernames" ("user_id", "reverse_server_id", "username")"#,
    r#"CREATE INDEX IF NOT EXISTS "authorized_keys_reverseserverauthorizedkeys_user_id_83f089c8" ON "authorized_keys_reverseserverauthorizedkeys" ("user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "authorized_keys_userauthorizedkeys_user_id_caee3ade" ON "authorized_keys_userauthorizedkeys" ("user_id")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "tunnels_tunnelsharing_tunnel_id_shared_with_id_b0233968_uniq" ON "tunnels_tunnelsharing" ("tunnel_id", "shared_with_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "tunnels_tunnelsharing_shared_by_id_ea81d195" ON "tunnels_tunnelsharing" ("shared_by_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "tunnels_tunnelsharing_shared_with_id_53a19568" ON "tunnels_tunnelsharing" ("shared_with_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "tunnels_tunnelsharing_tunnel_id_b2ba0137" ON "tunnels_tunnelsharing" ("tunnel_id")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "tunnels_tunnelsharingallowedusername_tunnel_sharing_id_reverse_server_username_id_uniq" ON "tunnels_tunnelsharingallowedusername" ("tunnel_sharing_id", "reverse_server_username_id")"#,
];

/// 舊 DB 可能缺的欄位（Django 後來的 migration 加的）。(table, column, ADD COLUMN 子句)
const COLUMNS: &[(&str, &str, &str)] = &[
    ("authorized_keys_reverseserverauthorizedkeys", "default_username_id", "INTEGER NULL"),
    ("site_settings_sitesettings", "valid_register_domains", "varchar(512) NOT NULL DEFAULT 'gmail.com'"),
    ("site_settings_sitesettings", "remote_browser_session_idle_timeout", "integer NOT NULL DEFAULT 60"),
    ("site_settings_sitesettings", "remote_browser_max_sessions", "integer NOT NULL DEFAULT 10"),
    ("site_settings_sitesettings", "remote_browser_geometry", "varchar(32) NOT NULL DEFAULT '1280x720'"),
    ("site_settings_sitesettings", "remote_browser_ssh_timeout", "integer NOT NULL DEFAULT 30"),
    ("site_settings_sitesettings", "remote_browser_ssh_attempts", "integer NOT NULL DEFAULT 2"),
    ("site_settings_sitesettings", "remote_browser_kasm_create_timeout", "integer NOT NULL DEFAULT 30"),
    ("site_settings_sitesettings", "remote_browser_homepage", "varchar(512) NOT NULL DEFAULT 'https://www.google.com'"),
    ("site_settings_sitesettings", "remote_browser_language", "varchar(16) NOT NULL DEFAULT 'zh-TW'"),
    ("user_management_usersettings", "theme", "varchar(8) NOT NULL DEFAULT 'system'"),
    ("user_management_usersettings", "terminal_font_size", "smallint unsigned NOT NULL DEFAULT 14"),
];

async fn table_exists(pool: &SqlitePool, name: &str) -> sqlx::Result<bool> {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?")
        .bind(name)
        .fetch_one(pool)
        .await?;
    Ok(n > 0)
}

async fn column_exists(pool: &SqlitePool, table: &str, column: &str) -> sqlx::Result<bool> {
    let cols: Vec<(i64, String)> = sqlx::query_as(&format!("PRAGMA table_info(\"{table}\")"))
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|row: (i64, String, String, i64, Option<String>, i64)| (row.0, row.1))
        .collect();
    Ok(cols.iter().any(|(_, c)| c == column))
}

pub async fn ensure_schema(pool: &SqlitePool) -> anyhow::Result<()> {
    for (name, ddl) in TABLES {
        if !table_exists(pool, name).await? {
            tracing::info!(table = name, "creating missing table");
            sqlx::query(ddl).execute(pool).await?;
        }
    }
    for (table, column, ddl) in COLUMNS {
        if !column_exists(pool, table, column).await? {
            tracing::info!(table, column, "adding missing column");
            sqlx::query(&format!("ALTER TABLE \"{table}\" ADD COLUMN \"{column}\" {ddl}"))
                .execute(pool)
                .await?;
        }
    }
    for ddl in INDEXES {
        sqlx::query(ddl).execute(pool).await?;
    }
    // SiteSettings.get_solo(): 永遠存在 pk=1 那一列。舊 DB 的某些欄位 NOT NULL 但沒有 DEFAULT
    // （Django 重建表時不帶 default），所以 INSERT 要把每個欄位的值都給齊。
    // The singleton settings row (pk=1); list every column because older DBs have NOT NULL columns
    // without a DEFAULT clause.
    sqlx::query(
        "INSERT INTO site_settings_sitesettings (id, allow_registration, valid_register_domains, \
            remote_browser_session_idle_timeout, remote_browser_max_sessions, remote_browser_geometry, \
            remote_browser_ssh_timeout, remote_browser_ssh_attempts, remote_browser_kasm_create_timeout, \
            remote_browser_homepage, remote_browser_language) \
         SELECT 1, 0, 'gmail.com', 60, 10, '1280x720', 30, 2, 30, 'https://www.google.com', 'zh-TW' \
         WHERE NOT EXISTS (SELECT 1 FROM site_settings_sitesettings WHERE id = 1)",
    )
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::pool::Db;

    #[tokio::test]
    async fn fresh_db_gets_full_schema_and_is_idempotent() {
        let db = Db::open_memory().await.unwrap();
        ensure_schema(&db.write).await.unwrap();
        ensure_schema(&db.write).await.unwrap();
        assert!(column_exists(&db.write, "site_settings_sitesettings", "remote_browser_language").await.unwrap());
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM site_settings_sitesettings WHERE id = 1")
            .fetch_one(&db.read)
            .await
            .unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn stale_db_gets_missing_columns() {
        let db = Db::open_memory().await.unwrap();
        // 模擬 2025 年的舊 DB：settings 表只有兩欄。/ An old DB whose settings table has two columns.
        sqlx::query(r#"CREATE TABLE "site_settings_sitesettings" ("id" integer NOT NULL PRIMARY KEY AUTOINCREMENT, "allow_registration" bool NOT NULL, "remote_browser_session_idle_timeout" integer NOT NULL)"#)
            .execute(&db.write).await.unwrap();
        ensure_schema(&db.write).await.unwrap();
        assert!(column_exists(&db.write, "site_settings_sitesettings", "remote_browser_homepage").await.unwrap());
        let hp: String = sqlx::query_scalar("SELECT remote_browser_homepage FROM site_settings_sitesettings WHERE id = 1")
            .fetch_one(&db.read).await.unwrap();
        assert_eq!(hp, "https://www.google.com");
    }
}
