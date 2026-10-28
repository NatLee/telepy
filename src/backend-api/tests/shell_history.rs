//! 「連線中打的指令不寫進 shell 歷史檔」端到端（common::lab）：裝置帳號的登入 shell 是**真的** bash / zsh（在 PTY 裡、
//! HOME 在暫存目錄），歷史檔就在那裡，測試直接讀它。照常寫（預設）、這條隧道不寫（個人覆寫）、個人預設不寫、
//! readonly 的 HISTFILE（管理員要留歷史）不繞過，以及 MCP agent 的 shell。
//! "Keep this connection's commands out of the shell history" end to end: the account's login shell is a real
//! bash / zsh in a PTY with HOME in a scratch dir, so the test reads the history file itself.
mod common;

use std::path::Path;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use common::lab::{Device, Lab, LabUser, Machine, MachineOpts};
use serde_json::{json, Value};

const NOTICE_OFF: &str = "[Telepy] Commands in this shell stay out of its history file.";

/// 一台登入 shell 是 `shell` 的機器（沒裝這個 shell 就 None，測試跳過）。/ A machine whose login shell is `shell`.
async fn machine(lab: &Lab, shell: &'static str, rc_name: &str, rc: &str) -> Option<Machine> {
    if !Path::new(shell).exists() {
        eprintln!("skipping: {shell} is not installed");
        return None;
    }
    let m = lab.machine_with("box", &[("ubuntu", &[&lab.service])], MachineOpts { shell: true, login_shell: Some(shell), ..Default::default() }).await;
    std::fs::write(m.account_home("ubuntu").join(rc_name), rc).unwrap();
    Some(m)
}

fn history(m: &Machine, file: &str) -> String {
    std::fs::read_to_string(m.account_home("ubuntu").join(file)).unwrap_or_default()
}

/// 開終端機、等提示字元、跑一行、`exit`（bash / zsh 結束時也會寫歷史檔）。回傳畫面上的全部輸出。
/// Open a terminal, run one line, `exit` (shells write their history on exit too); returns everything shown.
async fn run_line(lab: &Lab, user: &LabUser, dev: &Device, line: &str, expect: &str) -> String {
    let mut term = lab.terminal(user, dev, "ubuntu").await.expect("terminal opens");
    term.expect("$ ").await;
    term.input(&format!("{line}\r")).await;
    term.expect(expect).await;
    term.input("exit\r").await;
    term.wait_closed().await;
    term.seen
}

async fn open_events(lab: &Lab, user: &LabUser, tunnel_id: i64) -> Vec<String> {
    let r = lab.app.get(&format!("/api/log/ssh/events?tunnel_id={tunnel_id}&limit=500"), Some(&user.token)).await;
    r.json.as_array().unwrap().iter().filter(|e| e["event"] == "terminal_open").map(|e| e["message"].as_str().unwrap_or_default().to_string()).collect()
}

const BASHRC: &str = "PS1='$ '\nHISTFILE=~/.bash_history\nHISTSIZE=1000\nHISTFILESIZE=1000\n# 每個指令跑完就寫進檔案（最難藏的設定）。/ Append after every command (the hardest case).\nPROMPT_COMMAND='history -a'\n";

