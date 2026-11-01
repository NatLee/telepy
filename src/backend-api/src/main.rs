//! `telepy-server`：serve（預設）/ migrate / create-superuser / seed-service-key / openapi / doctor / import-user-keys /
//! keygen / geoip / oui。維運指令都在容器裡跑（`docker compose exec backend telepy-server …`），主機不需要任何腳本。
//! 啟動流程 = Django 版 docker-entrypoint 的 migrate + post_migrate signals + 聽埠，一個 binary 搞定，
//! 不需要 supervisor / collectstatic。

use std::path::Path;

use clap::{Parser, Subcommand};
use tracing_subscriber::{fmt, layer::SubscriberExt, reload, util::SubscriberInitExt, EnvFilter, Layer};

use telepy_server::auth::password::make_password;
use telepy_server::config::Config;
use telepy_server::db::{self, Db};
use telepy_server::state::AppState;

#[derive(Parser)]
#[command(name = "telepy-server", version, about = "Telepy backend (REST + WebSocket)")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the HTTP/WebSocket server (default).
    Serve,
    /// Create or reconcile the database schema and exit.
    Migrate,
    /// Create an administrator account (first user is a superuser anyway).
    CreateSuperuser {
        #[arg(long)]
        username: String,
        #[arg(long, default_value = "")]
        email: String,
        #[arg(long, env = "DJANGO_SUPERUSER_PASSWORD")]
        password: String,
    },
    /// Seed/refresh the `web-service` SSH public key from WEB_SERVICE_SSH_PUBKEY.
    SeedServiceKey,
    /// Create the gateway host keys (GATEWAY_HOST_KEYS_DIR) and the service key (SSH_IDENTITY) when they are missing.
    /// Existing keys are kept — devices pin them. `serve` does the same at every start.
    Keygen,
    /// Download the offline IP geolocation databases (DB-IP Lite, CC BY 4.0) into GEOIP_DIR, then restart the backend.
    /// Re-run monthly.
    Geoip,
    /// Download IEEE's OUI registry (NIC vendors for LAN hosts) into OUI_DIR, then restart the backend.
    Oui,
    /// Fetch the device carrier (telepy-carrier) for every platform from the release page into CARRIER_DIR, so devices
    /// that cannot reach GitHub get it from this server (otherwise each platform is fetched on its first request).
    FetchCarriers,
    /// Print the OpenAPI document (JSON) to stdout and exit.
    Openapi,
    /// Check the configuration and companion services (read-only); exit 1 when something is broken.
    Doctor {
        /// Print JSON instead of text.
        #[arg(long)]
        json: bool,
    },
    /// Add personal SSH public keys to existing accounts from a JSON file
    /// (`[{"username", "name", "key", "expires_at"?, "description"?}]`), with the same checks as the API.
    /// Exit 1 when any entry was skipped.
    ImportUserKeys {
        /// Path of the JSON file.
        file: std::path::PathBuf,
        /// Check every entry and print the plan without writing anything.
        #[arg(long)]
        dry_run: bool,
    },
}

fn init_logging(config: &Config) -> Vec<tracing_appender::non_blocking::WorkerGuard> {
    // 啟動時還沒讀資料庫，先用環境變數（或預設）；網站設定的 log 等級在 serve 讀完設定後經 reload handle 套上，
    // 存檔時也一樣（`server_settings::apply_log_level`）。
    // The database isn't read yet: start from the variable (or the default); the site setting's level is applied
    // through the reload handles once serve has read the settings, and again on every save.
    let directive = telepy_server::server_settings::log_directive(&config.log_level_effective());
    let filter = move || EnvFilter::try_new(&directive).unwrap_or_else(|_| EnvFilter::new("info"));
    let mut guards = Vec::new();
    let (stdout_filter, stdout_handle) = reload::Layer::new(filter());
    let stdout = fmt::layer().with_target(true).with_filter(stdout_filter);
    let registry = tracing_subscriber::registry().with(stdout);
    if std::fs::create_dir_all(&config.log_root).is_ok() {
        let (all, g1) = tracing_appender::non_blocking(tracing_appender::rolling::daily(&config.log_root, "telepy.log"));
        let (err, g2) = tracing_appender::non_blocking(tracing_appender::rolling::daily(&config.log_root, "error.log"));
        guards.push(g1);
        guards.push(g2);
        let (file_filter, file_handle) = reload::Layer::new(filter());
        registry
            .with(fmt::layer().with_ansi(false).with_writer(all).with_filter(file_filter))
            .with(fmt::layer().with_ansi(false).with_writer(err).with_filter(EnvFilter::new("warn")))
            .init();
        telepy_server::server_settings::set_log_reloader(move |d| {
            let f = || EnvFilter::try_new(d).map_err(|e| e.to_string());
            stdout_handle.reload(f()?).map_err(|e| e.to_string())?;
            file_handle.reload(f()?).map_err(|e| e.to_string())
        });
    } else {
        registry.init();
        telepy_server::server_settings::set_log_reloader(move |d| stdout_handle.reload(EnvFilter::try_new(d).map_err(|e| e.to_string())?).map_err(|e| e.to_string()));
    }
    guards
}

