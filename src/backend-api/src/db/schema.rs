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
            "desktop_clipboard" varchar(16) NOT NULL DEFAULT 'both',
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
    // Rust 自有：個人 API token（祕密只存 SHA-256；scope、隧道限制、必填的到期時間）。/ Personal API tokens.
    (
        "telepy_api_token",
        r#"CREATE TABLE "telepy_api_token" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "user_id" integer NOT NULL,
            "name" varchar(100) NOT NULL,
            "prefix" varchar(16) NOT NULL,
            "token_hash" varchar(64) NOT NULL UNIQUE,
            "scope" varchar(256) NOT NULL,
            "tunnel_ids" text NULL,
            "expires_at" datetime NOT NULL,
            "created_at" datetime NOT NULL,
            "last_used_at" datetime NULL,
            "last_used_ip" varchar(64) NULL,
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
            "probe_error" text NULL,
            "facts" text NULL,
            "facts_at" datetime NULL
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
    // Rust 自有：指令規則套用的隧道（`all_tunnels` = 0 的規則才有）。/ The tunnels a command rule is limited to.
    (
        "telepy_command_rule_target",
        r#"CREATE TABLE "telepy_command_rule_target" (
            "rule_id" integer NOT NULL,
            "tunnel_id" integer NOT NULL,
            PRIMARY KEY ("rule_id", "tunnel_id")
        )"#,
    ),
    // Rust 自有：某人對一條規則的覆寫（`off` = 隧道的 owner / ADMIN 在自己管的隧道上關掉一條「允許覆寫」的全站規則；
    // `mute` = 自己靜音一條「提醒」規則）；隧道清單在 `telepy_command_rule_override_target`（`all_tunnels` = 0 才有）。
    // Someone's override of a rule (`off` = an owner / ADMIN turns an overridable site rule off on tunnels they manage;
    // `mute` = muting a reminder rule for yourself); the tunnels are in `telepy_command_rule_override_target`.
    (
        "telepy_command_rule_override",
        r#"CREATE TABLE "telepy_command_rule_override" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "rule_id" integer NOT NULL,
            "user_id" integer NOT NULL,
            "kind" varchar(8) NOT NULL,
            "all_tunnels" bool NOT NULL DEFAULT 1,
            "created_at" datetime NOT NULL
        )"#,
    ),
    (
        "telepy_command_rule_override_target",
        r#"CREATE TABLE "telepy_command_rule_override_target" (
            "override_id" integer NOT NULL,
            "tunnel_id" integer NOT NULL,
            PRIMARY KEY ("override_id", "tunnel_id")
        )"#,
    ),
    // Rust 自有：工具箱的指令片段（scope user = 某人的、tunnel = 某條隧道的、site = 全站）。
    // Toolbox command snippets (scope user = someone's own, tunnel = one tunnel's, site = site-wide).
    (
        "telepy_snippet",
        r#"CREATE TABLE "telepy_snippet" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "scope" varchar(8) NOT NULL,
            "user_id" integer NULL,
            "tunnel_id" integer NULL,
            "name" varchar(60) NOT NULL,
            "command" text NOT NULL,
            "description" text NOT NULL,
            "variables" text NOT NULL,
            "confirm" bool NOT NULL DEFAULT 0,
            "sort_order" integer NOT NULL DEFAULT 0,
            "use_count" integer NOT NULL DEFAULT 0,
            "last_used_at" datetime NULL,
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
    // Rust 自有：通道群組——每個人自己的資料夾（一條通道在一個人那裡最多屬於一組）；見 db/groups.rs。
    // Tunnel groups: personal folders (a tunnel is in at most one of a person's groups); see db/groups.rs.
    (
        "telepy_tunnel_group",
        r#"CREATE TABLE "telepy_tunnel_group" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "user_id" integer NOT NULL,
            "name" varchar(48) NOT NULL,
            "position" integer NOT NULL DEFAULT 0,
            "created_at" datetime NOT NULL,
            UNIQUE ("user_id", "name")
        )"#,
    ),
    (
        "telepy_tunnel_group_member",
        r#"CREATE TABLE "telepy_tunnel_group_member" (
            "user_id" integer NOT NULL,
            "tunnel_id" integer NOT NULL,
            "group_id" integer NOT NULL,
            "created_at" datetime NOT NULL,
            PRIMARY KEY ("user_id", "tunnel_id")
        )"#,
    ),
    // Rust 自有：金鑰群組——自己的金鑰分組（一把金鑰最多一組），整組授予通道或通道群組。
    // Key groups: a person's own keys in groups (a key is in at most one), granted as a unit to tunnels or tunnel groups.
    (
        "telepy_key_group",
        r#"CREATE TABLE "telepy_key_group" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "user_id" integer NOT NULL,
            "name" varchar(48) NOT NULL,
            "created_at" datetime NOT NULL,
            UNIQUE ("user_id", "name")
        )"#,
    ),
    (
        "telepy_key_group_member",
        r#"CREATE TABLE "telepy_key_group_member" (
            "user_key_id" integer NOT NULL PRIMARY KEY,
            "group_id" integer NOT NULL,
            "created_at" datetime NOT NULL
        )"#,
    ),
    // 授予：金鑰群組 → 一條通道（`tunnel_id`）或自己的一個通道群組（`tunnel_group_id`），兩者只有一個；
    // `accounts` = 只裝到這些帳號名稱（JSON；NULL = 每個允許的帳號）。
    // A grant: key group → one tunnel or one of the owner's tunnel groups (exactly one is set); `accounts` = account
    // names to limit it to (JSON; NULL = every allowed account).
    (
        "telepy_key_group_grant",
        r#"CREATE TABLE "telepy_key_group_grant" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "key_group_id" integer NOT NULL,
            "tunnel_id" integer NULL,
            "tunnel_group_id" integer NULL,
            "accounts" text NULL,
            "created_at" datetime NOT NULL,
            UNIQUE ("key_group_id", "tunnel_id"),
            UNIQUE ("key_group_id", "tunnel_group_id")
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
    // Rust 自有：從裝置帳號的 authorized_keys 批次移除的行（7 天內可還原）。/ Lines removed from a device account's
    // authorized_keys by hand, kept 7 days so the removal can be undone.
    (
        "telepy_device_key_removal",
        r#"CREATE TABLE "telepy_device_key_removal" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "tunnel_id" integer NOT NULL,
            "username" varchar(128) NOT NULL,
            "lines" text NOT NULL,
            "keys" integer NOT NULL,
            "removed_by_id" integer NOT NULL,
            "removed_by" varchar(150) NOT NULL,
            "removed_at" datetime NOT NULL,
            "restored_at" datetime NULL
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
            "bold" varchar(8) NULL,
            "ligatures" bool NULL,
            "updated_at" datetime NOT NULL
        )"#,
    ),
    // Rust 自有：某使用者在某條隧道上「連線中打的指令不寫進 shell 歷史檔」的個人覆寫（mode = keep / skip）；
    // 沒有列 = 跟隨 user_management_usersettings.shell_history。隧道刪除時一併刪（db::tunnels::delete）。
    // Per-user override of "keep this connection's commands out of the shell history" for one tunnel (keep / skip);
    // no row = the personal default in user_management_usersettings.shell_history. Deleted with the tunnel.
    (
        "telepy_shell_history_pref",
        r#"CREATE TABLE "telepy_shell_history_pref" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "user_id" integer NOT NULL,
            "tunnel_id" integer NOT NULL,
            "mode" varchar(8) NOT NULL,
            "updated_at" datetime NOT NULL
        )"#,
    ),
    // Rust 自有：使用者自訂的終端機配色（colors = JSON：前景 / 背景 / 游標 / 選取 + 16 色 ANSI，都是 #rrggbb）。
    // scheme_id 是 API 上的 id（`custom-<8 hex>`），存在 terminal_scheme / 每條隧道的覆寫裡；刪掉後前端回到預設配色。
    // User-defined terminal colour schemes (colors = JSON: foreground / background / cursor / selection + the 16 ANSI
    // colours, all #rrggbb). scheme_id is the API id (`custom-<8 hex>`) referenced by terminal_scheme and per-tunnel
    // overrides; once deleted the frontend falls back to the default scheme.
    (
        "telepy_terminal_scheme",
        r#"CREATE TABLE "telepy_terminal_scheme" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "user_id" integer NOT NULL,
            "scheme_id" varchar(32) NOT NULL UNIQUE,
            "name" varchar(40) NOT NULL,
            "colors" text NOT NULL,
            "created_at" datetime NOT NULL,
            "updated_at" datetime NOT NULL
        )"#,
    ),
    // Rust 自有：站內通知偏好（見 notify_prefs.rs）。全站預設：每個事件 × 管道（toast / desktop）一列，
    // enabled NULL = 內建（開），locked = 管理員強制（使用者不能關）。個人的：只存有覆寫的。靜音：每人每條隧道一列。
    // In-app notification preferences (see notify_prefs.rs): site defaults per event × channel (enabled NULL =
    // built-in on, locked = enforced), personal overrides only where set, and per-person tunnel mutes.
    (
        "telepy_notify_default",
        r#"CREATE TABLE "telepy_notify_default" (
            "event" varchar(64) NOT NULL,
            "channel" varchar(16) NOT NULL,
            "enabled" bool NULL,
            "locked" bool NOT NULL DEFAULT 0,
            "updated_at" datetime NOT NULL,
            PRIMARY KEY ("event", "channel")
        )"#,
    ),
    // Rust 自有：管理員對「伺服器狀態」某項 ⚠ / ✗ 的確認（每項一筆；指紋不同 = 問題變了，確認不再算）。見 db/health_acks.rs。
    // An admin's acknowledgement of a Server health warning / failure (one per check; a different fingerprint =
    // the problem changed and the acknowledgement no longer counts). See db/health_acks.rs.
    (
        "telepy_health_ack",
        r#"CREATE TABLE "telepy_health_ack" (
            "check_id" TEXT NOT NULL PRIMARY KEY,
            "fingerprint" TEXT NOT NULL,
            "status" TEXT NOT NULL,
            "note" TEXT NOT NULL,
            "user_id" INTEGER NULL,
            "username" TEXT NOT NULL,
            "at" TEXT NOT NULL
        )"#,
    ),
    (
        "telepy_notify_pref",
        r#"CREATE TABLE "telepy_notify_pref" (
            "user_id" integer NOT NULL,
            "event" varchar(64) NOT NULL,
            "channel" varchar(16) NOT NULL,
            "enabled" bool NOT NULL,
            "updated_at" datetime NOT NULL,
            PRIMARY KEY ("user_id", "event", "channel")
        )"#,
    ),
    (
        "telepy_notify_tunnel_mute",
        r#"CREATE TABLE "telepy_notify_tunnel_mute" (
            "user_id" integer NOT NULL,
            "tunnel_id" integer NOT NULL,
            "scope" varchar(16) NOT NULL,
            "created_at" datetime NOT NULL,
            PRIMARY KEY ("user_id", "tunnel_id")
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
            "secret_kinds" varchar(32) NOT NULL DEFAULT '',
            "created_at" datetime NOT NULL,
            "updated_at" datetime NOT NULL,
            "last_used_at" datetime NULL
        )"#,
    ),
    // Rust 自有：webhook（個人的 = 某個使用者自己的；site = 管理員們共管的全站 webhook）。
    // Webhooks: personal ones belong to one user; site-wide ones are shared by the admins.
    (
        "telepy_webhook",
        r#"CREATE TABLE "telepy_webhook" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "user_id" integer NULL,
            "scope" varchar(8) NOT NULL,
            "name" varchar(80) NOT NULL,
            "url" varchar(1024) NOT NULL,
            "format" varchar(16) NOT NULL,
            "language" varchar(8) NOT NULL DEFAULT 'en',
            "events" text NOT NULL,
            "all_tunnels" bool NOT NULL DEFAULT 1,
            "delay" integer NOT NULL DEFAULT 60,
            "secret" text NOT NULL DEFAULT '',
            "enabled" bool NOT NULL DEFAULT 1,
            "paused_reason" varchar(32) NOT NULL DEFAULT '',
            "failures" integer NOT NULL DEFAULT 0,
            "last_status" varchar(8) NOT NULL DEFAULT '',
            "last_at" datetime NULL,
            "last_code" integer NULL,
            "last_error" text NOT NULL DEFAULT '',
            "created_at" datetime NOT NULL,
            "updated_at" datetime NOT NULL,
            "headers" text NOT NULL DEFAULT ''
        )"#,
    ),
    // Rust 自有：webhook 只收這幾條隧道（all_tunnels = 0 時）。/ The tunnels a webhook is limited to.
    (
        "telepy_webhook_tunnel",
        r#"CREATE TABLE "telepy_webhook_tunnel" (
            "webhook_id" integer NOT NULL,
            "tunnel_id" integer NOT NULL,
            PRIMARY KEY ("webhook_id", "tunnel_id")
        )"#,
    ),
    // Rust 自有：webhook 最近的送出紀錄（每個 webhook 留最新 50 筆）。/ Recent deliveries, the latest 50 per webhook.
    (
        "telepy_webhook_delivery",
        r#"CREATE TABLE "telepy_webhook_delivery" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "webhook_id" integer NOT NULL,
            "event" varchar(48) NOT NULL,
            "message_id" varchar(40) NOT NULL,
            "at" datetime NOT NULL,
            "status" varchar(8) NOT NULL,
            "http_status" integer NULL,
            "error" text NOT NULL DEFAULT '',
            "attempts" integer NOT NULL DEFAULT 1,
            "duration_ms" integer NOT NULL DEFAULT 0,
            "test" bool NOT NULL DEFAULT 0,
            "body" text NOT NULL DEFAULT '',
            "event_json" text NOT NULL DEFAULT '',
            "redelivered_from" integer NULL
        )"#,
    ),
    // Rust 自有：隧道的 owner / ADMIN 把自己的隧道退出某個「預設」全站 webhook（強制的不理會）。
    // A tunnel's owner / ADMIN opting that tunnel out of a "default" site-wide webhook (enforced ones ignore it).
    (
        "telepy_webhook_optout",
        r#"CREATE TABLE "telepy_webhook_optout" (
            "webhook_id" integer NOT NULL,
            "user_id" integer NOT NULL,
            "tunnel_id" integer NOT NULL,
            "created_at" datetime NOT NULL,
            PRIMARY KEY ("webhook_id", "user_id", "tunnel_id")
        )"#,
    ),
    // Rust 自有：個人 SSH 金鑰的到期通知送過了沒（每把金鑰、每個階段、每個到期時間一次）。
    // Which personal SSH key expiry notices were sent (once per key, stage and expiry time).
    (
        "telepy_key_expiry_notice",
        r#"CREATE TABLE "telepy_key_expiry_notice" (
            "key_id" integer NOT NULL,
            "stage" varchar(8) NOT NULL,
            "expires_at" datetime NOT NULL,
            "sent_at" datetime NOT NULL,
            PRIMARY KEY ("key_id", "stage")
        )"#,
    ),
    // Rust 自有：功能權限的群組（誰可以用哪些 Telepy 功能；跟隧道分享無關）。
    // Feature-permission groups (who may use which Telepy features; unrelated to tunnel sharing).
    (
        "telepy_user_group",
        r#"CREATE TABLE "telepy_user_group" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "name" varchar(64) NOT NULL UNIQUE,
            "description" varchar(256) NOT NULL DEFAULT '',
            "created_at" datetime NOT NULL
        )"#,
    ),
    (
        "telepy_user_group_member",
        r#"CREATE TABLE "telepy_user_group_member" (
            "group_id" integer NOT NULL,
            "user_id" integer NOT NULL,
            PRIMARY KEY ("group_id", "user_id")
        )"#,
    ),
    // 一列 = 某個對象（user / group / everyone）對某個功能的允許或拒絕；沒有列 = 沿用上一層。
    // One row = allow or deny of one feature for a subject (user / group / everyone); no row = inherit.
    (
        "telepy_feature_grant",
        r#"CREATE TABLE "telepy_feature_grant" (
            "subject_kind" varchar(8) NOT NULL,
            "subject_id" integer NOT NULL,
            "feature" varchar(32) NOT NULL,
            "allowed" bool NOT NULL,
            "updated_at" datetime NOT NULL,
            PRIMARY KEY ("subject_kind", "subject_id", "feature")
        )"#,
    ),
    // Rust 自有：委派 token（個人 API token / OAuth app）打的每一個 REST 請求與 PAT 的 MCP tool call（不含 query string）。
    // Every REST request made with a delegated token and every MCP tool call made with a personal token (no query strings).
    (
        "telepy_api_call",
        r#"CREATE TABLE "telepy_api_call" (
            "id" integer NOT NULL PRIMARY KEY AUTOINCREMENT,
            "at" datetime NOT NULL,
            "user_id" integer NOT NULL,
            "token_id" integer NULL,
            "grant_id" integer NULL,
            "client_name" varchar(200) NOT NULL,
            "kind" varchar(8) NOT NULL,
            "method" varchar(10) NOT NULL,
            "route" varchar(300) NOT NULL,
            "tunnel_id" integer NULL,
            "status" integer NOT NULL,
            "duration_ms" integer NOT NULL,
            "ip" varchar(64) NULL,
            "error" varchar(300) NULL
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
    // Rust 自有：隧道在裝置上的名稱（隨機安裝代號）與最近一次盤點到的東西（JSON），隧道刪除時一併刪。
    // A tunnel's names on its device (a random install id) and what the last survey found there; deleted with the tunnel.
    (
        "telepy_device_install",
        r#"CREATE TABLE "telepy_device_install" (
            "tunnel_id" integer NOT NULL PRIMARY KEY,
            "install_id" varchar(16) NOT NULL,
            "created_at" datetime NOT NULL,
            "survey" text NULL,
            "surveyed_at" datetime NULL,
            "survey_error" text NULL,
            "renamed_at" datetime NULL,
            "renamed_from" text NULL,
            "join_facts" text NULL,
            "join_facts_at" datetime NULL
        )"#,
    ),
    // Rust 自有：發過、隧道已經刪掉的安裝代號（帳本）。裝置上留下的 `telepy-<代號>` 對得上這裡，就知道是哪條刪掉的
    // 隧道留下的，不必猜名字的形狀；新代號也不會跟它們重複。
    // Install ids of deleted tunnels (the ledger): a `telepy-<id>` left on a device is matched here instead of guessed
    // from its shape, and new ids never repeat them.
    (
        "telepy_device_install_retired",
        r#"CREATE TABLE "telepy_device_install_retired" (
            "install_id" varchar(16) NOT NULL PRIMARY KEY,
            "tunnel_id" integer NOT NULL,
            "tunnel_name" varchar(255) NOT NULL,
            "user_id" integer NOT NULL,
            "retired_at" datetime NOT NULL
        )"#,
    ),
];

