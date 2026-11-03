//! 「這台跑什麼系統」的 I/O（規則都在 `lan::os`）：裝置上跑一段指令（ping 一次、有 nmap 而且是 root 就 `nmap -O`），
//! 經裝置的 sshd 讀那台的 SSH 問候、問它的 SMB 叫什麼名字（只到 NTLM CHALLENGE，不登入），再加上次掃描的 HTTP 標頭與
//! MAC 廠商。全部經連線池那條裝置連線；使用者按了才跑，一次一台。
//! The OS check's I/O (rules in `lan::os`): one command on the device (a ping, `nmap -O` when nmap and root are there),
//! the host's SSH greeting and its SMB's NTLM CHALLENGE (no login) through the device's sshd, plus the last scan's HTTP
//! headers and MAC vendor. Everything rides the pooled device connection; one host, only when someone asks.

use std::time::Duration;

use anyhow::Context;
use russh::client::Msg;
use russh::ChannelStream;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::os::{self, Evidence, NtlmInfo, OsCheck};
use crate::db::lan::LanHost;
use crate::db::tunnels::Tunnel;
use crate::ssh::pool::Lease;
use crate::state::AppState;

/// 裝置那段指令最久等多久（nmap 有自己的 40 秒上限）。/ How long the device script may take (nmap stops at 40 s).
const DEVICE_LIMIT: Duration = Duration::from_secs(70);
const PROBE_LIMIT: Duration = Duration::from_secs(6);

async fn exec(state: &AppState, t: &Tunnel, account: &str, cmd: &str) -> anyhow::Result<String> {
    let (_lease, ch) = state.pool.session_channel(state, t.reverse_port, account).await?;
    let r = crate::ssh::exec::run_on(ch, cmd, DEVICE_LIMIT, 64 * 1024).await?;
    Ok(r.stdout.text)
}

async fn open(lease: &Lease, ip: &str, port: u16) -> Option<ChannelStream<Msg>> {
    let ch = tokio::time::timeout(PROBE_LIMIT, lease.device().channel_open_direct_tcpip(ip, u32::from(port), "127.0.0.1", 0)).await.ok()?.ok()?;
    Some(ch.into_stream())
}

/// 那台的 SSH 問候（第一行 `SSH-…`）。/ The host's SSH greeting line.
async fn ssh_greeting(lease: &Lease, ip: &str, port: u16) -> Option<String> {
    let mut s = open(lease, ip, port).await?;
    let mut buf = Vec::new();
    let read = async {
        let mut chunk = [0u8; 512];
        while buf.len() < 2048 && !buf.contains(&b'\n') {
            let n = s.read(&mut chunk).await.ok()?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        Some(())
    };
    tokio::time::timeout(PROBE_LIMIT, read).await.ok()??;
    String::from_utf8_lossy(&buf).lines().find(|l| l.starts_with("SSH-")).map(|l| l.trim().to_string())
}

async fn read_message(s: &mut ChannelStream<Msg>) -> Option<Vec<u8>> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(m) = os::netbios_message(&buf) {
            return Some(m.to_vec());
        }
        if buf.len() > 256 * 1024 {
            return None;
        }
        let n = s.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// SMB2 協商 → SESSION_SETUP（NTLM NEGOTIATE）→ 讀 CHALLENGE，然後關掉（不登入）。/ Negotiate, ask, read, close.
async fn smb_info(lease: &Lease, ip: &str, port: u16) -> Option<NtlmInfo> {
    let mut s = open(lease, ip, port).await?;
    let talk = async {
        s.write_all(&os::smb_negotiate()).await.ok()?;
        let reply = read_message(&mut s).await?;
        if os::smb_status(&reply) != Some(0) {
            return None;
        }
        s.write_all(&os::smb_session_setup()).await.ok()?;
        let reply = read_message(&mut s).await?;
        os::parse_challenge(&reply)
    };
    let info = tokio::time::timeout(PROBE_LIMIT, talk).await.ok().flatten();
    let _ = s.shutdown().await;
    info
}

/// 同一台一次只檢查一個。/ One check per host at a time.
pub struct Running(i64);

static RUNNING: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<i64>>> = std::sync::OnceLock::new();

pub fn begin(host_id: i64) -> Option<Running> {
    let set = RUNNING.get_or_init(Default::default);
    set.lock().unwrap().insert(host_id).then_some(Running(host_id))
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(set) = RUNNING.get() {
            set.lock().unwrap().remove(&self.0);
        }
    }
}

/// 檢查一台（呼叫端已檢查權限、位址）。/ Check one host (the caller checked access and the address).
pub async fn run(state: &AppState, t: &Tunnel, h: &LanHost, account: &str, smb_port: Option<u16>, vendor: Option<&str>, by: &str) -> anyhow::Result<OsCheck> {
    let ip = h.address.as_str();
    let ports = h.open_port_list();
    let mut evidence: Vec<Evidence> = Vec::new();

    let cmd = os::posix_command(ip, &ports).context("not an IPv4 address")?;
    let out = exec(state, t, account, &cmd).await.with_context(|| format!("cannot run a command on the device as {account}"))?;
    let mut answer = os::parse_posix(&out);
    if !answer.posix {
        // Windows 裝置：cmd.exe 的 ping，不跑 nmap。/ A Windows device: cmd.exe's ping, no nmap.
        if let Some(cmd) = os::windows_command(ip) {
            if let Ok(out) = exec(state, t, account, &cmd).await {
                answer.ttl = os::parse_windows_ping(&out);
            }
        }
        answer.nmap = "windows".into();
    }
    if let Some(ttl) = answer.ttl {
        evidence.push(os::ttl_evidence(ttl));
    }
    evidence.extend(os::http_evidence(&h.service_list()));
    if let Some(v) = vendor {
        evidence.extend(os::vendor_evidence(v));
    }

    let lease = state.pool.acquire(state, t.reverse_port, account).await.with_context(|| format!("cannot log in to the device as {account}"))?;
    if let Ok(port) = u16::try_from(h.ssh_port) {
        if let Some(greeting) = ssh_greeting(&lease, ip, port).await {
            evidence.extend(os::ssh_evidence(&greeting));
        }
    }
    let smb = smb_port.or_else(|| ports.contains(&445).then_some(445));
    if let Some(port) = smb {
        if let Some(info) = smb_info(&lease, ip, port).await {
            evidence.push(os::smb_evidence(port, &info));
        }
    }
    drop(lease);
    evidence.extend(os::nmap_evidence(&answer.nmap_lines));

    let (family, name, confidence, conflict) = os::verdict(&evidence);
    Ok(OsCheck { family, name, confidence, evidence, conflict, nmap: answer.nmap, at: crate::util::now_db(), by: by.to_string() })
}
