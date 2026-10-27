//! 編好的 `telepy` 對真的伺服器（同一個 SSH lab：gateway + 裝置 sshd，在測試裡起）：用個人 API token 登入、`ls --json`、
//! `exec`（經後端，結束碼照裝置的）、`cp` 上傳再下載、`ssh` 經 gateway（系統的 OpenSSH + 產生的 config + 釘住的
//! host key）、`whoami`、撤銷之後全部失效。HOME / 設定目錄都在暫存目錄，絕不碰開發者的 ~/.ssh。
//! The built `telepy` against the real server on the SSH lab: token login, `ls --json`, `exec` (the device's exit
//! code), `cp` both ways, `ssh` through the gateway with the generated config and pinned host key, `whoami`, and
//! everything failing after a revoke. HOME and the config dir live in a temp dir, never the developer's ~/.ssh.
#[path = "../../backend-api/tests/common/mod.rs"]
#[allow(unused_imports, clippy::all)]
mod common;

use std::path::Path;

use common::lab::{sftp_server_bin, Lab, MachineOpts};
use serde_json::{json, Value};

struct Out {
    code: i32,
    stdout: String,
    stderr: String,
}

async fn telepy(home: &Path, args: &[&str]) -> Out {
    let out = tokio::process::Command::new(env!("CARGO_BIN_EXE_telepy"))
        .args(args)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("TELEPY_CONFIG_DIR", home.join("config"))
        .env("TELEPY_SSH_DIR", home.join("ssh"))
        .env("TELEPY_NO_KEYRING", "1")
        .env("TELEPY_NO_EXEC", "1")
        .env_remove("TELEPY_URL")
        .env_remove("TELEPY_TOKEN")
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .expect("run telepy");
    Out { code: out.status.code().unwrap_or(-1), stdout: String::from_utf8_lossy(&out.stdout).into(), stderr: String::from_utf8_lossy(&out.stderr).into() }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cli_against_the_server() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let m = lab.machine_with("box", &[("pi", &[&lab.service, &alice.key])], MachineOpts { shell: true, ..Default::default() }).await;
    let dev = lab.device(&alice, "box", &m).await;
    lab.username(&alice, &dev, "pi").await;
    let r = lab.app.put(&format!("/api/reverse/server/{}/labels", dev.tunnel_id), Some(&alice.token), json!({"labels": ["env=lab"]})).await;
    assert!(r.status.is_success(), "{}", r.text);
    let expires = (std::time::SystemTime::now() + std::time::Duration::from_secs(86_400)).duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let expires = chrono_like(expires);
    let r = lab.app.post("/api/auth/tokens", Some(&alice.token), json!({"name": "cli test", "scopes": ["tunnels:read", "ssh:exec", "ssh:files"], "expires_at": expires})).await;
    assert_eq!(r.status.as_u16(), 201, "{}", r.text);
    let secret = r.json["secret"].as_str().unwrap().to_string();
    let token_id = r.json["token"]["id"].as_i64().unwrap();
    let base = lab.ws_base().await.replace("ws://", "http://");
    let home = tempfile::tempdir().unwrap();
    let h = home.path();

    let o = telepy(h, &["login", &base, "--token", &secret]).await;
    assert_eq!(o.code, 0, "login: {}", o.stderr);
    assert!(o.stderr.contains("as alice"), "{}", o.stderr);

    let o = telepy(h, &["whoami", "--json"]).await;
    let me: Value = serde_json::from_str(&o.stdout).unwrap_or_else(|_| panic!("whoami: {} {}", o.stdout, o.stderr));
    assert_eq!(me["user"]["credential"]["kind"], "api_token");
    assert_eq!(me["user"]["credential"]["name"], "API token \"cli test\"");

    let o = telepy(h, &["ls", "--json"]).await;
    assert_eq!(o.code, 0, "ls: {}", o.stderr);
    let list: Value = serde_json::from_str(&o.stdout).unwrap();
    let row = &list[0];
    assert_eq!((row["name"].as_str(), row["accounts"].clone()), (Some("box"), json!(["pi"])), "{list}");
    assert_eq!(row["labels"], json!(["env=lab"]));
    assert_eq!(telepy(h, &["ls", "--label", "env=prod", "--json"]).await.stdout.trim(), "[]");
    let table = telepy(h, &["ls"]).await.stdout;
    assert!(table.starts_with("NAME") && table.contains("box"), "{table}");

    // exec：輸出原樣、結束碼是裝置上的；用標籤選也行（多目標 = 前綴）。/ exec: raw output, the device's exit code; by label too.
    let o = telepy(h, &["exec", "box@pi", "--", "echo", "hello-$USER"]).await;
    assert_eq!((o.code, o.stdout.as_str()), (0, "hello-pi\n"), "{}", o.stderr);
    let o = telepy(h, &["exec", "box", "--", "exit 3"]).await;
    assert_eq!(o.code, 3, "{}", o.stderr);
    let o = telepy(h, &["exec", "--label", "env", "box", "--", "echo", "x"]).await;
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert_eq!(o.stdout, "x\n", "one tunnel matched both ways, so it runs once");
    let o = telepy(h, &["exec", "--json", "box", "--", "echo", "j"]).await;
    let v: Value = serde_json::from_str(&o.stdout).unwrap();
    assert_eq!(v[0]["result"]["stdout"], "j\n");

    // cp：上傳再下載。/ cp up and back down.
    if sftp_server_bin().is_some() {
        std::fs::write(h.join("up.txt"), "from the laptop\n").unwrap();
        let o = telepy(h, &["cp", h.join("up.txt").to_str().unwrap(), "box@pi:up.txt"]).await;
        assert_eq!(o.code, 0, "cp up: {}", o.stderr);
        let back = h.join("down.txt");
        let o = telepy(h, &["cp", "box@pi:up.txt", back.to_str().unwrap()]).await;
        assert_eq!(o.code, 0, "cp down: {}", o.stderr);
        assert_eq!(std::fs::read_to_string(&back).unwrap(), "from the laptop\n");
    }

    // ssh：系統的 OpenSSH 經 gateway（產生的 config、釘住的 gateway host key）。/ ssh through the gateway with the generated config.
    let o = telepy(h, &["ssh", "box@pi", "-i", alice.key.path.to_str().unwrap(), "--ssh-opt", "-o BatchMode=yes", "--", "echo", "via-ssh"]).await;
    assert_eq!(o.code, 0, "ssh: {}", o.stderr);
    assert!(o.stdout.contains("via-ssh"), "{}", o.stdout);
    let conf = std::fs::read_to_string(h.join("ssh").join("box.conf")).unwrap();
    assert!(conf.contains("StrictHostKeyChecking yes") && conf.contains("ProxyCommand ssh -F"), "{conf}");

    // doctor 通過；撤銷 token 之後一切都失效。/ doctor passes; after a revoke everything fails.
    let o = telepy(h, &["doctor"]).await;
    assert!(o.stdout.contains("✓ sign-in: alice"), "{}", o.stdout);
    let r = lab.app.delete(&format!("/api/auth/tokens/{token_id}"), Some(&alice.token)).await;
    assert_eq!(r.status.as_u16(), 204);
    let o = telepy(h, &["ls"]).await;
    assert_eq!(o.code, 1);
    assert!(o.stderr.contains("HTTP 401"), "{}", o.stderr);
    let o = telepy(h, &["logout"]).await;
    assert_eq!(o.code, 0);
    assert!(!h.join("config").join("credentials.json").exists() || !std::fs::read_to_string(h.join("config").join("credentials.json")).unwrap().contains("tpt_"));
}