const INDEXES: &[&str] = &[
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "telepy_device_install_id" ON "telepy_device_install" ("install_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_api_call_user" ON "telepy_api_call" ("user_id", "id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_api_call_token" ON "telepy_api_call" ("token_id", "at")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_api_call_grant" ON "telepy_api_call" ("grant_id", "at")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_api_call_at" ON "telepy_api_call" ("at")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_user_group_member_user" ON "telepy_user_group_member" ("user_id")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "telepy_lan_host_tunnel_address" ON "telepy_lan_host" ("tunnel_id", "address")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "telepy_terminal_profile_user_tunnel" ON "telepy_terminal_profile" ("user_id", "tunnel_id")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "telepy_shell_history_pref_user_tunnel" ON "telepy_shell_history_pref" ("user_id", "tunnel_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_terminal_scheme_user" ON "telepy_terminal_scheme" ("user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_web_session_user" ON "telepy_web_session" ("user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_passkey_user_id" ON "telepy_passkey" ("user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_recovery_code_user_id" ON "telepy_recovery_code" ("user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_ai_audit_event_user_id" ON "telepy_ai_audit_event" ("user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_sign_in_event_user_id" ON "telepy_sign_in_event" ("user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_sign_in_event_at" ON "telepy_sign_in_event" ("at")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_ai_audit_event_tunnel_id" ON "telepy_ai_audit_event" ("tunnel_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_ai_audit_event_at" ON "telepy_ai_audit_event" ("at")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_oauth_grant_user_id" ON "telepy_oauth_grant" ("user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_api_token_user_id" ON "telepy_api_token" ("user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_oauth_grant_client_id" ON "telepy_oauth_grant" ("client_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_device_key_user_key_id" ON "telepy_device_key" ("user_key_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_device_key_installed_user_key_id" ON "telepy_device_key_installed" ("user_key_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_device_key_removal_tunnel" ON "telepy_device_key_removal" ("tunnel_id", "removed_at")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_tunnel_group_member_group" ON "telepy_tunnel_group_member" ("group_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_tunnel_group_member_tunnel" ON "telepy_tunnel_group_member" ("tunnel_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_key_group_member_group" ON "telepy_key_group_member" ("group_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_key_group_grant_tunnel" ON "telepy_key_group_grant" ("tunnel_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_key_group_grant_tunnel_group" ON "telepy_key_group_grant" ("tunnel_group_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_audit_anchor_table_name_id" ON "telepy_audit_anchor" ("table_name", "id")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "telepy_device_host_key_tunnel_key" ON "telepy_device_host_key" ("tunnel_id", "public_key")"#,
    // 同一把 host key 被哪些隧道信任（= 同一台機器）。/ Which tunnels trust one host key (= the same machine).
    r#"CREATE INDEX IF NOT EXISTS "telepy_device_host_key_public_key" ON "telepy_device_host_key" ("public_key")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_credential_user" ON "telepy_credential" ("user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_gateway_event_at" ON "telepy_gateway_event" ("at")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_tunnel_session_tunnel" ON "telepy_tunnel_session" ("tunnel_id", "connected_at")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_terminal_recording_tunnel" ON "telepy_terminal_recording" ("tunnel_id", "started_at")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_access_request_tunnel" ON "telepy_access_request" ("tunnel_id", "status")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_command_rule_tunnel" ON "telepy_command_rule" ("tunnel_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_command_rule_owner" ON "telepy_command_rule" ("scope", "user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_command_rule_target_tunnel" ON "telepy_command_rule_target" ("tunnel_id")"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS "telepy_command_rule_override_one" ON "telepy_command_rule_override" ("rule_id", "user_id", "kind")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_command_rule_override_target_tunnel" ON "telepy_command_rule_override_target" ("tunnel_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_snippet_user" ON "telepy_snippet" ("scope", "user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_snippet_tunnel" ON "telepy_snippet" ("scope", "tunnel_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_webhook_user" ON "telepy_webhook" ("user_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_webhook_tunnel_tunnel" ON "telepy_webhook_tunnel" ("tunnel_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_webhook_optout_tunnel" ON "telepy_webhook_optout" ("tunnel_id")"#,
    r#"CREATE INDEX IF NOT EXISTS "telepy_webhook_delivery_hook" ON "telepy_webhook_delivery" ("webhook_id", "id")"#,
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
    // 一鍵加入腳本偵測到的環境（JSON：shell、SSH client / server、init、keepalive 模式）。/ What the join script found (JSON).
    ("telepy_device_install", "join_facts", "text NULL"),
    ("telepy_device_install", "join_facts_at", "datetime NULL"),
    ("telepy_tunnel_endpoint", "previous_ip", "varchar(64) NULL"),
    ("telepy_tunnel_endpoint", "changed_at", "datetime NULL"),
    ("telepy_tunnel_endpoint", "public_ip", "varchar(64) NULL"),
    ("telepy_tunnel_endpoint", "public_source", "varchar(16) NULL"),
    ("telepy_tunnel_endpoint", "lan", "text NULL"),
    ("telepy_tunnel_endpoint", "hostname", "varchar(255) NULL"),
    ("telepy_tunnel_endpoint", "probed_at", "datetime NULL"),
    ("telepy_tunnel_endpoint", "probe_error", "text NULL"),
    // 裝置的基本狀況（`device_facts`，JSON）與時間。/ Device facts (JSON) and when they were read.
    ("telepy_tunnel_endpoint", "facts", "text NULL"),
    ("telepy_tunnel_endpoint", "facts_at", "datetime NULL"),
    // 最後一次怎麼連上 gateway（tcp / websocket）。/ How the device last reached the gateway.
    ("telepy_tunnel_endpoint", "transport", "varchar(16) NULL"),
    ("telepy_ai_audit_event", "ip", "varchar(64) NULL"),
    // 稽核雜湊鏈（升級前的列為 NULL）。/ Audit hash chain (NULL on rows written before the upgrade).
    ("telepy_gateway_event", "prev_hash", "varchar(64) NULL"),
    ("telepy_gateway_event", "hash", "varchar(64) NULL"),
    ("telepy_sign_in_event", "prev_hash", "varchar(64) NULL"),
    ("telepy_sign_in_event", "hash", "varchar(64) NULL"),
    ("telepy_ai_audit_event", "prev_hash", "varchar(64) NULL"),
    ("telepy_ai_audit_event", "hash", "varchar(64) NULL"),
    ("authorized_keys_reverseserverauthorizedkeys", "default_username_id", "INTEGER NULL"),
    // 登入 session 用什麼方式登入（「你的裝置」清單）。/ How a web session signed in (the "Your devices" list).
    ("telepy_web_session", "method", "varchar(16) NULL"),
    ("telepy_web_session", "second_factor", "varchar(16) NULL"),
    ("authorized_keys_userauthorizedkeys", "last_used_at", "datetime NULL"),
    ("authorized_keys_userauthorizedkeys", "last_used_ip", "varchar(64) NULL"),
    // 個人金鑰的到期時間（NULL = 不到期）。/ Personal key expiry (NULL = never).
    ("authorized_keys_userauthorizedkeys", "expires_at", "datetime NULL"),
    // 錄影的來源：terminal（網頁終端機）/ agent（MCP agent 的 shell）。/ What was recorded: the web terminal or an agent's shell.
    ("telepy_terminal_recording", "kind", "varchar(16) NOT NULL DEFAULT 'terminal'"),
    // 限時分享：到期時間（NULL = 一直有效）。/ Timed sharing: when the share ends (NULL = never).
    ("tunnels_tunnelsharing", "expires_at", "datetime NULL"),
    // 核准的存取申請：暫時的帳號（到期就移除）與暫時提升的權限（到期回到 base_permission）。
    // Approved access requests: temporary accounts (removed at expiry) and a temporary permission (back to base_permission).
    ("tunnels_tunnelsharingallowedusername", "expires_at", "datetime NULL"),
    // 裝置金鑰清單：這把金鑰只裝到這些帳號（username id 的 JSON 陣列；NULL = 擁有者能用的每個帳號）。
    // Device key list: install this key only into these accounts (JSON array of username ids; NULL = every allowed account).
    ("telepy_device_key", "accounts", "text NULL"),
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
    // Telepy 自己看不到裝置的公網來源時，裝置去問的公網 IP 查詢網址（空 = 不問）。/ Where a device asks for its public IP when Telepy cannot tell (empty = never).
    ("site_settings_sitesettings", "device_ip_lookup_url", "varchar(512) NOT NULL DEFAULT 'https://api.ipify.org'"),
    // 隧道狀態告警的 webhook（空 = 關閉）與「斷線多久才通知」（秒）。/ Status alert webhook (empty = off) and its delay.
    ("site_settings_sitesettings", "notify_webhook_url", "varchar(512) NOT NULL DEFAULT ''"),
    ("site_settings_sitesettings", "notify_down_delay", "integer NOT NULL DEFAULT 60"),
    ("site_settings_sitesettings", "notify_user_webhooks", "bool NOT NULL DEFAULT 1"),
    ("site_settings_sitesettings", "notify_private_targets", "bool NOT NULL DEFAULT 0"),
    ("site_settings_sitesettings", "notify_max_webhooks", "integer NOT NULL DEFAULT 10"),
    ("telepy_webhook", "headers", "text NOT NULL DEFAULT ''"),
    // 全站 webhook 的模式：enforced = 沒人能退出；default = 隧道的 owner / ADMIN 可以退出（升級前的都是 default）。
    // A site webhook's mode: enforced = nobody opts out; default = tunnel owners / ADMINs may (existing ones become default).
    ("telepy_webhook", "mode", "varchar(8) NOT NULL DEFAULT 'default'"),
    ("telepy_webhook_delivery", "event_json", "text NOT NULL DEFAULT ''"),
    ("telepy_webhook_delivery", "redelivered_from", "integer NULL"),
    // 指令規則：這條「要核准」規則指定的核准人（JSON 陣列；NULL / 空 = owner + ADMIN）。紀錄上留一份快照。
    // Command rules: the approvers an "approve" rule names (JSON array; NULL / empty = owner + ADMIN). Events keep a snapshot.
    ("telepy_command_rule", "approver_ids", "text NULL"),
    ("telepy_command_event", "approver_ids", "text NULL"),
    // 指令規則：全站（site）或某人的個人規則（user + user_id），套用所有隧道或 `telepy_command_rule_target` 那幾條。
    // NULL scope = 舊的（`tunnel_id` NULL = 全站，否則一條隧道的），由 data migration 轉成新的。
    // Command rules: site-wide or someone's personal rule, for every tunnel or the listed ones. A NULL scope is a
    // pre-upgrade row (NULL `tunnel_id` = site-wide, else one tunnel's), converted by a data migration.
    ("telepy_command_rule", "scope", "varchar(8) NULL"),
    ("telepy_command_rule", "user_id", "integer NULL"),
    ("telepy_command_rule", "all_tunnels", "bool NOT NULL DEFAULT 1"),
    // 全站規則能不能覆寫：default = 隧道的 owner / ADMIN 可以在自己的隧道上關掉（提醒規則每個人可以靜音）；enforced = 誰都不行。
    // 升級前的全站規則照使用者的決定一律算 default。/ Whether a site rule can be overridden: default = owners / ADMINs may
    // turn it off on their tunnels (anyone may mute a reminder); enforced = nobody. Pre-upgrade rules become default.
    ("telepy_command_rule", "mode", "varchar(8) NOT NULL DEFAULT 'default'"),
    // 「要核准」等多久（秒）；NULL = 網站設定，比網站設定長的照網站設定。/ How long an approval waits; NULL = the site setting (a ceiling).
    ("telepy_command_rule", "approval_timeout", "integer NULL"),
    // 指令申請來自哪把個人 API token（agent 的核准沿用要對同一把）。/ The API token an agent request came from.
    ("telepy_command_event", "token_id", "integer NULL"),
    // 個人金鑰最長效期（天，0 = 不限）。/ Longest a personal key may be valid, in days (0 = no limit).
    ("site_settings_sitesettings", "user_key_max_days", "integer NOT NULL DEFAULT 0"),
    ("site_settings_sitesettings", "desktop_enabled", "bool NOT NULL DEFAULT 1"),
    ("site_settings_sitesettings", "desktop_max_sessions", "integer NOT NULL DEFAULT 4"),
    ("site_settings_sitesettings", "desktop_session_idle_timeout", "integer NOT NULL DEFAULT 900"),
    ("site_settings_sitesettings", "desktop_clipboard", "varchar(16) NOT NULL DEFAULT 'both'"),
    ("site_settings_sitesettings", "desktop_max_resolution", "integer NOT NULL DEFAULT 2560"),
    // 網頁內 RustDesk 的檔案傳輸（上傳 / 下載）。/ File transfer in in-browser RustDesk sessions.
    ("site_settings_sitesettings", "desktop_file_transfer", "bool NOT NULL DEFAULT 1"),
    // 管理員要求每個帳號都要有 TOTP / passkey（各自獨立）。/ Admin-required second factors, one switch each.
    ("site_settings_sitesettings", "mfa_require_totp", "bool NOT NULL DEFAULT 0"),
    ("site_settings_sitesettings", "mfa_require_passkey", "bool NOT NULL DEFAULT 0"),
    // 終端機錄影留幾天（0 = 一直留）。/ How long terminal recordings are kept (0 = forever).
    ("site_settings_sitesettings", "recording_retention_days", "integer NOT NULL DEFAULT 30"),
    // 這條隧道的網頁終端機要錄影。/ Record this tunnel's web terminal sessions.
    ("authorized_keys_reverseserverauthorizedkeys", "record_sessions", "bool NOT NULL DEFAULT 0"),
    // 密文裡有什麼（`password` / `key` / `password,key`；空 = 舊列，只有密碼）。/ What the sealed secret holds.
    ("telepy_credential", "secret_kinds", "varchar(32) NOT NULL DEFAULT ''"),
    ("site_settings_sitesettings", "command_approval_timeout", "integer NOT NULL DEFAULT 300"),
    // 網頁登入效期（秒）：沒有任何造訪多久後要重新登入（每次續期往後推，預設 30 天）、access token 多久換一次（預設 1 小時）。
    // Web sign-in lifetimes (seconds): how long a sign-in lasts without a visit (sliding, 30 days) and how often the access token is renewed (1 hour).
    ("site_settings_sitesettings", "signin_lifetime", "integer NOT NULL DEFAULT 2592000"),
    ("site_settings_sitesettings", "signin_access_lifetime", "integer NOT NULL DEFAULT 3600"),
    ("user_management_usersettings", "theme", "varchar(8) NOT NULL DEFAULT 'system'"),
    ("user_management_usersettings", "terminal_font_size", "smallint unsigned NOT NULL DEFAULT 14"),
    // 介面顯示大小（百分比，85–130；前端把它設成 <html> 的 font-size）。/ UI display scale in percent.
    ("user_management_usersettings", "ui_scale", "smallint unsigned NOT NULL DEFAULT 100"),
    // 終端機字型 / 配色 id（清單在前端 lib/terminalAppearance.ts）。/ Terminal font / colour-scheme ids.
    ("user_management_usersettings", "terminal_font", "varchar(32) NOT NULL DEFAULT 'hack'"),
    ("user_management_usersettings", "terminal_scheme", "varchar(32) NOT NULL DEFAULT 'telepy'"),
    // 終端機粗體的畫法（face = 真正的粗體字 / bright = 只換亮色 / both）與連字。/ Terminal bold style and ligatures.
    ("user_management_usersettings", "terminal_bold", "varchar(8) NOT NULL DEFAULT 'face'"),
    ("user_management_usersettings", "terminal_ligatures", "bool NOT NULL DEFAULT 0"),
    // 每條隧道的覆寫也多這兩項（NULL = 跟隨預設）。/ The per-tunnel override gets the same two (NULL = inherit).
    ("telepy_terminal_profile", "bold", "varchar(8) NULL"),
    ("telepy_terminal_profile", "ligatures", "bool NULL"),
    // 遠端桌面剪貼簿方向（個人選擇；站台的 desktop_clipboard 是上限）。/ Desktop clipboard direction (the site setting caps it).
    ("user_management_usersettings", "desktop_clipboard", "varchar(16) NOT NULL DEFAULT 'both'"),
    // 網頁終端機斷線後 shell 留多久（秒，0 = 斷線就結束）；站台上限（0 = 功能關閉）；隧道政策（user / never）。
    // How long a web terminal's shell outlives a dropped socket (0 = end at once); the site ceiling (0 = off); the tunnel's policy.
    ("user_management_usersettings", "terminal_detach_secs", "integer NOT NULL DEFAULT 0"),
    ("site_settings_sitesettings", "terminal_detach_max_secs", "integer NOT NULL DEFAULT 1800"),
    ("authorized_keys_reverseserverauthorizedkeys", "terminal_detach_policy", "varchar(8) NOT NULL DEFAULT 'user'"),
    // 各頁的卡片 / 清單顯示（JSON：{"tunnels":"list","key_groups":"card"}；跟著帳號走）。/ Card / list view per page (JSON; follows the account).
    ("user_management_usersettings", "view_modes", "text NOT NULL DEFAULT '{}'"),
    ("user_management_usersettings", "desktop_display", "text NOT NULL DEFAULT ''"),
    // ~/.ssh/config 裡裝置別名的前綴（空 = 不加）：同一台筆電有兩台 Telepy、裝置同名時用。/ The device alias prefix in ~/.ssh/config.
    ("user_management_usersettings", "ssh_alias_prefix", "varchar(24) NOT NULL DEFAULT ''"),
    // Tapi（彩蛋吉祥物）十字髮夾的顏色；空 = 還沒找到 Tapi（彩蛋沒解鎖）。/ Tapi's clip colour; empty = not found yet.
    ("user_management_usersettings", "tapi_color", "varchar(16) NOT NULL DEFAULT ''"),
    // 「每天換一個」解鎖了沒（看完片尾名單）。/ Whether "a new colour every day" is unlocked (watched the credits).
    ("user_management_usersettings", "tapi_daily", "bool NOT NULL DEFAULT 0"),
    // 網頁終端機 / agent shell 打的指令要不要寫進裝置的 shell 歷史檔（keep = 照常，skip = 不寫；每條隧道可個別覆寫）。
    // Whether web terminal / agent shell commands go into the device's shell history (keep / skip; per-tunnel override).
    ("user_management_usersettings", "shell_history", "varchar(8) NOT NULL DEFAULT 'keep'"),
    // 通道群組 / 金鑰群組的說明與標籤（標籤 = JSON 字串陣列，規則同通道標籤）。/ Group description and labels (JSON array).
    ("telepy_tunnel_group", "description", "text NOT NULL DEFAULT ''"),
    ("telepy_tunnel_group", "labels", "text NOT NULL DEFAULT '[]'"),
    ("telepy_key_group", "description", "text NOT NULL DEFAULT ''"),
    ("telepy_key_group", "labels", "text NOT NULL DEFAULT '[]'"),
    // 個人 API token 被呼叫了幾次（呼叫紀錄只留 90 天，這個一直累加）。/ Calls made with a token (the log keeps 90 days; this keeps counting).
    ("telepy_api_token", "call_count", "integer NOT NULL DEFAULT 0"),
    // 登入頁的樣子（standard = 產品介紹；discreet = 只寫 Telepy 的低調畫面）與低調畫面上的一句話（空白 = 內建的句子）。
    // How the sign-in pages look (standard = product highlights; discreet = a plain "Telepy" page) and the discreet page's line (blank = built-in).
    ("site_settings_sitesettings", "signin_page_style", "varchar(16) NOT NULL DEFAULT 'standard'"),
    ("site_settings_sitesettings", "signin_oauth_style", "varchar(16) NOT NULL DEFAULT 'standard'"),
    ("site_settings_sitesettings", "signin_page_message", "varchar(200) NOT NULL DEFAULT ''"),
    // `telepy login`（CLI 的瀏覽器登入）沒登入時那一頁的樣子；以前跟著 OAuth 登入頁，所以升級時先抄一份（見 CLI_SIGNIN_STYLE）。
    // The look of the page `telepy login` shows a signed-out browser; it used to follow the OAuth page, so upgrades copy that (CLI_SIGNIN_STYLE).
    ("site_settings_sitesettings", "signin_cli_style", "varchar(16) NOT NULL DEFAULT 'standard'"),
    // 登入後的授權（同意）頁 /oauth/authorize 的樣子（`telepy login` 的完成頁也跟著它）；以前一律是一般樣子。
    // The approval (consent) page's look, /oauth/authorize (telepy login's done page follows it); always standard before.
    ("site_settings_sitesettings", "signin_consent_style", "varchar(16) NOT NULL DEFAULT 'standard'"),
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

/// 管理員在網站設定填的那一個告警網址，搬成一個全站 webhook（同樣的狀態事件 + IP 變更、同樣的延遲），再清掉設定。
/// The admins' single alert URL from the site settings becomes a site-wide webhook (same status events + IP
/// changes, same delay); the setting is cleared afterwards.
pub const SITE_WEBHOOK_FROM_SETTINGS: &str = "2026-10-26-site-webhook-from-settings";

/// 「Telepy 當 RustDesk 伺服器」移除後（只經隧道連 RustDesk）：綁那些裝置的已存密碼（`tunnel_id` = 0，只有那個功能會建）
/// 刪掉，兩張表（裝置、帶 IP 的連線紀錄 —— 它們的 90 天清理跟著功能一起沒了）也刪掉。欄位照規則不動。
/// After Telepy-as-RustDesk-server was removed (RustDesk only through tunnels): delete the saved logins bound to
/// those devices (`tunnel_id` = 0, which only that feature created) and drop its two tables (devices, and the session
/// history with IPs whose 90-day purge went with the feature). Columns stay, as always.
pub const DROP_RUSTDESK_SERVER: &str = "2026-10-26-drop-rustdesk-server-devices";

/// CLI 的登入頁有了自己的樣子設定：先抄 OAuth 登入頁現在的樣子，升級後看起來跟以前一樣。
/// The CLI sign-in got its own look setting: start from the OAuth page's current look, so upgrades look the same.
pub const CLI_SIGNIN_STYLE: &str = "2026-10-28-cli-signin-style-from-oauth";

/// 指令規則改成「個人 + 全站」：舊的隧道規則變成建立者的個人規則（只套用那條隧道；建立者已經不是 owner / ADMIN 就給隧道
/// owner），舊的全站規則照舊套用所有隧道。隧道已經不在的規則刪掉。
/// Command rules became personal + site-wide: a tunnel's rule becomes its creator's personal rule limited to that
/// tunnel (the tunnel owner's when the creator no longer owns or administers it); site-wide rules keep covering every
/// tunnel. Rules of tunnels that no longer exist are deleted.
pub const PERSONAL_COMMAND_RULES: &str = "2026-10-28-personal-command-rules";

async fn applied(pool: &SqlitePool, name: &str) -> sqlx::Result<bool> {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_data_migration WHERE name = ?").bind(name).fetch_one(pool).await?;
    Ok(n > 0)
}

/// 依序套用還沒跑過的一次性 data migration（同一個 transaction 裡寫入完成紀錄）。
pub async fn run_data_migrations(pool: &SqlitePool) -> anyhow::Result<()> {
    drop_sharee_usernames(pool).await?;
    site_webhook_from_settings(pool).await?;
    drop_rustdesk_server(pool).await?;
    cli_signin_style(pool).await?;
    personal_command_rules(pool).await
}

async fn personal_command_rules(pool: &SqlitePool) -> anyhow::Result<()> {
    if applied(pool, PERSONAL_COMMAND_RULES).await? {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE telepy_command_rule SET scope = 'site', all_tunnels = 1 WHERE scope IS NULL AND tunnel_id IS NULL").execute(&mut *tx).await?;
    let gone = sqlx::query(
        "DELETE FROM telepy_command_rule WHERE scope IS NULL AND tunnel_id IS NOT NULL \
         AND tunnel_id NOT IN (SELECT id FROM authorized_keys_reverseserverauthorizedkeys)",
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    // 建立者還是 owner / ADMIN 就歸他，否則歸隧道 owner。/ The creator while they still own / administer it, else the owner.
    let moved = sqlx::query(
        "UPDATE telepy_command_rule SET scope = 'user', all_tunnels = 0, user_id = ( \
             SELECT CASE WHEN r.created_by_id = t.user_id OR EXISTS ( \
                 SELECT 1 FROM tunnels_tunnelsharing s WHERE s.tunnel_id = t.id AND s.shared_with_id = r.created_by_id \
                 AND LOWER(s.permission_type) = 'admin') THEN r.created_by_id ELSE t.user_id END \
             FROM telepy_command_rule r JOIN authorized_keys_reverseserverauthorizedkeys t ON t.id = r.tunnel_id \
             WHERE r.id = telepy_command_rule.id) \
         WHERE scope IS NULL AND tunnel_id IS NOT NULL",
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    sqlx::query(
        "INSERT OR IGNORE INTO telepy_command_rule_target (rule_id, tunnel_id) \
         SELECT id, tunnel_id FROM telepy_command_rule WHERE scope = 'user' AND tunnel_id IS NOT NULL",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO telepy_data_migration (name, applied_at) VALUES (?, ?)").bind(PERSONAL_COMMAND_RULES).bind(crate::util::now_db()).execute(&mut *tx).await?;
    tx.commit().await?;
    if moved > 0 || gone > 0 {
        tracing::info!(moved, gone, "data migration: tunnel command rules are now their creators' personal rules");
    }
    Ok(())
}

async fn cli_signin_style(pool: &SqlitePool) -> anyhow::Result<()> {
    if applied(pool, CLI_SIGNIN_STYLE).await? {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE site_settings_sitesettings SET signin_cli_style = signin_oauth_style WHERE id = 1").execute(&mut *tx).await?;
    sqlx::query("INSERT INTO telepy_data_migration (name, applied_at) VALUES (?, ?)").bind(CLI_SIGNIN_STYLE).bind(crate::util::now_db()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

async fn drop_rustdesk_server(pool: &SqlitePool) -> anyhow::Result<()> {
    if applied(pool, DROP_RUSTDESK_SERVER).await? {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    let logins = sqlx::query("DELETE FROM telepy_credential WHERE tunnel_id = 0").execute(&mut *tx).await?.rows_affected();
    sqlx::query("DROP TABLE IF EXISTS telepy_rustdesk_session").execute(&mut *tx).await?;
    sqlx::query("DROP TABLE IF EXISTS telepy_rustdesk_device").execute(&mut *tx).await?;
    sqlx::query("INSERT INTO telepy_data_migration (name, applied_at) VALUES (?, ?)").bind(DROP_RUSTDESK_SERVER).bind(crate::util::now_db()).execute(&mut *tx).await?;
    tx.commit().await?;
    if logins > 0 {
        tracing::info!(logins, "data migration: removed saved logins of RustDesk-server devices");
    }
    Ok(())
}

async fn site_webhook_from_settings(pool: &SqlitePool) -> anyhow::Result<()> {
    if applied(pool, SITE_WEBHOOK_FROM_SETTINGS).await? {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    let row: Option<(String, i64)> = sqlx::query_as("SELECT notify_webhook_url, notify_down_delay FROM site_settings_sitesettings WHERE id = 1").fetch_optional(&mut *tx).await?;
    if let Some((url, delay)) = row.filter(|(u, _)| !u.trim().is_empty()) {
        let now = crate::util::now_db();
        sqlx::query(
            "INSERT INTO telepy_webhook (user_id, scope, name, url, format, language, events, all_tunnels, delay, enabled, created_at, updated_at) \
             VALUES (NULL, 'site', 'Status alerts', ?, 'auto', 'en', 'tunnel.offline,tunnel.online,tunnel.degraded,tunnel.recovered,tunnel.ip_changed', 1, ?, 1, ?, ?)",
        )
        .bind(url.trim())
        .bind(delay.max(0))
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE site_settings_sitesettings SET notify_webhook_url = '' WHERE id = 1").execute(&mut *tx).await?;
        tracing::info!("data migration: the site's alert webhook URL is now a site-wide webhook");
    }
    sqlx::query("INSERT INTO telepy_data_migration (name, applied_at) VALUES (?, ?)").bind(SITE_WEBHOOK_FROM_SETTINGS).bind(crate::util::now_db()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

async fn drop_sharee_usernames(pool: &SqlitePool) -> anyhow::Result<()> {
    if applied(pool, DROP_SHAREE_USERNAMES).await? {
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
    async fn the_old_alert_url_becomes_a_site_webhook_once() {
        let db = Db::open_memory().await.unwrap();
        ensure_schema(&db.write).await.unwrap();
        sqlx::query("DELETE FROM telepy_data_migration WHERE name = ?").bind(SITE_WEBHOOK_FROM_SETTINGS).execute(&db.write).await.unwrap();
        sqlx::query("UPDATE site_settings_sitesettings SET notify_webhook_url = ' https://hooks.slack.com/services/x ', notify_down_delay = 90 WHERE id = 1").execute(&db.write).await.unwrap();
        ensure_schema(&db.write).await.unwrap();
        ensure_schema(&db.write).await.unwrap();
        let rows: Vec<(String, String, i64, String)> = sqlx::query_as("SELECT scope, url, delay, events FROM telepy_webhook").fetch_all(&db.read).await.unwrap();
        assert_eq!(rows.len(), 1, "migrated once");
        assert_eq!((rows[0].0.as_str(), rows[0].1.as_str(), rows[0].2), ("site", "https://hooks.slack.com/services/x", 90));
        assert!(rows[0].3.contains("tunnel.ip_changed"));
        let url: String = sqlx::query_scalar("SELECT notify_webhook_url FROM site_settings_sitesettings WHERE id = 1").fetch_one(&db.read).await.unwrap();
        assert_eq!(url, "");
    }

    #[tokio::test]
    async fn rustdesk_server_leftovers_go_once() {
        let db = Db::open_memory().await.unwrap();
        ensure_schema(&db.write).await.unwrap();
        // 一個跑過那個功能的 DB：兩張表、一筆綁裝置的密碼（tunnel_id 0）、一筆一般的。/ A DB that ran the removed feature.
        sqlx::query("DELETE FROM telepy_data_migration WHERE name = ?").bind(DROP_RUSTDESK_SERVER).execute(&db.write).await.unwrap();
        sqlx::query(r#"CREATE TABLE "telepy_rustdesk_device" ("id" integer NOT NULL PRIMARY KEY AUTOINCREMENT, "rustdesk_id" varchar(32) NOT NULL)"#).execute(&db.write).await.unwrap();
        sqlx::query(r#"CREATE TABLE "telepy_rustdesk_session" ("id" integer NOT NULL PRIMARY KEY AUTOINCREMENT, "ip" varchar(64) NULL)"#).execute(&db.write).await.unwrap();
        for tunnel in [0, 5] {
            sqlx::query("INSERT INTO telepy_credential (user_id, label, protocol, tunnel_id, login, domain, secret, created_at, updated_at) VALUES (1, 'x', 'rustdesk', ?, '', '', 's', '2026-10-26 00:00:00', '2026-10-26 00:00:00')")
                .bind(tunnel)
                .execute(&db.write)
                .await
                .unwrap();
        }
        ensure_schema(&db.write).await.unwrap();
        ensure_schema(&db.write).await.unwrap();
        let left: Vec<i64> = sqlx::query_scalar("SELECT tunnel_id FROM telepy_credential").fetch_all(&db.read).await.unwrap();
        assert_eq!(left, vec![5], "only the device-bound login goes");
        let tables: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'telepy_rustdesk_%'").fetch_one(&db.read).await.unwrap();
        assert_eq!(tables, 0);
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