/// post_migrate `insert_initial_public_key` 的等價物。/ Seed the web-service key like the Django signal.
async fn seed_service_key(db: &Db, path: &Path) -> anyhow::Result<()> {
    match std::fs::read_to_string(path) {
        Ok(key) => {
            let key = key.trim();
            if key.is_empty() {
                tracing::warn!(?path, "service key file is empty; skipping seed");
                return Ok(());
            }
            let created = db::keys::service_key_upsert(db, "web-service", key, "Public key for web service to connect with the SSH server").await?;
            tracing::info!(created, "service key 'web-service' seeded");
        }
        Err(e) => tracing::warn!(?path, error = %e, "skip service-key seed: cannot read public key"),
    }
    Ok(())
}

async fn open_db(config: &Config) -> anyhow::Result<Db> {
    let db = Db::open(&config.db_path).await?;
    db::schema::ensure_schema(&db.write).await?;
    Ok(db)
}

async fn serve(config: Config) -> anyhow::Result<()> {
    if config.secret_key_is_default {
        tracing::warn!("SECRET_KEY is not set; using the legacy Django default. Set SECRET_KEY in .env for production.");
    }
    tracing::info!(db = ?config.db_path, bind = %config.bind, debug = config.debug, "starting telepy-server");
    // 缺的金鑰在這裡補（gateway 主機金鑰、服務金鑰）；已有的不動。/ Missing keys are created here; existing ones are kept.
    for o in telepy_server::keygen::ensure(&config, std::env::var_os("SSH_IDENTITY").is_some()) {
        match &o {
            telepy_server::keygen::Outcome::Kept(_) => {}
            telepy_server::keygen::Outcome::Failed(..) => tracing::warn!("{}", telepy_server::keygen::line(&o)),
            _ => tracing::info!("{}", telepy_server::keygen::line(&o)),
        }
    }
    let db = open_db(&config).await?;
    // 網站設定裡的伺服器設定（環境變數有設的照樣優先）；log 等級在這裡換成生效的那個。
    // The saved server settings (set variables still win); the log level switches to the one in effect here.
    config.reload_saved(&db).await?;
    seed_service_key(&db, &config.web_service_pubkey_path).await?;
    let state = AppState::new(config.clone(), db);
    tokio::spawn(telepy_server::monitor::runner::run(state.clone(), std::time::Duration::from_secs(5)));
    state.remote_browser.cleanup_orphans(&state.db).await;
    // 限時分享：到期的每 30 秒收掉。/ Timed shares end within 30 s of their expiry.
    tokio::spawn(telepy_server::api::sharing::run_expiry(state.clone()));
    // 網頁終端機 shell 失去存取（暫時授權到期、站台關掉斷線保留…）就結束，每 10 秒。/ Shells that lost access end.
    tokio::spawn(telepy_server::access_recheck::run(state.clone()));
    // 上次沒關到的連線紀錄（後端重啟 = 所有 forward 都斷了）。/ Connection rows left open by the last run.
    match telepy_server::db::tunnel_sessions::close_orphans(&state.db).await {
        Ok(0) => {}
        Ok(n) => tracing::info!(rows = n, "closed connection history rows left open by the previous run"),
        Err(e) => tracing::warn!(error = %e, "cannot close orphaned connection history rows"),
    }
    match telepy_server::db::webhooks::fail_unfinished(&state.db).await {
        Ok(0) => {}
        Ok(n) => tracing::info!(rows = n, "webhook deliveries the previous run didn't finish are now marked failed"),
        Err(e) => tracing::warn!(error = %e, "cannot close unfinished webhook deliveries"),
    }
    if config.gateway_enabled {
        match tokio::net::TcpListener::bind(&config.gateway_bind).await {
            Ok(listener) => match telepy_server::gateway::start(state.gateway.clone(), listener) {
                Ok(_task) => {
                    tokio::spawn(state.gateway.clone().run_probes(config.gateway_probe_interval));
                }
                Err(e) => tracing::error!(error = %e, "SSH gateway disabled"),
            },
            Err(e) => tracing::error!(bind = %config.gateway_bind, error = %e, "SSH gateway cannot bind"),
        }
    }
    tokio::spawn(telepy_server::oauth::run_cleanup(state.db.clone()));
    tokio::spawn(telepy_server::db::retention::run(state.db.clone()));
    // 裝置自己的位址（hostname / 內網 / 公網 IP），每次連上問一次；開關每一輪讀。
    // Ask each device for its addresses once per connection; the switch is read every round.
    if config.gateway_enabled {
        tokio::spawn(telepy_server::device_info::run(state.clone()));
    }
    // 終端機錄影：收重啟前沒收尾的、每小時清過期的。/ Terminal recordings: close leftovers, purge hourly.
    tokio::spawn(telepy_server::recording::run(state.clone()));
    // 指令規則：逾時的核准申請。/ Command rules: expire approval requests nobody answered.
    tokio::spawn(telepy_server::command_rules::run(state.clone()));
    // 個人 SSH 金鑰快到期 / 已到期的 webhook 事件。/ Webhook events for personal SSH keys about to expire or expired.
    tokio::spawn(telepy_server::webhooks::keys::run(state.clone()));
    tokio::spawn(telepy_server::db::audit_chain::run(state.db.clone()));
    tokio::spawn(telepy_server::ai::run_reaper(state.clone(), telepy_server::ai::REAP_INTERVAL));
    tokio::spawn(state.pool.clone().run_reaper());
    tokio::spawn(state.desktop.clone().run_reaper(state.db.clone()));
    tokio::spawn(state.rustdesk.clone().run_reaper(state.db.clone()));
    tokio::spawn(telepy_server::device_keys::run(state.clone()));
    // 裝置載體每天檢查一次新版（網站設定可以關）。/ Device carriers: a daily check for a newer release (a site setting).
    tokio::spawn(telepy_server::carriers::run(state.clone()));
    // GeoIP 與廠商表：檔案換了就重讀，每月自動更新（網站設定可以關）。/ GeoIP and vendor data: reload changed files, refresh monthly.
    tokio::spawn(telepy_server::datasets::run(state.clone()));
    if config.remote_browser_gc {
        tokio::spawn(state.remote_browser.clone().run_reaper(state.db.clone()));
    }
    let app = telepy_server::app::build(state);
    let listener = tokio::net::TcpListener::bind(&config.bind).await?;
    tracing::info!(addr = %config.bind, "listening");
    // ConnectInfo：沒有 X-Forwarded-For 時（直接連後端）用 socket 對端當來源 IP。/ Peer address for `ClientMeta`.
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}

