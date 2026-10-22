//! 冪等 schema：以 Django 的表名/欄名建表（新安裝），並對既有 DB 補齊缺少的欄位（舊 DB）。
//! 不動既有欄位。規則改變需要清資料時用一次性的 data migration（記在 `telepy_data_migration`，每個只跑一次）。
//! Idempotent schema reconciliation against the Django-named tables: creates missing tables on a
//! fresh install and adds missing columns on an older DB; never alters or drops existing columns.
//! One-off data fixes run once each and are recorded in `telepy_data_migration`.

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
            "ui_scale" smallint unsigned NOT NULL DEFAULT 100,
            "user_id" integer NOT NULL UNIQUE REFERENCES "auth_user" ("id") DEFERRABLE INITIALLY DEFERRED
        )"#,
    ),
    // Rust 自有：SSH gateway 事件（Logs 頁、/api/log/ssh；取代讀 sshd 的文字檔）。
    (
        "telepy_gateway_event",
        r#"CREATE TABLE "telepy_gateway_event" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "at" datetime NOT NULL,
            "event" varchar(32) NOT NULL,
            "peer" varchar(64) NULL,
            "port" integer NULL,
            "tunnel_id" integer NULL,
            "message" text NOT NULL
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
    // Rust 自有：OAuth 2.1（MCP 連接器）的 client（RFC 7591 動態註冊）與 grant（一次同意一列，refresh token 只存雜湊）。
    (
        "telepy_oauth_client",
        r#"CREATE TABLE "telepy_oauth_client" (
            "client_id" varchar(64) NOT NULL PRIMARY KEY,
            "client_secret_hash" varchar(64) NULL,
            "client_name" varchar(200) NOT NULL,
            "redirect_uris" text NOT NULL,
            "token_endpoint_auth_method" varchar(32) NOT NULL,
            "client_uri" varchar(2000) NULL,
            "logo_uri" varchar(2000) NULL,
            "created_at" datetime NOT NULL
        )"#,
    ),
    (
        "telepy_oauth_grant",
        r#"CREATE TABLE "telepy_oauth_grant" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "user_id" integer NOT NULL,
            "client_id" varchar(64) NOT NULL,
            "scope" varchar(256) NOT NULL,
            "tunnel_ids" text NULL,
            "resource" varchar(2000) NOT NULL,
            "refresh_token_hash" varchar(64) NULL UNIQUE,
            "refresh_expires_at" datetime NULL,
            "created_at" datetime NOT NULL,
            "last_used_at" datetime NULL,
            "revoked_at" datetime NULL
        )"#,
    ),
    // Rust 自有：兩步驟驗證（TOTP secret 加密存放、passkey、復原碼只存雜湊）。/ Two-factor login.
    (
        "telepy_user_mfa",
        r#"CREATE TABLE "telepy_user_mfa" (
            "user_id" integer NOT NULL PRIMARY KEY,
            "webauthn_user_id" varchar(36) NOT NULL UNIQUE,
            "totp_secret" text NULL,
            "totp_pending_secret" text NULL,
            "totp_enabled_at" datetime NULL,
            "totp_last_step" integer NULL,
            "updated_at" datetime NOT NULL
        )"#,
    ),
    (
        "telepy_passkey",
        r#"CREATE TABLE "telepy_passkey" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "user_id" integer NOT NULL,
            "name" varchar(100) NOT NULL,
            "credential_id" varchar(1400) NOT NULL UNIQUE,
            "passkey" text NOT NULL,
            "created_at" datetime NOT NULL,
            "last_used_at" datetime NULL
        )"#,
    ),
    (
        "telepy_recovery_code",
        r#"CREATE TABLE "telepy_recovery_code" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "user_id" integer NOT NULL,
            "code_hash" varchar(64) NOT NULL,
            "used_at" datetime NULL,
            "created_at" datetime NOT NULL
        )"#,
    ),
    // Rust 自有：隧道背後的區網主機（跳板機表，#20）。/ LAN hosts behind a tunnel (jump-host table).
    (
        "telepy_lan_host",
        r#"CREATE TABLE "telepy_lan_host" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "tunnel_id" integer NOT NULL,
            "address" varchar(255) NOT NULL,
            "hostname" varchar(255) NULL,
            "mac" varchar(32) NULL,
            "open_ports" text NOT NULL DEFAULT '[]',
            "ssh_banner" varchar(255) NULL,
            "label" varchar(100) NULL,
            "username" varchar(128) NULL,
            "ssh_port" integer NOT NULL DEFAULT 22,
            "source" varchar(16) NOT NULL,
            "first_seen" datetime NULL,
            "last_seen" datetime NULL,
            "created_at" datetime NOT NULL,
            "updated_at" datetime NOT NULL
        )"#,
    ),
    // Rust 自有：MCP（AI）tool call 的稽核紀錄。/ Audit trail of MCP tool calls.
    (
        "telepy_ai_audit_event",
        r#"CREATE TABLE "telepy_ai_audit_event" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "at" datetime NOT NULL,
            "user_id" integer NOT NULL,
            "grant_id" integer NULL,
            "client_name" varchar(200) NOT NULL,
            "tool" varchar(64) NOT NULL,
            "tunnel_id" integer NULL,
            "session_id" varchar(64) NULL,
            "target_username" varchar(128) NULL,
            "detail" text NULL,
            "ok" bool NOT NULL,
            "exit_code" integer NULL,
            "duration_ms" integer NULL,
            "bytes_out" integer NULL,
            "error" text NULL,
            "ip" varchar(64) NULL
        )"#,
    ),
    // Rust 自有：每條隧道最後一次連上 gateway 的公網 IP（一條隧道一列、覆寫；隧道刪除時一起刪）。
    // Last known public IP per tunnel (one overwritten row each, deleted with the tunnel).
    (
        "telepy_tunnel_endpoint",
        r#"CREATE TABLE "telepy_tunnel_endpoint" (
            "tunnel_id" integer NOT NULL PRIMARY KEY,
            "ip" varchar(64) NOT NULL,
            "connected_at" datetime NOT NULL,
            "last_seen_at" datetime NOT NULL
        )"#,
    ),
    // Rust 自有：裝置金鑰清單——哪些使用者金鑰要裝進這台裝置（依擁有者允許的 OS 帳號）。
    // Device key lists: which user keys Telepy installs on a device (into the owner's allowed accounts).
    (
        "telepy_device_key",
        r#"CREATE TABLE "telepy_device_key" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "tunnel_id" integer NOT NULL,
            "user_key_id" integer NOT NULL,
            "user_id" integer NOT NULL,
            "added_by_id" integer NOT NULL,
            "created_at" datetime NOT NULL,
            UNIQUE ("tunnel_id", "user_key_id")
        )"#,
    ),
    // Rust 自有：Telepy 實際寫進裝置 authorized_keys 的金鑰（只移除自己裝過的）。
    // Keys Telepy wrote into a device account's authorized_keys (it only ever removes these).
    (
        "telepy_device_key_installed",
        r#"CREATE TABLE "telepy_device_key_installed" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "tunnel_id" integer NOT NULL,
            "username" varchar(128) NOT NULL,
            "key_bare" text NOT NULL,
            "fingerprint" varchar(128) NOT NULL,
            "user_key_id" integer NULL,
            "user_id" integer NULL,
            "installed_at" datetime NOT NULL,
            UNIQUE ("tunnel_id", "username", "key_bare")
        )"#,
    ),
    // Rust 自有：每台裝置每個 OS 帳號最近一次同步的結果。/ Last sync result per device account.
    (
        "telepy_device_key_sync",
        r#"CREATE TABLE "telepy_device_key_sync" (
            "tunnel_id" integer NOT NULL,
            "username" varchar(128) NOT NULL,
            "ok" bool NOT NULL,
            "error" text NULL,
            "synced_at" datetime NOT NULL,
            PRIMARY KEY ("tunnel_id", "username")
        )"#,
    ),
    // Rust 自有：登入紀錄（成功與失敗；帶 IP，保留 90 天）。/ Sign-in history (carries IPs; 90 days).
    (
        "telepy_sign_in_event",
        r#"CREATE TABLE "telepy_sign_in_event" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "at" datetime NOT NULL,
            "user_id" integer NOT NULL,
            "ok" bool NOT NULL,
            "method" varchar(32) NOT NULL,
            "second_factor" varchar(32) NULL,
            "ip" varchar(64) NULL,
            "user_agent" varchar(512) NULL,
            "reason" varchar(64) NULL
        )"#,
    ),
    // Rust 自有：已套用的一次性 data migration。/ One-off data migrations already applied.
    (
        "telepy_data_migration",
        r#"CREATE TABLE "telepy_data_migration" (
            "name" varchar(128) NOT NULL PRIMARY KEY,
            "applied_at" datetime NOT NULL
        )"#,
    ),
];

