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
    telepy_env(home, args, &[]).await
}

async fn telepy_env(home: &Path, args: &[&str], envs: &[(&str, &str)]) -> Out {
    let out = tokio::process::Command::new(env!("CARGO_BIN_EXE_telepy"))
        .args(args)
        .envs(envs.iter().copied())
        .env_remove("TELEPY_SSH_VIA")
        .env_remove("TELEPY_SSH_FALLBACK")
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("TELEPY_CONFIG_DIR", home.join("config"))
        .env("TELEPY_SSH_DIR", home.join("ssh"))
        .env("TELEPY_NO_KEYRING", "1")
        .env("TELEPY_NO_EXEC", "1")
        .env_remove("TELEPY_URL")
        .env_remove("TELEPY_TOKEN")
        // 開發者的 ssh-agent 不算這台「電腦」的金鑰。/ The developer's ssh-agent is not this test computer's.
        .env_remove("SSH_AUTH_SOCK")
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .expect("run telepy");
    Out { code: out.status.code().unwrap_or(-1), stdout: String::from_utf8_lossy(&out.stdout).into(), stderr: String::from_utf8_lossy(&out.stderr).into() }
}

/// shell 按 Tab 時的那一次呼叫（bash 的樣子）：`words` 不含 `telepy`，最後一個是正在打的字。
/// One Tab as bash asks it: `words` without `telepy`, the last one being typed.
async fn tab(home: &Path, words: &[&str]) -> Vec<String> {
    let index = words.len().to_string();
    let mut args = vec!["--", "telepy"];
    args.extend_from_slice(words);
    let envs = [("TELEPY_COMPLETE", "bash"), ("_CLAP_COMPLETE_INDEX", index.as_str()), ("_CLAP_IFS", "\n"), ("_CLAP_COMPLETE_COMP_TYPE", "9")];
    let o = telepy_env(home, &args, &envs).await;
    assert_eq!(o.code, 0, "{}", o.stderr);
    o.stdout.lines().map(str::to_string).collect()
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
    let r = lab.app.post("/api/auth/tokens", Some(&alice.token), json!({"name": "cli test", "scopes": ["tunnels:read", "ssh:exec", "ssh:files", "tunnels:manage"], "expires_at": expires})).await;
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
    assert!(!table.contains('\x1b'), "a pipe never gets colour: {table:?}");
    let coloured = telepy(h, &["--color", "always", "ls"]).await.stdout;
    assert!(coloured.starts_with("\x1b[1mNAME\x1b[0m") && coloured.contains("box"), "{coloured:?}");

    // Tab 補完：shell 叫 `TELEPY_COMPLETE=bash telepy -- <字>`。`ls` 已經記下名字和帳號；快取沒了就自己問伺服器。
    // Tab completion: the shell runs `TELEPY_COMPLETE=bash telepy -- <words>`. `ls` noted the names and accounts; without a cache it asks the server.
    assert!(h.join("config").join("completion.json").exists(), "ls fills the cache");
    assert!(tab(h, &["ssh", "b"]).await.contains(&"box".to_string()));
    assert_eq!(tab(h, &["ssh", "box@"]).await, ["box@pi"]);
    assert_eq!(tab(h, &["ls", "--label", "e"]).await, ["env=lab"]);
    assert!(tab(h, &["cp", "bo"]).await.contains(&"box:".to_string()));
    std::fs::remove_file(h.join("config").join("completion.json")).unwrap();
    assert_eq!(tab(h, &["status", "b"]).await, ["box"], "no cache: asked the server");
    assert!(tab(h, &["s"]).await.contains(&"ssh".to_string()));

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
    // 預設經網頁 port：伺服器那一跳是 telepy 自己當載具，gateway 記成 websocket。
    // By default through the web port: telepy itself carries the server hop, and the gateway records a websocket.
    assert!(conf.contains(" _carrier --url ws://") && conf.contains("ServerAliveInterval 30"), "{conf}");
    // 最後一筆 gateway 的 accepted。/ The last gateway "accepted" event.
    let last_accept = || async {
        sqlx::query_scalar::<_, String>("SELECT message FROM telepy_gateway_event WHERE event = 'accepted' ORDER BY id DESC LIMIT 1").fetch_one(&lab.app.state.db.read).await.unwrap()
    };
    assert!(last_accept().await.contains("over websocket"), "{}", last_accept().await);
    let ssh_args = ["ssh", "box@pi", "-i", alice.key.path.to_str().unwrap(), "--ssh-opt", "-o BatchMode=yes"];
    // --via ssh：照舊直接連 SSH 的 port。/ --via ssh: the SSH port directly, as before.
    let o = telepy(h, &[&ssh_args[..], &["--via", "ssh", "--", "echo", "plain"]].concat()).await;
    assert!(o.code == 0 && o.stdout.contains("plain"), "{}", o.stderr);
    assert!(!std::fs::read_to_string(h.join("ssh").join("box.conf")).unwrap().contains("_carrier"));
    assert!(!last_accept().await.contains("over websocket"), "{}", last_accept().await);
    // 網頁 port 連不到：沒有終端機可以問 → 不退回，說怎麼允許。/ Web port down, no terminal to ask: no fallback, says how to allow it.
    let dead = [("TELEPY_WS_URL", "ws://127.0.0.1:1/ws/gateway/")];
    let o = telepy_env(h, &[&ssh_args[..], &["--", "echo", "never-here"]].concat(), &dead).await;
    assert!(o.code != 0 && !o.stdout.contains("never-here"), "{}", o.stdout);
    assert!(o.stderr.contains("no terminal to ask") && o.stderr.contains("telepy config fallback always"), "{}", o.stderr);
    // --fallback always：改走 SSH 的 port，並說一聲。/ --fallback always: the SSH port, and it says so.
    let o = telepy_env(h, &[&ssh_args[..], &["--fallback", "always", "--", "echo", "fell-back"]].concat(), &dead).await;
    assert!(o.code == 0 && o.stdout.contains("fell-back"), "{}", o.stderr);
    assert!(o.stderr.contains("connecting on the SSH port"), "{}", o.stderr);
    // 存成這台伺服器的設定：never → 不退回；always → 不問直接退回；ask → 回到預設。
    // Saved per server: never → no fallback; always → falls back without asking; ask → the default again.
    let o = telepy(h, &["config", "fallback", "never"]).await;
    assert!(o.code == 0 && o.stdout.contains("never use the SSH port"), "{}{}", o.stdout, o.stderr);
    let o = telepy_env(h, &[&ssh_args[..], &["--", "echo", "x"]].concat(), &dead).await;
    assert!(o.code != 0 && o.stderr.contains("turned off for this server"), "{}", o.stderr);
    assert_eq!(telepy(h, &["config", "fallback", "always"]).await.code, 0);
    let o = telepy_env(h, &[&ssh_args[..], &["--", "echo", "saved-always"]].concat(), &dead).await;
    assert!(o.code == 0 && o.stdout.contains("saved-always"), "{}", o.stderr);
    let o = telepy(h, &["config", "fallback"]).await;
    assert!(o.stdout.contains(": always"), "{}", o.stdout);
    assert_eq!(telepy(h, &["config", "fallback", "ask"]).await.code, 0);

    // lan：手動加一台、列出、用標籤刪掉。/ lan: add one by hand, list, remove it by label.
    let o = telepy(h, &["lan", "add", "box", "192.168.50.9", "--label", "nas", "--user", "pi"]).await;
    assert_eq!(o.code, 0, "lan add: {}", o.stderr);
    let o = telepy(h, &["lan", "ls", "box", "--json"]).await;
    let hosts: Value = serde_json::from_str(&o.stdout).unwrap_or_else(|_| panic!("lan ls: {} {}", o.stdout, o.stderr));
    assert_eq!((hosts[0]["address"].as_str(), hosts[0]["label"].as_str(), hosts[0]["username"].as_str()), (Some("192.168.50.9"), Some("nas"), Some("pi")), "{hosts}");
    assert!(telepy(h, &["lan", "ls", "box"]).await.stdout.contains("192.168.50.9"));
    let o = telepy(h, &["lan", "rm", "box", "nas"]).await;
    assert_eq!(o.code, 0, "lan rm: {}", o.stderr);
    assert_eq!(telepy(h, &["lan", "ls", "box", "--json"]).await.stdout.trim(), "[]");

    // api tokens / activity：用 token 讀自己的呼叫紀錄（上面那些 ls / exec / lan 都在裡面）；--all 不是管理員 → 說清楚。
    // api tokens / activity: the token reads its own call log (the ls / exec / lan calls above); --all as a non-admin says why not.
    lab.app.state.api_calls.flush().await;
    let o = telepy(h, &["api", "activity", "--json", "--limit", "500"]).await;
    assert_eq!(o.code, 0, "api activity: {}", o.stderr);
    let rows: Value = serde_json::from_str(&o.stdout).unwrap_or_else(|_| panic!("api activity: {} {}", o.stdout, o.stderr));
    let rows = rows.as_array().unwrap();
    let has = |m: &str, route: &str| rows.iter().any(|c| c["method"] == m && c["route"] == route && c["token"]["name"] == "cli test" && c["user"]["username"] == "alice");
    assert!(has("GET", "/api/reverse/server/dashboard"), "{rows:?}");
    assert!(has("POST", "/api/ai/sessions/{id}/exec"), "{rows:?}");
    assert!(has("POST", "/api/reverse/server/{id}/lan/hosts"), "{rows:?}");
    let ids: Vec<i64> = rows.iter().map(|c| c["id"].as_i64().unwrap()).collect();
    assert!(ids.windows(2).all(|w| w[0] > w[1]), "newest first: {ids:?}");
    let o = telepy(h, &["api", "activity", "--api-token", "cli test", "--method", "post", "--json"]).await;
    let posts: Value = serde_json::from_str(&o.stdout).unwrap_or_else(|_| panic!("{} {}", o.stdout, o.stderr));
    assert!(!posts.as_array().unwrap().is_empty() && posts.as_array().unwrap().iter().all(|c| c["method"] == "POST"), "{posts}");
    let o = telepy(h, &["api", "activity", "--limit", "3"]).await;
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(o.stdout.starts_with("TIME") && o.stdout.contains("cli test"), "{}", o.stdout);
    assert_eq!(o.stdout.lines().count(), 4, "header + 3 rows: {}", o.stdout);
    let o = telepy(h, &["api", "activity", "--since", "1h", "--status", "5xx", "--json"]).await;
    assert_eq!((o.code, o.stdout.trim()), (0, "[]"), "{}", o.stderr);
    let o = telepy(h, &["api", "activity", "--all"]).await;
    assert_eq!(o.code, 1);
    assert!(o.stderr.contains("Only admins can see other people's API activity"), "{}", o.stderr);
    let o = telepy(h, &["api", "tokens"]).await;
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(o.stdout.starts_with("NAME") && o.stdout.contains("cli test") && o.stdout.contains("active"), "{}", o.stdout);
    let o = telepy(h, &["api", "tokens", "--json"]).await;
    let toks: Value = serde_json::from_str(&o.stdout).unwrap();
    assert!(toks[0]["calls"]["calls_24h"].as_i64().unwrap() > 0, "{toks}");

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
    assert!(!h.join("config").join("completion.json").exists(), "signing out forgets the names");
    assert!(!h.join("config").join("credentials.json").exists() || !std::fs::read_to_string(h.join("config").join("credentials.json")).unwrap().contains("tpt_"));
}

