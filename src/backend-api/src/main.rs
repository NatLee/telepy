//! `telepy-server`：serve（預設）/ migrate / create-superuser / seed-service-key / openapi。
//! 啟動流程 = Django 版 docker-entrypoint 的 migrate + post_migrate signals + 聽埠，一個 binary 搞定，
//! 不需要 supervisor / collectstatic。

use std::path::Path;

use clap::{Parser, Subcommand};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer};

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
    /// Print the OpenAPI document (JSON) to stdout and exit.
    Openapi,
}

fn init_logging(config: &Config) -> Vec<tracing_appender::non_blocking::WorkerGuard> {
    // LOG_LEVEL 可以是單一等級或完整的 EnvFilter 指令；單一 `debug` 時把 sqlx/hyper/russh 的內部 debug 壓掉
    // （否則每個 SQL 都會印一行，DEBUG=true 跑幾小時就是幾 MB）。
    // A bare `debug` keeps our own modules verbose but silences sqlx/hyper/russh internals.
    let directive = match config.log_level.to_ascii_lowercase().as_str() {
        "debug" => "debug,sqlx=warn,hyper=info,hyper_util=info,h2=info,russh=info,tokio_tungstenite=info,tungstenite=info".to_string(),
        "trace" => "trace,sqlx=info,hyper=info,hyper_util=info,h2=info".to_string(),
        other => other.to_string(),
    };
    let filter = move || EnvFilter::try_new(&directive).unwrap_or_else(|_| EnvFilter::new("info"));
    let mut guards = Vec::new();
    let stdout = fmt::layer().with_target(true).with_filter(filter());
    let registry = tracing_subscriber::registry().with(stdout);
    if std::fs::create_dir_all(&config.log_root).is_ok() {
        let (all, g1) = tracing_appender::non_blocking(tracing_appender::rolling::daily(&config.log_root, "telepy.log"));
        let (err, g2) = tracing_appender::non_blocking(tracing_appender::rolling::daily(&config.log_root, "error.log"));
        guards.push(g1);
        guards.push(g2);
        registry
            .with(fmt::layer().with_ansi(false).with_writer(all).with_filter(filter()))
            .with(fmt::layer().with_ansi(false).with_writer(err).with_filter(EnvFilter::new("warn")))
            .init();
    } else {
        registry.init();
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
    let db = open_db(&config).await?;
    seed_service_key(&db, &config.web_service_pubkey_path).await?;
    let state = AppState::new(config.clone(), db);
    tokio::spawn(telepy_server::monitor::runner::run(state.clone(), std::time::Duration::from_secs(5)));
    state.remote_browser.cleanup_orphans(&state.db).await;
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
    tokio::spawn(telepy_server::ai::run_reaper(state.clone(), telepy_server::ai::REAP_INTERVAL));
    if config.remote_browser_gc {
        tokio::spawn(state.remote_browser.clone().run_reaper(state.db.clone()));
    }
    let app = telepy_server::app::build(state);
    let listener = tokio::net::TcpListener::bind(&config.bind).await?;
    tracing::info!(addr = %config.bind, "listening");
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await?;
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
        Command::Openapi => unreachable!("handled above"),
    }
}