const INDEXES: &[&str] = &[
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "telepy_lan_host_tunnel_address" ON "telepy_lan_host" ("tunnel_id", "address")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_passkey_user_id" ON "telepy_passkey" ("user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_recovery_code_user_id" ON "telepy_recovery_code" ("user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_ai_audit_event_user_id" ON "telepy_ai_audit_event" ("user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_sign_in_event_user_id" ON "telepy_sign_in_event" ("user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_sign_in_event_at" ON "telepy_sign_in_event" ("at")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_ai_audit_event_tunnel_id" ON "telepy_ai_audit_event" ("tunnel_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_ai_audit_event_at" ON "telepy_ai_audit_event" ("at")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_oauth_grant_user_id" ON "telepy_oauth_grant" ("user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_oauth_grant_client_id" ON "telepy_oauth_grant" ("client_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_device_key_user_key_id" ON "telepy_device_key" ("user_key_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_device_key_installed_user_key_id" ON "telepy_device_key_installed" ("user_key_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_gateway_event_at" ON "telepy_gateway_event" ("at")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_gateway_event_tunnel_id" ON "telepy_gateway_event" ("tunnel_id")"#,
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
    ("telepy_ai_audit_event", "ip", "varchar(64) NULL"),
    ("authorized_keys_reverseserverauthorizedkeys", "default_username_id", "INTEGER NULL"),
    ("authorized_keys_userauthorizedkeys", "last_used_at", "datetime NULL"),
    ("authorized_keys_userauthorizedkeys", "last_used_ip", "varchar(64) NULL"),
    ("site_settings_sitesettings", "valid_register_domains", "varchar(512) NOT NULL DEFAULT 'gmail.com'"),
    ("site_settings_sitesettings", "remote_browser_session_idle_timeout", "integer NOT NULL DEFAULT 60"),
    ("site_settings_sitesettings", "remote_browser_max_sessions", "integer NOT NULL DEFAULT 10"),
    ("site_settings_sitesettings", "remote_browser_geometry", "varchar(32) NOT NULL DEFAULT '1280x720'"),
    ("site_settings_sitesettings", "remote_browser_ssh_timeout", "integer NOT NULL DEFAULT 30"),
    ("site_settings_sitesettings", "remote_browser_ssh_attempts", "integer NOT NULL DEFAULT 2"),
    ("site_settings_sitesettings", "remote_browser_kasm_create_timeout", "integer NOT NULL DEFAULT 30"),
    ("site_settings_sitesettings", "remote_browser_homepage", "varchar(512) NOT NULL DEFAULT 'https://www.google.com'"),
    ("site_settings_sitesettings", "remote_browser_language", "varchar(16) NOT NULL DEFAULT 'zh-TW'"),
    ("site_settings_sitesettings", "ai_session_idle_timeout", "integer NOT NULL DEFAULT 600"),
    ("site_settings_sitesettings", "ai_session_max_lifetime", "integer NOT NULL DEFAULT 7200"),
    ("site_settings_sitesettings", "ai_max_sessions_per_user", "integer NOT NULL DEFAULT 3"),
    ("site_settings_sitesettings", "lan_scan_enabled", "bool NOT NULL DEFAULT 1"),
    ("user_management_usersettings", "theme", "varchar(8) NOT NULL DEFAULT 'system'"),
    ("user_management_usersettings", "terminal_font_size", "smallint unsigned NOT NULL DEFAULT 14"),
    // 介面顯示大小（百分比，85–130；前端把它設成 <html> 的 font-size）。/ UI display scale in percent.
    ("user_management_usersettings", "ui_scale", "smallint unsigned NOT NULL DEFAULT 100"),
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
            remote_browser_homepage, remote_browser_language, ai_session_idle_timeout, ai_session_max_lifetime, \
            ai_max_sessions_per_user, lan_scan_enabled) \
         SELECT 1, 0, 'gmail.com', 60, 10, '1280x720', 30, 2, 30, 'https://www.google.com', 'zh-TW', 600, 7200, 3, 1 \
         WHERE NOT EXISTS (SELECT 1 FROM site_settings_sitesettings WHERE id = 1)",
    )
    .execute(pool)
    .await?;
    run_data_migrations(pool).await
}