/// Unix 秒 → `YYYY-MM-DD`（UTC）。/ Unix seconds → a UTC date.
fn chrono_like(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    // civil_from_days（Howard Hinnant）。
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

/// 瀏覽器登入（OAuth + PKCE + loopback）：CLI 印出同意頁網址，測試照前端同意頁的做法核可，再打開導回的
/// loopback 網址；CLI 換到 token，`ls` 照 scope 能用，沒給的 scope 被擋。
/// The browser sign-in: the CLI prints the consent URL, the test approves it the way the consent page does and
/// follows the loopback redirect; the CLI gets its tokens, `ls` works, an ungranted scope is refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn browser_sign_in_with_pkce_and_loopback() {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let m = lab.machine_with("box", &[("pi", &[&lab.service])], MachineOpts { shell: true, ..Default::default() }).await;
    let dev = lab.device(&alice, "box", &m).await;
    lab.username(&alice, &dev, "pi").await;
    let base = lab.ws_base().await.replace("ws://", "http://");
    let home = tempfile::tempdir().unwrap();
    let h = home.path().to_path_buf();

    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_telepy"))
        .args(["login", &base, "--no-browser", "--scope", "tunnels:read"])
        .env("HOME", &h)
        .env("TELEPY_CONFIG_DIR", h.join("config"))
        .env("TELEPY_NO_KEYRING", "1")
        .env_remove("TELEPY_URL")
        .env_remove("TELEPY_TOKEN")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
    let url = loop {
        let line = lines.next_line().await.unwrap().expect("the CLI printed the sign-in URL");
        if let Some(u) = line.trim().strip_prefix("http") {
            break format!("http{u}");
        }
    };
    let url = url::Url::parse(&url).unwrap();
    assert_eq!(url.path(), "/oauth/authorize");
    let mut body: serde_json::Map<String, Value> = url.query_pairs().map(|(k, v)| (k.into_owned(), Value::String(v.into_owned()))).collect();
    assert_eq!(body["code_challenge_method"], "S256");
    body.insert("approve".into(), json!(true));
    let r = lab.app.post("/api/oauth/authorize", Some(&alice.token), Value::Object(body)).await;
    assert_eq!(r.status.as_u16(), 200, "{}", r.text);
    let redirect = r.json["redirect_to"].as_str().unwrap().to_string();
    assert!(redirect.starts_with("http://127.0.0.1:"), "{redirect}");
    // 瀏覽器打開 loopback 網址。/ The browser follows the loopback redirect.
    let page = reqwest_get(&redirect).await;
    assert!(page.contains("Signed in"), "{page}");
    let status = child.wait().await.unwrap();
    let mut rest = String::new();
    while let Ok(Some(l)) = lines.next_line().await {
        rest.push_str(&l);
        rest.push('\n');
    }
    assert!(status.success(), "login failed: {rest}");
    assert!(rest.contains("as alice"), "{rest}");

    let o = telepy(&h, &["ls", "--json"]).await;
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(o.stdout.contains("\"box\""), "{}", o.stdout);
    let o = telepy(&h, &["whoami", "--json"]).await;
    assert!(o.stdout.contains("oauth_app"), "{}", o.stdout);
    // 只給了 tunnels:read：exec 被擋，訊息說缺哪個 scope。/ Only tunnels:read: exec is refused, naming the scope.
    let o = telepy(&h, &["exec", "box", "--", "id"]).await;
    assert_ne!(o.code, 0);
    assert!(o.stderr.contains("ssh:exec"), "{}", o.stderr);
}

/// 最小的 HTTP GET（測試不想為了一個請求多拉 reqwest 的 async 版）。/ A minimal HTTP GET.
async fn reqwest_get(url: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let u = url::Url::parse(url).unwrap();
    let mut s = tokio::net::TcpStream::connect((u.host_str().unwrap(), u.port().unwrap())).await.unwrap();
    let path = format!("{}?{}", u.path(), u.query().unwrap_or(""));
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    out
}