#[tokio::test]
async fn bash_history_follows_the_default_and_the_tunnel_override() {
    let Some(lab) = Lab::start().await else { return };
    let Some(m) = machine(&lab, "/bin/bash", ".bashrc", BASHRC).await else { return };
    let alice = lab.user("alice").await;
    let dev = lab.device(&alice, "box", &m).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let pref = format!("/api/reverse/server/{}/shell-history", dev.tunnel_id);

    // 預設照常寫：沒有提示行，指令進歷史檔。/ By default the history is kept: no notice, the command is saved.
    let r = lab.app.get(&pref, Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!((r.json["mode"].clone(), r.json["default"].clone(), r.json["effective"].clone()), (Value::Null, json!("keep"), json!("keep")));
    let seen = run_line(&lab, &alice, &dev, "echo kept-$((40+2))", "kept-42").await;
    assert!(!seen.contains("[Telepy]"), "{seen:?}");
    assert!(history(&m, ".bash_history").contains("echo kept-$((40+2))"), "the usual history: {:?}", history(&m, ".bash_history"));

    // 這條隧道不寫：提示行、看不到設定那行，歷史檔裡沒有這次的任何東西。
    // This tunnel keeps it out: a notice, no setup line on screen, nothing from this session in the file.
    assert_eq!(lab.app.put(&pref, Some(&alice.token), json!({"mode": "nope"})).await.status, StatusCode::BAD_REQUEST);
    let r = lab.app.put(&pref, Some(&alice.token), json!({"mode": "skip"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!((r.json["effective"].clone(), r.json["source"].clone()), (json!("skip"), json!("tunnel")));
    let seen = run_line(&lab, &alice, &dev, "echo hidden-$((40+2))", "hidden-42").await;
    assert!(seen.contains(NOTICE_OFF), "{seen:?}");
    assert!(!seen.contains("HISTFILE") && !seen.contains("telepy-history-off"), "the setup line is not shown: {seen:?}");
    let file = history(&m, ".bash_history");
    assert!(!file.contains("hidden") && !file.contains("HISTFILE") && !file.contains("telepy-history-off"), "nothing from the private session: {file:?}");
    assert!(file.contains("kept-"), "the earlier history is untouched: {file:?}");
    assert!(open_events(&lab, &alice, dev.tunnel_id).await.iter().any(|m| m.contains("(shell history off, bash)")), "the audit line says so");

    // 個人預設不寫、這條隧道改回「照常寫」：隧道的覆寫贏。/ Default skip, tunnel says keep: the tunnel wins.
    let r = lab.app.post("/api/user/settings", Some(&alice.token), json!({"shell_history": "skip"})).await;
    assert_eq!((r.status, r.json["shell_history"].clone()), (StatusCode::OK, json!("skip")), "{}", r.text);
    assert_eq!(lab.app.post("/api/user/settings", Some(&alice.token), json!({"shell_history": "maybe"})).await.status, StatusCode::BAD_REQUEST);
    let r = lab.app.put(&pref, Some(&alice.token), json!({"mode": "keep"})).await;
    assert_eq!((r.json["effective"].clone(), r.json["default"].clone()), (json!("keep"), json!("skip")));
    run_line(&lab, &alice, &dev, "echo tunnel-keeps-$((1+1))", "tunnel-keeps-2").await;
    assert!(history(&m, ".bash_history").contains("tunnel-keeps"));

    // 拿掉覆寫 = 跟隨個人預設（不寫）。/ No override = the personal default (skip).
    let r = lab.app.put(&pref, Some(&alice.token), json!({"mode": null})).await;
    assert_eq!((r.json["mode"].clone(), r.json["effective"].clone(), r.json["source"].clone()), (Value::Null, json!("skip"), json!("default")));
    let seen = run_line(&lab, &alice, &dev, "echo default-skip-$((1+1))", "default-skip-2").await;
    assert!(seen.contains(NOTICE_OFF), "{seen:?}");
    assert!(!history(&m, ".bash_history").contains("default-skip"));

    // 別人看不到這條隧道就是 404。/ Someone who can't see the tunnel gets a 404.
    let bob = lab.user("bob").await;
    assert_eq!(lab.app.get(&pref, Some(&bob.token)).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_readonly_histfile_is_respected() {
    let Some(lab) = Lab::start().await else { return };
    // 管理員用 readonly 強制留歷史：Telepy 不繞過，也不把錯誤藏起來。/ An enforced history: never bypassed, never hidden.
    let rc = "PS1='$ '\nreadonly HISTFILE=~/.bash_history\nPROMPT_COMMAND='history -a'\n";
    let Some(m) = machine(&lab, "/bin/bash", ".bashrc", rc).await else { return };
    let alice = lab.user("alice").await;
    let dev = lab.device(&alice, "box", &m).await;
    lab.username(&alice, &dev, "ubuntu").await;
    lab.app.post("/api/user/settings", Some(&alice.token), json!({"shell_history": "skip"})).await;
    let seen = run_line(&lab, &alice, &dev, "echo audited-$((1+1))", "audited-2").await;
    assert!(seen.contains("[Telepy] Couldn't turn off this shell's history"), "{seen:?}");
    assert!(seen.contains("readonly"), "the shell's own error stays visible: {seen:?}");
    assert!(history(&m, ".bash_history").contains("echo audited-$((1+1))"), "the enforced history still has it");
}

#[tokio::test]
async fn zsh_with_incremental_history() {
    let Some(lab) = Lab::start().await else { return };
    // 每行一進來就寫（INC_APPEND_HISTORY），像 oh-my-zsh 一樣忽略開頭是空白的行。
    // Every line written as it is entered, and lines starting with a space ignored, as oh-my-zsh does.
    let rc = "PROMPT='$ '\nHISTFILE=~/.zsh_history\nHISTSIZE=1000\nSAVEHIST=1000\nsetopt INC_APPEND_HISTORY HIST_IGNORE_SPACE\n";
    let Some(m) = machine(&lab, "/bin/zsh", ".zshrc", rc).await else { return };
    let alice = lab.user("alice").await;
    let dev = lab.device(&alice, "box", &m).await;
    lab.username(&alice, &dev, "ubuntu").await;
    run_line(&lab, &alice, &dev, "echo zkept-$((40+2))", "zkept-42").await;
    assert!(history(&m, ".zsh_history").contains("echo zkept-$((40+2))"), "{:?}", history(&m, ".zsh_history"));

    lab.app.post("/api/user/settings", Some(&alice.token), json!({"shell_history": "skip"})).await;
    let seen = run_line(&lab, &alice, &dev, "echo zhidden-$((40+2))", "zhidden-42").await;
    assert!(seen.contains(NOTICE_OFF), "{seen:?}");
    assert!(!seen.contains("HISTFILE") && !seen.contains("telepy-history-off"), "{seen:?}");
    let file = history(&m, ".zsh_history");
    assert!(!file.contains("zhidden") && !file.contains("HISTFILE"), "{file:?}");
    assert!(open_events(&lab, &alice, dev.tunnel_id).await.iter().any(|m| m.contains("(shell history off, zsh)")));
}

async fn mcp(lab: &Lab, token: &str, tool: &str, args: Value) -> Value {
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}});
    let req = Request::builder()
        .method(Method::POST)
        .uri("/mcp")
        .header(header::HOST, "telepy.test")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-06-18")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(body.to_string()))
        .unwrap();
    let r = lab.app.send(req).await;
    assert_eq!(r.status, StatusCode::OK, "{tool}: {}", r.text);
    let result = &r.json["result"];
    assert_eq!(result["isError"], false, "{tool}: {}", r.text);
    result["structuredContent"].clone()
}

/// 讀 agent shell 的輸出直到出現 `needle`。/ Read an agent shell until `needle` shows up.
async fn agent_read_until(lab: &Lab, token: &str, shell: &str, needle: &str) -> String {
    let mut all = String::new();
    for _ in 0..20 {
        let r = mcp(lab, token, "shell_read", json!({"shell_id": shell, "timeout_ms": 1000})).await;
        all.push_str(r["output"].as_str().unwrap_or_default());
        if all.contains(needle) {
            return all;
        }
    }
    panic!("never saw {needle:?}; got {all:?}");
}

#[tokio::test]
async fn agent_shells_follow_the_same_setting() {
    let Some(lab) = Lab::start().await else { return };
    let Some(m) = machine(&lab, "/bin/bash", ".bashrc", BASHRC).await else { return };
    let alice = lab.user("alice").await;
    let dev = lab.device(&alice, "box", &m).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let expires = (chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339();
    let r = lab.app.post("/api/auth/tokens", Some(&alice.token), json!({"name": "agent", "scopes": ["tunnels:read", "ssh:exec"], "expires_at": expires})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let tok = r.json["secret"].as_str().unwrap().to_string();
    lab.app.put(&format!("/api/reverse/server/{}/shell-history", dev.tunnel_id), Some(&alice.token), json!({"mode": "skip"})).await;

    let session = mcp(&lab, &tok, "ssh_session_open", json!({"tunnel_id": dev.tunnel_id, "username": "ubuntu"})).await;
    let sid = session["session_id"].as_str().unwrap().to_string();
    let shell = mcp(&lab, &tok, "shell_open", json!({"session_id": sid})).await;
    assert_eq!(shell["history"], "off", "{shell}");
    let shid = shell["shell_id"].as_str().unwrap().to_string();
    mcp(&lab, &tok, "shell_send", json!({"shell_id": shid, "input": "echo agent-$((40+2))", "press_enter": true})).await;
    let out = agent_read_until(&lab, &tok, &shid, "agent-42").await;
    assert!(!out.contains("HISTFILE") && !out.contains("telepy-history-off"), "the agent never sees the setup: {out:?}");
    mcp(&lab, &tok, "shell_send", json!({"shell_id": shid, "input": "exit", "press_enter": true})).await;
    mcp(&lab, &tok, "ssh_session_close", json!({"session_id": sid})).await;
    let file = history(&m, ".bash_history");
    assert!(!file.contains("agent-"), "{file:?}");
    let (detail,): (String,) = sqlx::query_as("SELECT detail FROM telepy_ai_audit_event WHERE tool = 'shell_open' ORDER BY id DESC LIMIT 1").fetch_one(&lab.app.state.db.read).await.unwrap();
    assert!(detail.contains("shell history off, bash"), "{detail}");
}

#[tokio::test]
async fn lan_host_terminals_say_they_are_not_covered() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], true).await;
    let nas = lab.machine("nas", &[("admin", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let r = app.post(&format!("/api/reverse/server/{}/lan/hosts", dev.tunnel_id), Some(&alice.token), json!({"address": "127.0.0.1", "label": "nas", "username": "admin", "ssh_port": nas.port})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let nas_id = r.json["id"].as_i64().unwrap();
    app.post("/api/user/settings", Some(&alice.token), json!({"shell_history": "skip"})).await;
    // 區網主機那一跳的 shell 不知道是什麼：什麼都不打，提示行說這裡不算。/ Nothing typed; the notice says it isn't covered.
    let mut t = lab.terminal_with(&alice, &dev, "ubuntu", json!({"lan_host_id": nas_id})).await.expect("LAN terminal");
    t.expect("login:admin@nas").await;
    assert!(t.seen.contains("[Telepy] Can't keep commands out of the history in a LAN host's shell"), "{:?}", t.seen);
    assert!(!t.seen.contains("HISTFILE"));
    let r = app.get(&format!("/api/log/ssh/events?tunnel_id={}", dev.tunnel_id), Some(&alice.token)).await;
    assert!(r.json.as_array().unwrap().iter().any(|e| e["event"] == "lan_terminal" && e["message"].as_str().unwrap().contains("shell history kept")), "{}", r.text);
}