/// Unix 秒 → `YYYY-MM-DD`（UTC）。/ Unix seconds → a UTC date.
/// 金鑰不對時 `telepy ssh` 說清楚是哪一關：這台電腦沒有金鑰 → Telepy 不認得它 → `keys add`（網頁那邊按下去）→
/// 不在裝置的清單上 → `keys check --yes` 放上去、等 Telepy 裝好 → 連得進去。HOME 是暫存目錄，金鑰都是現做的。
/// When the key is wrong, `telepy ssh` says which hop: no key on this computer → Telepy doesn't know it → `keys add`
/// (confirmed on the web side) → not on the device's list → `keys check --yes` puts it there and waits → it gets in.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ssh_explains_and_fixes_a_missing_key() {
    let Some(lab) = Lab::start().await else { return };
    if sftp_server_bin().is_none() {
        eprintln!("skipping: no sftp-server");
        return;
    }
    // 正式環境的同步迴圈（lab 沒有起）：放上清單之後才會裝上去。/ The production sync loop (the lab doesn't run it).
    tokio::spawn(telepy_server::device_keys::run(lab.app.state.clone()));
    let carol = lab.user("carol").await;
    let m = lab.machine_with("box", &[("pi", &[&lab.service])], MachineOpts { shell: true, ..Default::default() }).await;
    m.account_home("pi");
    let dev = lab.device(&carol, "box", &m).await;
    lab.username(&carol, &dev, "pi").await;
    let expires = chrono_like((std::time::SystemTime::now() + std::time::Duration::from_secs(86_400)).duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
    let r = lab.app.post("/api/auth/tokens", Some(&carol.token), json!({"name": "laptop cli", "scopes": ["tunnels:read", "ssh:exec"], "expires_at": expires})).await;
    assert_eq!(r.status.as_u16(), 201, "{}", r.text);
    let secret = r.json["secret"].as_str().unwrap().to_string();
    let base = lab.ws_base().await.replace("ws://", "http://");
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    assert_eq!(telepy(h, &["login", &base, "--token", &secret]).await.code, 0);
    // OpenSSH 展開 `~` 用的是帳號的家目錄、不是 $HOME：測試的 HOME 是暫存目錄，所以金鑰檔明寫（還不存在也行）。
    // OpenSSH expands `~` from the account's home, not $HOME, and this test's HOME is a temp dir: name the key file (it may not exist yet).
    let key_file = h.join(".ssh").join("id_ed25519");
    let key_arg = key_file.to_str().unwrap().to_string();
    let ssh = ["ssh", "box@pi", "-i", key_arg.as_str(), "--via", "ssh", "--ssh-opt", "-o BatchMode=yes", "--", "echo", "in-$USER"];

    // 1) 這台電腦沒有金鑰：說清楚，不交給 OpenSSH。/ No key on this computer: explained, OpenSSH never runs.
    let o = telepy(h, &ssh).await;
    assert_eq!(o.code, 1, "{}", o.stderr);
    assert!(o.stderr.contains("This computer has no SSH key") && o.stderr.contains("telepy keys add"), "{}", o.stderr);
    assert!(!o.stderr.contains("Permission denied") && !o.stderr.contains("telepy: "), "only Telepy's explanation: {}", o.stderr);

    // 2) 有一把，但 Telepy 不認得：指紋與修法。/ A key Telepy doesn't know: its fingerprint and the fix.
    std::fs::create_dir_all(key_file.parent().unwrap()).unwrap();
    let st = std::process::Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-C", "carol@laptop", "-f"]).arg(&key_file).status().unwrap();
    assert!(st.success());
    let public = std::fs::read_to_string(h.join(".ssh").join("id_ed25519.pub")).unwrap().trim().to_string();
    let fp = telepy_cli::keys::fingerprint(&public).unwrap();
    let o = telepy(h, &ssh).await;
    assert_eq!(o.code, 1, "{}", o.stderr);
    assert!(o.stderr.contains("Telepy doesn't know any SSH key this computer offers") && o.stderr.contains(&fp), "{}", o.stderr);
    assert!(o.stderr.contains("belong to other computers") && o.stderr.contains("adds ~/.ssh/id_ed25519.pub"), "{}", o.stderr);
    let o = telepy(h, &["keys"]).await;
    assert!(o.stdout.contains("carol-laptop") && o.stdout.contains("None of these is on this computer"), "{}", o.stdout);
    let o = telepy(h, &["doctor"]).await;
    assert!(o.stdout.contains("ssh key: none of this computer's keys is in Telepy"), "{}", o.stdout);

    // 3) `keys add`：印出網頁的網址（公鑰已填好）與指紋，等網頁那邊加好（這裡用 API 代替按下去）。
    // `keys add` prints the web address (key filled in) and the fingerprint, then waits for the web side (the API here).
    let child = tokio::process::Command::new(env!("CARGO_BIN_EXE_telepy"))
        .args(["keys", "add"])
        .env("HOME", h)
        .env("USERPROFILE", h)
        .env("TELEPY_CONFIG_DIR", h.join("config"))
        .env("TELEPY_SSH_DIR", h.join("ssh"))
        .env("TELEPY_NO_KEYRING", "1")
        .env("TELEPY_NO_BROWSER", "1")
        .env_remove("TELEPY_URL")
        .env_remove("TELEPY_TOKEN")
        .env_remove("SSH_AUTH_SOCK")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let r = lab.app.post("/api/reverse/user/keys", Some(&carol.token), json!({"host_friendly_name": "carol-mac", "key": public})).await;
    assert!(r.status.is_success(), "{}", r.text);
    let out = tokio::time::timeout(std::time::Duration::from_secs(30), child.wait_with_output()).await.expect("keys add finishes").unwrap();
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "{err}");
    assert!(err.contains("/tunnels/keys?add=ssh-ed25519%20") && err.contains("&from=cli") && err.contains(&fp), "{err}");
    assert!(err.contains("Added \"carol-mac\" to Telepy."), "{err}");
    let o = telepy(h, &["keys", "add"]).await;
    assert!(o.code == 0 && o.stderr.contains("is already in Telepy as \"carol-mac\""), "{}", o.stderr);

    // 4) Telepy 認得了，但裝置的清單上沒有、那個帳號的檔案裡也沒有（先同步一次，讓 Telepy 讀過檔）：確定會被拒絕，
    // 沒有終端機可問 → 說明，不交給 OpenSSH。（沒讀過檔的「不確定」那條路在後端的 tests/ssh_check.rs。）
    // Telepy knows it, but neither the device's list nor the account's file has it (synced first, so the file was
    // read): certainly refused, no terminal to ask → explained, OpenSSH never runs. (The uncertain path, file not read,
    // is in the backend's tests/ssh_check.rs.)
    let r = lab.app.post(&format!("/api/reverse/server/{}/device-keys/sync", dev.tunnel_id), Some(&carol.token), json!({})).await;
    assert!(r.status.is_success(), "{}", r.text);
    let o = telepy(h, &ssh).await;
    assert_eq!(o.code, 1, "{}", o.stderr);
    assert!(o.stderr.contains("box won't let your key \"carol-mac\"") && o.stderr.contains("telepy keys check box@pi --yes"), "{}", o.stderr);
    assert!(!o.stderr.contains("Permission denied"), "{}", o.stderr);

    // 5) `keys check --yes`：一關一關列出，放上清單（只到 pi），等裝好。/ Hop by hop, placed (pi only), installed.
    let o = telepy(h, &["keys", "check", "box@pi", "--yes"]).await;
    assert_eq!(o.code, 0, "{}\n{}", o.stdout, o.stderr);
    assert!(o.stdout.contains("knows your key \"carol-mac\"") && o.stdout.contains("your key is installed"), "{}", o.stdout);
    assert!(o.stderr.contains("\"carol-mac\" is installed on box for pi."), "{}", o.stderr);
    assert!(m.authorized_keys("pi").contains(public.split_whitespace().nth(1).unwrap()));

    // 6) 連得進去；檢查沒話說。/ It gets in, and the check has nothing to say.
    let o = telepy(h, &ssh).await;
    assert!(o.code == 0 && o.stdout.contains("in-pi"), "{}\n{}", o.stdout, o.stderr);
    assert!(!o.stderr.contains("✗") && !o.stderr.contains("Telepy hasn't"), "{}", o.stderr);
    let o = telepy(h, &["keys", "check", "box@pi", "--json"]).await;
    let v: Value = serde_json::from_str(&o.stdout).unwrap_or_else(|_| panic!("{} {}", o.stdout, o.stderr));
    assert_eq!((v["check"]["ready"].as_bool(), v["offered"][0]["fingerprint"].as_str()), (Some(true), Some(fp.as_str())), "{v}");
    let o = telepy(h, &["doctor"]).await;
    assert!(o.stdout.contains("ssh key: \"carol-mac\""), "{}", o.stdout);
    // --no-check：不問 Telepy（伺服器太舊時的樣子）。/ --no-check skips it (what an older server looks like).
    let o = telepy(h, &[&ssh[..2], &["--no-check"], &ssh[2..]].concat()).await;
    assert!(o.code == 0 && o.stdout.contains("in-pi"), "{}", o.stderr);
}

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
    // 瀏覽器打開 loopback 網址：CLI 換完 token 才回，把瀏覽器送到伺服器的完成頁。
    // The browser follows the loopback redirect: the CLI answers after the exchange, sending it to the server's done page.
    let page = reqwest_get(&redirect).await;
    let client_id = url.query_pairs().find(|(k, _)| k == "client_id").unwrap().1.into_owned();
    assert!(page.starts_with("HTTP/1.1 303"), "{page}");
    assert!(page.contains(&format!("location: {base}/oauth/done?client_id={client_id}&result=ok\r\n")), "{page}");
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

    // 再登入一次、在同意頁按拒絕：完成頁說 denied，CLI 失敗。/ Again, denied on the approval page: the done page says so.
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_telepy"))
        .args(["login", &base, "--no-browser"])
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
            break url::Url::parse(&format!("http{u}")).unwrap();
        }
    };
    let mut body: serde_json::Map<String, Value> = url.query_pairs().map(|(k, v)| (k.into_owned(), Value::String(v.into_owned()))).collect();
    body.insert("approve".into(), json!(false));
    let r = lab.app.post("/api/oauth/authorize", Some(&alice.token), Value::Object(body)).await;
    let page = reqwest_get(r.json["redirect_to"].as_str().unwrap()).await;
    assert!(page.starts_with("HTTP/1.1 303") && page.contains("&result=denied\r\n"), "{page}");
    assert!(!child.wait().await.unwrap().success(), "a denied sign-in fails");
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