/// 只有擁有者 / ADMIN 能管理 OS 帳號之後，非 ADMIN 被分享者以前自己建的 username 一律失效（連同允許清單與預設值）。
pub const DROP_SHAREE_USERNAMES: &str = "2026-10-22-drop-usernames-created-by-non-admin-sharees";

/// 依序套用還沒跑過的一次性 data migration（同一個 transaction 裡寫入完成紀錄）。
pub async fn run_data_migrations(pool: &SqlitePool) -> anyhow::Result<()> {
    let applied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_data_migration WHERE name = ?").bind(DROP_SHAREE_USERNAMES).fetch_one(pool).await?;
    if applied > 0 {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    let victims: Vec<i64> = sqlx::query_scalar(
        "SELECT u.id FROM authorized_keys_reverseserverusernames u \
         JOIN authorized_keys_reverseserverauthorizedkeys t ON t.id = u.reverse_server_id \
         WHERE u.user_id <> t.user_id AND NOT EXISTS ( \
             SELECT 1 FROM tunnels_tunnelsharing s \
             WHERE s.tunnel_id = t.id AND s.shared_with_id = u.user_id AND LOWER(s.permission_type) = 'admin')",
    )
    .fetch_all(&mut *tx)
    .await?;
    for id in &victims {
        sqlx::query("DELETE FROM tunnels_tunnelsharingallowedusername WHERE reverse_server_username_id = ?").bind(id).execute(&mut *tx).await?;
        sqlx::query("UPDATE authorized_keys_reverseserverauthorizedkeys SET default_username_id = NULL WHERE default_username_id = ?").bind(id).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM authorized_keys_reverseserverusernames WHERE id = ?").bind(id).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO telepy_data_migration (name, applied_at) VALUES (?, ?)").bind(DROP_SHAREE_USERNAMES).bind(crate::util::now_db()).execute(&mut *tx).await?;
    tx.commit().await?;
    if !victims.is_empty() {
        tracing::info!(removed = victims.len(), "data migration: dropped target usernames created by non-admin sharees");
    }
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