async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = term.recv() => {},
    }
    tracing::info!("shutdown signal received");
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    if matches!(cli.command, Some(Command::Openapi)) {
        // 不碰 DB、不開 log（stdout 要保持乾淨給 pipe 用）。/ No DB, no logging: keep stdout clean for pipes.
        println!("{}", telepy_server::app::openapi().to_pretty_json()?);
        return Ok(());
    }
    if let Some(Command::Doctor { json }) = cli.command {
        // 也不開 log：報告本身就是輸出。/ No logging either: the report is the output.
        let config = Config::from_env();
        let checks = telepy_server::doctor::run(&config).await;
        if json {
            println!("{}", serde_json::to_string_pretty(&checks)?);
        } else {
            print!("{}", telepy_server::doctor::render(&checks));
        }
        if telepy_server::doctor::failed(&checks) {
            std::process::exit(1);
        }
        return Ok(());
    }
    if matches!(cli.command, Some(Command::Keygen | Command::Geoip | Command::Oui | Command::FetchCarriers)) {
        // 維運指令：輸出就是報告，不開 log。/ Maintenance commands: the report is the output, no logging.
        let config = Config::from_env();
        let ok = match cli.command {
            Some(Command::Keygen) => {
                let out = telepy_server::keygen::ensure(&config, std::env::var_os("SSH_IDENTITY").is_some());
                print!("{}", telepy_server::keygen::render(&out));
                if out.iter().any(|o| matches!(o, telepy_server::keygen::Outcome::Created(..))) {
                    println!("Restart the backend to use the new keys: docker compose restart backend");
                }
                !telepy_server::keygen::failed(&out)
            }
            Some(Command::Geoip) => {
                println!("Downloading DB-IP Lite into {} ...", config.geoip_dir.display());
                match telepy_server::datasets::fetch_geoip(&config.geoip_dir, chrono::Utc::now().date_naive()).await {
                    Ok(lines) => {
                        for l in lines {
                            println!("  {l}");
                        }
                        println!("Done. The running backend loads them within an hour; to load them now: docker compose restart backend");
                        println!("{}", telepy_server::datasets::ATTRIBUTION);
                        true
                    }
                    Err(e) => {
                        eprintln!("download failed:\n{e:#}");
                        false
                    }
                }
            }
            Some(Command::FetchCarriers) => {
                let carriers = telepy_server::carriers::Carriers::new(&config, reqwest::Client::builder().user_agent("telepy-server").build()?);
                println!("Fetching the device carriers from {} into {} ...", carriers.releases(), carriers.dir().display());
                let run = carriers.prefetch().await;
                if let Some(e) = &run.error {
                    println!("  FAILED: {e}");
                }
                for u in &run.updated {
                    let c = carriers.cached(&u.target);
                    let was = match (u.was, &u.from) {
                        ("release", Some(v)) => format!(", was {v}"),
                        ("manual", _) => ", replaced a hand-placed one".to_string(),
                        _ => String::new(),
                    };
                    println!("  {}: {} {} bytes{was}", u.target, run.tag.as_deref().unwrap_or(""), c.map(|c| c.size).unwrap_or(0));
                }
                for t in &run.current {
                    println!("  {t}: already {}", run.tag.as_deref().unwrap_or(""));
                }
                for (t, e) in &run.failed {
                    println!("  {t}: FAILED: {e}");
                }
                run.ok()
            }
            Some(Command::Oui) => {
                println!("Downloading the IEEE OUI registry into {} ...", config.oui_dir.display());
                match telepy_server::datasets::fetch_oui(&config.oui_dir).await {
                    Ok(line) => {
                        println!("  {line}");
                        println!("Done. The running backend loads it within an hour; to load it now: docker compose restart backend");
                        true
                    }
                    Err(e) => {
                        eprintln!("download failed: {e:#}");
                        false
                    }
                }
            }
            _ => unreachable!(),
        };
        if !ok {
            std::process::exit(1);
        }
        return Ok(());
    }
    if let Some(Command::ImportUserKeys { file, dry_run }) = &cli.command {
        let dry_run = *dry_run;
        // 不開 log：stdout 只放報告（gateway 事件照樣寫進 DB 與 ssh-gateway.log）。
        // No logging: stdout carries only the report (the gateway events still reach the DB and ssh-gateway.log).
        let config = Config::from_env();
        let text = std::fs::read_to_string(file).map_err(|e| anyhow::anyhow!("cannot read {}: {e}", file.display()))?;
        let items = telepy_server::import_keys::parse_items(&text).map_err(|e| anyhow::anyhow!("{}: {e}", file.display()))?;
        let db = open_db(&config).await?;
        let state = AppState::new(config, db);
        let lines = telepy_server::import_keys::run(&state, &items, dry_run).await?;
        print!("{}", telepy_server::import_keys::render(&lines, dry_run));
        if telepy_server::import_keys::failed(&lines) {
            std::process::exit(1);
        }
        return Ok(());
    }
    let config = Config::from_env();
    let _guards = init_logging(&config);
    match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => serve(config).await,
        Command::Migrate => {
            open_db(&config).await?;
            println!("schema is up to date: {}", config.db_path.display());
            Ok(())
        }
        Command::CreateSuperuser { username, email, password } => {
            let db = open_db(&config).await?;
            let hash = make_password(&password);
            let user = db::users::create(
                &db,
                db::users::NewUser { username: &username, password_hash: &hash, email: &email, first_name: "", last_name: "" },
            )
            .await?;
            db::users::set_flags(&db, user.id, Some(true), Some(true)).await?;
            println!("superuser '{}' created (id={})", user.username, user.id);
            Ok(())
        }
        Command::SeedServiceKey => {
            let db = open_db(&config).await?;
            seed_service_key(&db, &config.web_service_pubkey_path).await
        }
        Command::Openapi | Command::Doctor { .. } | Command::ImportUserKeys { .. } | Command::Keygen | Command::Geoip | Command::Oui | Command::FetchCarriers => unreachable!("handled above"),
    }
}