/// `telepy forward`：區網主機（lab 裡用本機的一個 TCP 服務代替，用標籤找）的 port 經裝置的 sshd 轉到這台電腦；
/// 沒給 port、又不知道它的網頁 port 就說要寫；不是網頁 port 時印 `localhost:<port>`，`--https` 印 https 網址。
/// `telepy forward`: a LAN host's port (a local TCP service here, found by its label) reaches this computer through
/// the device's sshd; without a port and no known web port it says to give one; a non-web port prints
/// `localhost:<port>`, `--https` an https URL.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn forward_brings_a_lan_port_to_this_computer() {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let m = lab.machine_with("box", &[("pi", &[&lab.service, &alice.key])], MachineOpts { allow_jump: true, ..Default::default() }).await;
    let dev = lab.device(&alice, "box", &m).await;
    lab.username(&alice, &dev, "pi").await;
    // 「區網上的網頁伺服器」：每條連線回同一段 HTTP。/ The "LAN web server": every connection gets the same answer.
    let web = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let web_port = web.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = web.accept().await else { break };
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf).await;
                let _ = s.write_all(b"HTTP/1.0 200 OK\r\ncontent-length: 9\r\n\r\nfrom-lan!").await;
            });
        }
    });
    let r = lab.app.post(&format!("/api/reverse/server/{}/lan/hosts", dev.tunnel_id), Some(&alice.token), json!({"address": "127.0.0.1", "label": "nas"})).await;
    assert!(r.status.is_success(), "{}", r.text);
    let expires = chrono_like((std::time::SystemTime::now() + std::time::Duration::from_secs(86_400)).duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
    let r = lab.app.post("/api/auth/tokens", Some(&alice.token), json!({"name": "fwd", "scopes": ["tunnels:read", "ssh:exec"], "expires_at": expires})).await;
    let secret = r.json["secret"].as_str().unwrap().to_string();
    let base = lab.ws_base().await.replace("ws://", "http://");
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    assert_eq!(telepy(h, &["login", &base, "--token", &secret]).await.code, 0);

    // 沒 port、也不知道網頁 port。/ No port and no known web port.
    let o = telepy(h, &["forward", "box@pi", "nas"]).await;
    assert!(o.code != 0 && o.stderr.contains("No port given"), "{}", o.stderr);

    let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let key = alice.key.path.to_str().unwrap().to_string();
    let to = format!("nas:{web_port}");
    let local = free.to_string();
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_telepy"))
        .args(["forward", "box@pi", &to, "--local", &local, "-i", &key, "--ssh-opt", "-o BatchMode=yes"])
        .env("HOME", h)
        .env("TELEPY_CONFIG_DIR", h.join("config"))
        .env("TELEPY_SSH_DIR", h.join("ssh"))
        .env("TELEPY_NO_KEYRING", "1")
        .env("TELEPY_NO_BROWSER", "1")
        .env_remove("TELEPY_SSH_VIA")
        .env_remove("TELEPY_URL")
        .env_remove("TELEPY_TOKEN")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
    let first = tokio::time::timeout(std::time::Duration::from_secs(40), lines.next_line()).await;
    let first = match first {
        Ok(Ok(Some(l))) => l,
        other => {
            let mut err = String::new();
            let _ = child.stderr.take().unwrap().read_to_string(&mut err).await;
            panic!("forward never came up: {other:?} {err}");
        }
    };
    assert_eq!(first, format!("localhost:{free}"), "not a web port: no URL");
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", free)).await.unwrap();
    s.write_all(b"GET / HTTP/1.0\r\n\r\n").await.unwrap();
    let mut body = String::new();
    s.read_to_string(&mut body).await.unwrap();
    assert!(body.ends_with("from-lan!"), "{body}");
    child.kill().await.unwrap();
}

