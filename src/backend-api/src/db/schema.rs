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
            "terminal_font" varchar(32) NOT NULL DEFAULT 'hack',
            "terminal_scheme" varchar(32) NOT NULL DEFAULT 'telepy',
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
            "last_seen_at" datetime NOT NULL,
            "previous_ip" varchar(64) NULL,
            "changed_at" datetime NULL,
            "public_ip" varchar(64) NULL,
            "public_source" varchar(16) NULL,
            "lan" text NULL,
            "hostname" varchar(255) NULL,
            "probed_at" datetime NULL,
            "probe_error" text NULL
        )"#,
    ),
    // Rust 自有：隧道連線紀錄（一個 forward 一列），給連線紀錄與在線率。/ Connection history, one row per forward.
    (
        "telepy_tunnel_session",
        r#"CREATE TABLE "telepy_tunnel_session" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "tunnel_id" integer NOT NULL,
            "ip" varchar(64) NOT NULL,
            "connected_at" datetime NOT NULL,
            "disconnected_at" datetime NULL
        )"#,
    ),
    // Rust 自有：每個使用者自己的隧道釘選。/ Per-user tunnel pins.
    (
        "telepy_tunnel_pin",
        r#"CREATE TABLE "telepy_tunnel_pin" (
            "user_id" integer NOT NULL,
            "tunnel_id" integer NOT NULL,
            "created_at" datetime NOT NULL,
            PRIMARY KEY ("user_id", "tunnel_id")
        )"#,
    ),
    // Rust 自有：存取申請——被分享的人要求某些帳號或更高權限一段時間，由 owner / ADMIN 核准。
    // Access requests: a sharee asks for accounts or a higher permission for a while; the owner / an ADMIN decides.
    (
        "telepy_access_request",
        r#"CREATE TABLE "telepy_access_request" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "tunnel_id" integer NOT NULL,
            "requester_id" integer NOT NULL,
            "username_ids" text NOT NULL,
            "permission" varchar(10) NULL,
            "duration_secs" integer NOT NULL,
            "reason" text NOT NULL,
            "status" varchar(16) NOT NULL,
            "created_at" datetime NOT NULL,
            "decided_by_id" integer NULL,
            "decided_at" datetime NULL,
            "ends_at" datetime NULL
        )"#,
    ),
    // Rust 自有：網頁終端機錄影（asciicast v2 檔放在 DATA_DIR/recordings；這裡是索引）。
    // Web terminal recordings (asciicast v2 files under DATA_DIR/recordings; this is the index).
    (
        "telepy_terminal_recording",
        r#"CREATE TABLE "telepy_terminal_recording" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "tunnel_id" integer NOT NULL,
            "user_id" integer NOT NULL,
            "username" varchar(150) NOT NULL,
            "os_user" varchar(150) NOT NULL,
            "lan_host" varchar(255) NULL,
            "file" varchar(255) NOT NULL,
            "started_at" datetime NOT NULL,
            "ended_at" datetime NULL,
            "duration_ms" integer NOT NULL DEFAULT 0,
            "bytes" integer NOT NULL DEFAULT 0,
            "truncated" bool NOT NULL DEFAULT 0
        )"#,
    ),
    // Rust 自有：指令規則（網頁終端機與 MCP agent 的指令；tunnel_id NULL = 全站）。
    // Command rules for the web terminal and MCP agents (NULL tunnel_id = site-wide).
    (
        "telepy_command_rule",
        r#"CREATE TABLE "telepy_command_rule" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "tunnel_id" integer NULL,
            "action" varchar(16) NOT NULL,
            "kind" varchar(16) NOT NULL,
            "pattern" text NOT NULL,
            "who" varchar(16) NOT NULL,
            "via" varchar(16) NOT NULL,
            "note" text NOT NULL,
            "enabled" bool NOT NULL DEFAULT 1,
            "created_by_id" integer NULL,
            "created_at" datetime NOT NULL,
            "updated_at" datetime NOT NULL
        )"#,
    ),
    // Rust 自有：被規則擋下或送去核准的指令（誰、哪裡、哪條規則、結果）。
    // Commands a rule blocked or held for approval (who, where, which rule, outcome).
    (
        "telepy_command_event",
        r#"CREATE TABLE "telepy_command_event" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "tunnel_id" integer NOT NULL,
            "user_id" integer NOT NULL,
            "username" varchar(150) NOT NULL,
            "source" varchar(16) NOT NULL,
            "client" varchar(255) NULL,
            "grant_id" integer NULL,
            "session_ref" varchar(64) NULL,
            "account" varchar(150) NOT NULL,
            "lan_host" varchar(255) NULL,
            "command" text NOT NULL,
            "rule_id" integer NULL,
            "rule_pattern" text NOT NULL,
            "rule_kind" varchar(16) NOT NULL,
            "rule_scope" varchar(16) NOT NULL,
            "rule_note" text NOT NULL,
            "status" varchar(16) NOT NULL,
            "created_at" datetime NOT NULL,
            "expires_at" datetime NULL,
            "decided_by_id" integer NULL,
            "decided_by" varchar(150) NULL,
            "decided_at" datetime NULL,
            "reason" text NOT NULL,
            "used_at" datetime NULL
        )"#,
    ),
    // Rust 自有：隧道標籤（所有看得到隧道的人共用）。/ Tunnel labels, shared by everyone who sees the tunnel.
    (
        "telepy_tunnel_label",
        r#"CREATE TABLE "telepy_tunnel_label" (
            "tunnel_id" integer NOT NULL,
            "label" varchar(32) NOT NULL,
            PRIMARY KEY ("tunnel_id", "label")
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
    // Rust 自有：稽核雜湊鏈的錨點——prune（被刪的最新一列）與 checkpoint（寫到外部檔的鏈頭）。
    // Audit hash-chain anchors: prune (newest deleted row) and checkpoint (head written to the anchors file).
    (
        "telepy_audit_anchor",
        r#"CREATE TABLE "telepy_audit_anchor" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "at" datetime NOT NULL,
            "table_name" varchar(64) NOT NULL,
            "kind" varchar(16) NOT NULL,
            "row_id" integer NOT NULL,
            "row_hash" varchar(64) NULL
        )"#,
    ),
    // Rust 自有：某使用者對某條隧道的終端機外觀覆寫（字型 / 字級 / 配色）；NULL 欄位 = 跟隨
    // user_management_usersettings 的個人預設。隧道刪除時一併刪（db::tunnels::delete）。
    // Per-user terminal appearance override for one tunnel (font / size / colour scheme); a NULL field
    // inherits the personal default in user_management_usersettings. Deleted with the tunnel.
    (
        "telepy_terminal_profile",
        r#"CREATE TABLE "telepy_terminal_profile" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "user_id" integer NOT NULL,
            "tunnel_id" integer NOT NULL,
            "font" varchar(32) NULL,
            "font_size" smallint NULL,
            "scheme" varchar(32) NULL,
            "updated_at" datetime NOT NULL
        )"#,
    ),
    // Rust 自有：網頁登入 session（refresh token 的 sid）；見 db/web_sessions.rs。
    // Web sign-in sessions (the refresh token's sid); see db/web_sessions.rs.
    (
        "telepy_web_session",
        r#"CREATE TABLE "telepy_web_session" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "user_id" integer NOT NULL,
            "jti" varchar(32) NOT NULL,
            "prev_jti" varchar(32) NULL,
            "rotated_at" datetime NOT NULL,
            "created_at" datetime NOT NULL,
            "last_used_at" datetime NOT NULL,
            "expires_at" datetime NOT NULL,
            "revoked_at" datetime NULL,
            "revoked_reason" varchar(16) NULL,
            "ip" varchar(45) NULL,
            "user_agent" varchar(256) NULL
        )"#,
    ),
    // Rust 自有：裝置 SSH host key 釘選（pinned / rejected），隧道刪除時一併刪。
    // Pinned and rejected device SSH host keys per tunnel; deleted with the tunnel.
    (
        "telepy_device_host_key",
        r#"CREATE TABLE "telepy_device_host_key" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "tunnel_id" integer NOT NULL,
            "status" varchar(16) NOT NULL,
            "key_type" varchar(64) NOT NULL,
            "fingerprint" varchar(128) NOT NULL,
            "public_key" text NOT NULL,
            "source" varchar(16) NOT NULL,
            "attempts" integer NOT NULL DEFAULT 0,
            "first_seen" datetime NOT NULL,
            "last_seen" datetime NOT NULL
        )"#,
    ),
    // Rust 自有：每條隧道自己的服務金鑰（私鑰以 SECRET_KEY 衍生的金鑰密封），隧道刪除時一併刪。
    // One service key pair per tunnel (private key sealed with the vault); deleted with the tunnel.
    (
        "telepy_tunnel_service_key",
        r#"CREATE TABLE "telepy_tunnel_service_key" (
            "tunnel_id" integer NOT NULL PRIMARY KEY,
            "public_key" text NOT NULL,
            "private_key" text NOT NULL,
            "fingerprint" varchar(128) NOT NULL,
            "created_at" datetime NOT NULL,
            "verified_at" datetime NULL
        )"#,
    ),
    // Rust 自有：隧道金鑰裝到了哪個 OS 帳號、用它登入成功過沒有（共用金鑰只在每條隧道都驗證過後才移除）。
    // Which accounts hold the tunnel's key and whether a login with it succeeded there.
    (
        "telepy_tunnel_key_account",
        r#"CREATE TABLE "telepy_tunnel_key_account" (
            "tunnel_id" integer NOT NULL,
            "username" varchar(150) NOT NULL,
            "installed_at" datetime NULL,
            "verified_at" datetime NULL,
            PRIMARY KEY ("tunnel_id", "username")
        )"#,
    ),
    // Rust 自有：憑證庫（遠端桌面的登入，密碼只存密文），隧道 / 區網主機刪除時一併刪。
    // Credential vault (saved desktop logins, password sealed); deleted with the tunnel or the LAN host.
    (
        "telepy_credential",
        r#"CREATE TABLE "telepy_credential" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "user_id" integer NOT NULL,
            "label" varchar(100) NOT NULL,
            "protocol" varchar(8) NOT NULL,
            "tunnel_id" integer NOT NULL,
            "lan_host_id" integer NULL,
            "port" integer NULL,
            "login" varchar(256) NOT NULL,
            "domain" varchar(256) NOT NULL,
            "secret" text NOT NULL,
            "created_at" datetime NOT NULL,
            "updated_at" datetime NOT NULL,
            "last_used_at" datetime NULL
        )"#,
    ),
    // 登記在 Telepy（當 RustDesk 的 ID 伺服器）的 RustDesk 裝置；不經 SSH。/ RustDesk devices enrolled with Telepy's ID server.
    (
        "telepy_rustdesk_device",
        r#"CREATE TABLE "telepy_rustdesk_device" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "user_id" integer NOT NULL,
            "rustdesk_id" varchar(32) NOT NULL,
            "uuid" varchar(128) NOT NULL,
            "pk" varchar(128) NOT NULL,
            "name" varchar(64) NOT NULL,
            "hostname" varchar(255) NOT NULL,
            "os" varchar(255) NOT NULL,
            "version" varchar(32) NOT NULL,
            "created_at" datetime NOT NULL,
            "last_seen_at" datetime NULL
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
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "telepy_terminal_profile_user_tunnel" ON "telepy_terminal_profile" ("user_id", "tunnel_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_web_session_user" ON "telepy_web_session" ("user_id")"#,
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
    r#"CREATE INDEX IF NOT EXISTS "telepy_audit_anchor_table_name_id" ON "telepy_audit_anchor" ("table_name", "id")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "telepy_device_host_key_tunnel_key" ON "telepy_device_host_key" ("tunnel_id", "public_key")"#,
    // 同一把 host key 被哪些隧道信任（= 同一台機器）。/ Which tunnels trust one host key (= the same machine).
    r#"CREATE INDEX IF NOT EXISTS "telepy_device_host_key_public_key" ON "telepy_device_host_key" ("public_key")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_credential_user" ON "telepy_credential" ("user_id")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "telepy_rustdesk_device_rustdesk_id" ON "telepy_rustdesk_device" ("rustdesk_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_rustdesk_device_user" ON "telepy_rustdesk_device" ("user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_gateway_event_at" ON "telepy_gateway_event" ("at")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_tunnel_session_tunnel" ON "telepy_tunnel_session" ("tunnel_id", "connected_at")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_terminal_recording_tunnel" ON "telepy_terminal_recording" ("tunnel_id", "started_at")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_access_request_tunnel" ON "telepy_access_request" ("tunnel_id", "status")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_command_rule_tunnel" ON "telepy_command_rule" ("tunnel_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_command_event_tunnel" ON "telepy_command_event" ("tunnel_id", "status")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_command_event_user" ON "telepy_command_event" ("user_id")"#,
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
    ("telepy_tunnel_endpoint", "previous_ip", "varchar(64) NULL"),
    ("telepy_tunnel_endpoint", "changed_at", "datetime NULL"),
    ("telepy_tunnel_endpoint", "public_ip", "varchar(64) NULL"),
    ("telepy_tunnel_endpoint", "public_source", "varchar(16) NULL"),
    ("telepy_tunnel_endpoint", "lan", "text NULL"),
    ("telepy_tunnel_endpoint", "hostname", "varchar(255) NULL"),
    ("telepy_tunnel_endpoint", "probed_at", "datetime NULL"),
    ("telepy_tunnel_endpoint", "probe_error", "text NULL"),
    ("telepy_ai_audit_event", "ip", "varchar(64) NULL"),
    // 稽核雜湊鏈（升級前的列為 NULL）。/ Audit hash chain (NULL on rows written before the upgrade).
    ("telepy_gateway_event", "prev_hash", "varchar(64) NULL"),
    ("telepy_gateway_event", "hash", "varchar(64) NULL"),
    ("telepy_sign_in_event", "prev_hash", "varchar(64) NULL"),
    ("telepy_sign_in_event", "hash", "varchar(64) NULL"),
    ("telepy_ai_audit_event", "prev_hash", "varchar(64) NULL"),
    ("telepy_ai_audit_event", "hash", "varchar(64) NULL"),
    ("authorized_keys_reverseserverauthorizedkeys", "default_username_id", "INTEGER NULL"),
    ("authorized_keys_userauthorizedkeys", "last_used_at", "datetime NULL"),
    ("authorized_keys_userauthorizedkeys", "last_used_ip", "varchar(64) NULL"),
    // 個人金鑰的到期時間（NULL = 不到期）。/ Personal key expiry (NULL = never).
    ("authorized_keys_userauthorizedkeys", "expires_at", "datetime NULL"),
    // 限時分享：到期時間（NULL = 一直有效）。/ Timed sharing: when the share ends (NULL = never).
    ("tunnels_tunnelsharing", "expires_at", "datetime NULL"),
    // 核准的存取申請：暫時的帳號（到期就移除）與暫時提升的權限（到期回到 base_permission）。
    // Approved access requests: temporary accounts (removed at expiry) and a temporary permission (back to base_permission).
    ("tunnels_tunnelsharingallowedusername", "expires_at", "datetime NULL"),
    ("tunnels_tunnelsharing", "base_permission", "varchar(10) NULL"),
    ("tunnels_tunnelsharing", "permission_until", "datetime NULL"),
    // 敏感隧道：開 session 前要再確認一次是你（step-up）。/ Sensitive tunnel: step-up before opening a session.
    ("authorized_keys_reverseserverauthorizedkeys", "require_step_up", "bool NOT NULL DEFAULT 0"),
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
    // 隧道狀態告警的 webhook（空 = 關閉）與「斷線多久才通知」（秒）。/ Status alert webhook (empty = off) and its delay.
    ("site_settings_sitesettings", "notify_webhook_url", "varchar(512) NOT NULL DEFAULT ''"),
    ("site_settings_sitesettings", "notify_down_delay", "integer NOT NULL DEFAULT 60"),
    // 個人金鑰最長效期（天，0 = 不限）。/ Longest a personal key may be valid, in days (0 = no limit).
    ("site_settings_sitesettings", "user_key_max_days", "integer NOT NULL DEFAULT 0"),
    ("site_settings_sitesettings", "desktop_enabled", "bool NOT NULL DEFAULT 1"),
    ("site_settings_sitesettings", "desktop_max_sessions", "integer NOT NULL DEFAULT 4"),
    ("site_settings_sitesettings", "desktop_session_idle_timeout", "integer NOT NULL DEFAULT 900"),
    ("site_settings_sitesettings", "desktop_clipboard", "varchar(16) NOT NULL DEFAULT 'both'"),
    ("site_settings_sitesettings", "desktop_max_resolution", "integer NOT NULL DEFAULT 2560"),
    // 管理員要求每個帳號都要有 TOTP / passkey（各自獨立）。/ Admin-required second factors, one switch each.
    ("site_settings_sitesettings", "mfa_require_totp", "bool NOT NULL DEFAULT 0"),
    ("site_settings_sitesettings", "mfa_require_passkey", "bool NOT NULL DEFAULT 0"),
    // 終端機錄影留幾天（0 = 一直留）。/ How long terminal recordings are kept (0 = forever).
    ("site_settings_sitesettings", "recording_retention_days", "integer NOT NULL DEFAULT 30"),
    // 這條隧道的網頁終端機要錄影。/ Record this tunnel's web terminal sessions.
    ("authorized_keys_reverseserverauthorizedkeys", "record_sessions", "bool NOT NULL DEFAULT 0"),
    ("site_settings_sitesettings", "command_approval_timeout", "integer NOT NULL DEFAULT 300"),
    // 網頁登入效期（秒）：沒有任何造訪多久後要重新登入（每次續期往後推，預設 30 天）、access token 多久換一次（預設 1 小時）。
    // Web sign-in lifetimes (seconds): how long a sign-in lasts without a visit (sliding, 30 days) and how often the access token is renewed (1 hour).
    ("site_settings_sitesettings", "signin_lifetime", "integer NOT NULL DEFAULT 2592000"),
    ("site_settings_sitesettings", "signin_access_lifetime", "integer NOT NULL DEFAULT 3600"),
    // Telepy 當 RustDesk 的 ID / 中繼伺服器（登記過的裝置不經 SSH 也能連）。/ Telepy as RustDesk's ID and relay server.
    ("site_settings_sitesettings", "desktop_rustdesk_server", "bool NOT NULL DEFAULT 1"),
    ("user_management_usersettings", "theme", "varchar(8) NOT NULL DEFAULT 'system'"),
    ("user_management_usersettings", "terminal_font_size", "smallint unsigned NOT NULL DEFAULT 14"),
    // 介面顯示大小（百分比，85–130；前端把它設成 <html> 的 font-size）。/ UI display scale in percent.
    ("user_management_usersettings", "ui_scale", "smallint unsigned NOT NULL DEFAULT 100"),
    // 終端機字型 / 配色 id（清單在前端 lib/terminalAppearance.ts）。/ Terminal font / colour-scheme ids.
    ("user_management_usersettings", "terminal_font", "varchar(32) NOT NULL DEFAULT 'hack'"),
    ("user_management_usersettings", "terminal_scheme", "varchar(32) NOT NULL DEFAULT 'telepy'"),
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
            ai_max_sessions_per_user, lan_scan_enabled, desktop_enabled, desktop_max_sessions, \
            desktop_session_idle_timeout, desktop_clipboard, desktop_max_resolution, mfa_require_totp, mfa_require_passkey) \
         SELECT 1, 0, 'gmail.com', 60, 10, '1280x720', 30, 2, 30, 'https://www.google.com', 'zh-TW', 600, 7200, 3, 1, \
            1, 4, 900, 'both', 2560, 0, 0 \
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
