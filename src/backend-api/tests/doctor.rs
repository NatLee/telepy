//! `telepy-server doctor` 的檢查：缺服務金鑰是 ✗、補上後 ✓、gateway 沒開與 guacd 連不到是 !、審計鏈被改過是 ✗。
//! Doctor checks: missing service key fails, a seeded one passes, gateway off / guacd down warn, a tampered audit log fails.
mod common;

use std::process::Command;

use telepy_server::doctor::{self, Status};

fn status_of(checks: &[doctor::Check], name: &str) -> Status {
    checks.iter().find(|c| c.name == name).unwrap_or_else(|| panic!("no check named {name}: {checks:?}")).status
}

#[tokio::test]
async fn doctor_reports_what_is_broken() {
    let app = common::spawn().await;
    let keys = tempfile::tempdir().unwrap();
    let mut config = app.state.config.clone();
    config.ssh_identity = keys.path().join("id_rsa");
    config.web_service_pubkey_path = keys.path().join("id_rsa.pub");
    config.gateway_enabled = false;
    config.gateway_host_keys_dir = None;
    config.guacd_addr = "127.0.0.1:1".into();
    config.kasm_api = "http://127.0.0.1:1".into();

    let checks = doctor::run(&config).await;
    assert_eq!(status_of(&checks, "database"), Status::Ok, "{checks:?}");
    assert_eq!(status_of(&checks, "data directory"), Status::Ok);
    assert_eq!(status_of(&checks, "service key"), Status::Fail, "no key file yet");
    assert_eq!(status_of(&checks, "SSH gateway"), Status::Warn);
    assert_eq!(status_of(&checks, "guacd (remote desktop)"), Status::Warn);
    assert_eq!(status_of(&checks, "kasm-browser (remote browser)"), Status::Warn);
    assert_eq!(status_of(&checks, "audit log"), Status::Ok);
    assert!(doctor::failed(&checks));
    assert!(doctor::render(&checks).contains("failure(s)"));

    // 產生服務金鑰並登記進 DB → ✓。/ Generate and seed the service key: passes.
    if Command::new("ssh-keygen").arg("-V").output().is_err() && Command::new("ssh-keygen").arg("--help").output().is_err() {
        return;
    }
    let ok = Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-C", "web-service", "-f"]).arg(&config.ssh_identity).status().unwrap();
    assert!(ok.success());
    let public = std::fs::read_to_string(&config.web_service_pubkey_path).unwrap();
    telepy_server::db::keys::service_key_upsert(&app.state.db, "web-service", public.trim(), "test").await.unwrap();
    let checks = doctor::run(&config).await;
    assert_eq!(status_of(&checks, "service key"), Status::Ok, "{checks:?}");
    assert!(!doctor::failed(&checks), "{}", doctor::render(&checks));

    // 審計列被改過 → ✗。/ A tampered audit row fails.
    app.state.gateway.event("listening", None, None, None, "SSH gateway listening".into()).await;
    sqlx::query("UPDATE telepy_gateway_event SET message = 'edited'").execute(&app.state.db.write).await.unwrap();
    let checks = doctor::run(&config).await;
    assert_eq!(status_of(&checks, "audit log"), Status::Fail, "{}", doctor::render(&checks));
}