/// `telepy lan scan` / `lan show`：掃描等到完成、表上多一欄 WHAT；show 列出每個 port 看到的。
/// `telepy lan scan` waits for the scan and the table has WHAT; `lan show` lists what each port showed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lan_scan_recognises_and_shows() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let m = lab.machine_with("box", &[("pi", &[&lab.service])], MachineOpts { allow_jump: true, ..Default::default() }).await;
    let dev = lab.device(&alice, "box", &m).await;
    lab.username(&alice, &dev, "pi").await;
    let web = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let web_port = web.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = web.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                if s.read(&mut buf).await.unwrap_or(0) > 0 {
                    let body = "<title>OpenWrt - LuCI</title>";
                    let _ = s.write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{body}", body.len()).as_bytes()).await;
                }
            });
        }
    });
    let expires = chrono_like((std::time::SystemTime::now() + std::time::Duration::from_secs(86_400)).duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
    let r = lab.app.post("/api/auth/tokens", Some(&alice.token), json!({"name": "scan", "scopes": ["tunnels:read", "network:scan", "tunnels:manage", "ssh:exec"], "expires_at": expires})).await;
    let secret = r.json["secret"].as_str().unwrap().to_string();
    let base = lab.ws_base().await.replace("ws://", "http://");
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    assert_eq!(telepy(h, &["login", &base, "--token", &secret]).await.code, 0);

    let ports = web_port.to_string();
    let o = telepy(h, &["lan", "scan", "box", "--subnet", "127.0.0.1/32", "--ports", &ports]).await;
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(o.stderr.contains("Done: 1 machine(s)."), "{}", o.stderr);
    assert!(o.stdout.contains("WHAT") && o.stdout.contains("OpenWrt"), "{}", o.stdout);
    assert!(o.stderr.contains("Since the previous scan: 1 new (127.0.0.1)."), "{}", o.stderr);
    assert!(o.stdout.contains("NOTE") && o.stdout.contains("new"), "{}", o.stdout);
    // 再掃一次：沒變。`lan ls` 上面寫上次掃描的時間與網段。/ Again: nothing changed; `lan ls` says when and what was scanned.
    let o = telepy(h, &["lan", "scan", "box", "--subnet", "127.0.0.1/32", "--ports", &ports]).await;
    assert!(o.stderr.contains("Nothing changed since the previous scan."), "{}", o.stderr);
    let o = telepy(h, &["lan", "ls", "box"]).await;
    assert!(o.stderr.contains("Last scan ") && o.stderr.contains(" of 127.0.0.1/32."), "{}", o.stderr);
    // 定時重掃：設、看、停；檢查一台。/ Scheduled rescans: set, show, stop; check one host.
    let o = telepy(h, &["lan", "schedule", "box", "--every", "6h", "--subnet", "127.0.0.1/32", "--ports", &ports]).await;
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(o.stdout.contains("Rescans every 6 hours, next ") && o.stdout.contains("(set by alice)."), "{}", o.stdout);
    let o = telepy(h, &["lan", "ls", "box"]).await;
    assert!(o.stderr.contains("Rescans every 6 hours"), "{}", o.stderr);
    let o = telepy(h, &["lan", "check", "box", "127.0.0.1", "--ports", &ports]).await;
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(o.stdout.contains(&format!("127.0.0.1 answered: ports {web_port}.")), "{}", o.stdout);
    let o = telepy(h, &["lan", "schedule", "box", "--every", "off"]).await;
    assert!(o.code == 0 && o.stderr.contains("Stopped the rescans of box."), "{}", o.stderr);
    let o = telepy(h, &["lan", "schedule", "box"]).await;
    assert!(o.stdout.contains("No scheduled rescan for box."), "{}", o.stdout);
    // 標籤與備註；沒有 MAC 就不能喚醒（說清楚為什麼）。/ Labels and a note; no MAC, no wake (and it says why).
    let o = telepy(h, &["lan", "edit", "box", "127.0.0.1", "--labels", "Rack-2,prod", "--note", "top shelf"]).await;
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(o.stdout.contains("  labels: prod, rack-2") && o.stdout.contains("  note: top shelf"), "{}", o.stdout);
    let o = telepy(h, &["lan", "ls", "box"]).await;
    assert!(o.stdout.contains("#prod, #rack-2"), "{}", o.stdout);
    let o = telepy(h, &["lan", "wake", "box", "127.0.0.1"]).await;
    assert_ne!(o.code, 0);
    assert!(o.stderr.contains("MAC address"), "{}", o.stderr);
    let o = telepy(h, &["lan", "show", "box", "127.0.0.1"]).await;
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(o.stdout.contains("is: OpenWrt") && o.stdout.contains(&format!("{web_port}/http  200  title: OpenWrt - LuCI")), "{}", o.stdout);
    assert!(o.stdout.contains(&format!("web: http://127.0.0.1:{web_port}/")), "{}", o.stdout);
}
