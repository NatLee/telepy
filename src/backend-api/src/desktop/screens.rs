//! 裝置的螢幕配置（給 VNC 的「只看某一個螢幕」用）。
//!
//! VNC 伺服器把所有螢幕拼成一張大畫面送來（macOS 螢幕共享、x11vnc、TightVNC 都是），guacd 又沒有選螢幕的參數，
//! 所以「指定畫面」只能在瀏覽器裁切。要裁得對，得知道每個螢幕在那張大畫面裡的位置與大小 —— 這裡經裝置自己的
//! sshd（連線池、同一個跳板帳號）問裝置：
//! - Linux：`xrandr --listmonitors`（有位置）
//! - Windows：PowerShell `[System.Windows.Forms.Screen]::AllScreens`（有位置）
//! - macOS：`system_profiler SPDisplaysDataType -json`（只有大小、沒有位置；前端用整張畫面的大小推排列）
//! 只有「桌面就是裝置自己」時才有意義（區網主機沒有 SSH 可問）。解析器是純函式，有單元測試；偵測流程接受
//! 可注入的 exec（和 `ssh::resolve` 同一個做法）。
//! The device's monitor layout for the VNC "one screen only" crop. VNC servers send every monitor as one big
//! framebuffer and guacd has no monitor parameter, so the crop happens in the browser; this module asks the
//! device over SSH where each monitor sits. Pure parsers; the detection takes an injectable exec.

use std::future::Future;
use std::time::Duration;

use serde::Serialize;

use crate::tunnel_service::powershell_command;

pub const DETECT_TIMEOUT: Duration = Duration::from_secs(8);
/// `system_profiler` 慢（幾秒）。/ system_profiler takes seconds.
pub const LIST_TIMEOUT: Duration = Duration::from_secs(20);
pub const OUTPUT_LIMIT: usize = 256 * 1024;
pub const MAX_SCREENS: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Screen {
    pub name: String,
    /// 在整張畫面裡的位置；macOS 問不到 → None。/ Position in the framebuffer; None when unknown (macOS).
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Screens {
    /// `darwin` / `linux` / `windows` / `unknown`。
    pub os: &'static str,
    /// 用了哪個工具（None = 問不到）。/ Which tool answered (None = nothing did).
    pub source: Option<&'static str>,
    pub screens: Vec<Screen>,
}

/// `xrandr --listmonitors`：
/// ```text
/// Monitors: 2
///  0: +*eDP-1 1920/344x1080/194+0+0  eDP-1
///  1: +HDMI-1 2560/597x1440/336+1920+0  HDMI-1
/// ```
pub fn parse_xrandr(out: &str) -> Vec<Screen> {
    let mut screens = Vec::new();
    for line in out.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 3 || !tokens[0].ends_with(':') || !tokens[0][..tokens[0].len() - 1].chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let flags = tokens[1];
        let Some((w, h, x, y)) = parse_xrandr_geometry(tokens[2]) else { continue };
        let name = tokens.get(3).map(|s| s.to_string()).unwrap_or_else(|| flags.trim_start_matches(['+', '*']).to_string());
        screens.push(Screen { name, x: Some(x), y: Some(y), width: w, height: h, primary: flags.contains('*') });
        if screens.len() >= MAX_SCREENS {
            break;
        }
    }
    screens
}

/// `1920/344x1080/194+0+0` → (w, h, x, y)；位移可以是負的（`+-1920+0`）。/ xrandr geometry, offsets may be negative.
fn parse_xrandr_geometry(g: &str) -> Option<(u32, u32, i32, i32)> {
    let (w_part, rest) = g.split_once('x')?;
    let w: u32 = w_part.split('/').next()?.parse().ok()?;
    let mut parts = rest.split('+');
    let h: u32 = parts.next()?.split('/').next()?.parse().ok()?;
    let x: i32 = parts.next()?.parse().ok()?;
    let y: i32 = parts.next()?.parse().ok()?;
    if w == 0 || h == 0 {
        return None;
    }
    Some((w, h, x, y))
}

/// `system_profiler SPDisplaysDataType -json`：每張顯示卡的 `spdisplays_ndrvs` 裡一個顯示器一筆，
/// 解析度在 `_spdisplays_resolution`（邏輯大小，`1728 x 1117 @ 120.00Hz`）或 `spdisplays_resolution`；
/// 鏡像中的顯示器（`spdisplays_mirror` = on）在 VNC 畫面裡不會另外出現，略過。
/// Parses system_profiler's JSON: one entry per display, logical resolution, mirrored displays skipped.
pub fn parse_system_profiler(json: &str) -> Vec<Screen> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return Vec::new() };
    let mut screens = Vec::new();
    let gpus = v.get("SPDisplaysDataType").and_then(|g| g.as_array()).cloned().unwrap_or_default();
    for gpu in gpus {
        let displays = gpu.get("spdisplays_ndrvs").and_then(|d| d.as_array()).cloned().unwrap_or_default();
        for d in displays {
            let mirrored = d.get("spdisplays_mirror").and_then(|m| m.as_str()).map(|m| m.ends_with("_on")).unwrap_or(false);
            if mirrored {
                continue;
            }
            let res = ["_spdisplays_resolution", "spdisplays_resolution", "_spdisplays_pixels"].iter().find_map(|k| d.get(*k).and_then(|r| r.as_str()).and_then(parse_dimensions));
            let Some((width, height)) = res else { continue };
            let name = d.get("_name").and_then(|n| n.as_str()).unwrap_or("Display").to_string();
            let primary = d.get("spdisplays_main").and_then(|m| m.as_str()).map(|m| m.ends_with("_yes")).unwrap_or(false);
            screens.push(Screen { name, x: None, y: None, width, height, primary });
            if screens.len() >= MAX_SCREENS {
                return screens;
            }
        }
    }
    screens
}

/// `1728 x 1117 @ 120.00Hz` / `2560 x 1440 (QHD…)` → (1728, 1117)。/ The first `W x H` in a string.
fn parse_dimensions(s: &str) -> Option<(u32, u32)> {
    let (w, rest) = s.split_once('x')?;
    let w: u32 = w.trim().parse().ok()?;
    let h: u32 = rest.trim().split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()?;
    (w > 0 && h > 0).then_some((w, h))
}

/// PowerShell 腳本：每個螢幕一行 `TELEPY|\\.\DISPLAY1|0|0|1920|1080|True`。/ One line per screen.
pub const WINDOWS_SCRIPT: &str = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { 'TELEPY|' + $_.DeviceName + '|' + $_.Bounds.X + '|' + $_.Bounds.Y + '|' + $_.Bounds.Width + '|' + $_.Bounds.Height + '|' + $_.Primary }";

pub fn parse_powershell(out: &str) -> Vec<Screen> {
    let mut screens = Vec::new();
    for line in out.lines() {
        let Some(rest) = line.trim().strip_prefix("TELEPY|") else { continue };
        let f: Vec<&str> = rest.split('|').collect();
        if f.len() < 6 {
            continue;
        }
        let (Ok(x), Ok(y), Ok(w), Ok(h)) = (f[1].trim().parse::<i32>(), f[2].trim().parse::<i32>(), f[3].trim().parse::<u32>(), f[4].trim().parse::<u32>()) else { continue };
        if w == 0 || h == 0 {
            continue;
        }
        let name = f[0].trim().rsplit('\\').next().unwrap_or(f[0]).to_string();
        screens.push(Screen { name, x: Some(x), y: Some(y), width: w, height: h, primary: f[5].trim().eq_ignore_ascii_case("true") });
        if screens.len() >= MAX_SCREENS {
            break;
        }
    }
    screens
}

/// Linux：登入 shell 沒有 DISPLAY 時試 :0、:1。/ Try the session's DISPLAY, then :0 and :1.
pub const LINUX_COMMAND: &str = "for d in \"${DISPLAY:-:0}\" :0 :1; do out=$(DISPLAY=$d xrandr --listmonitors 2>/dev/null) && [ -n \"$out\" ] && { printf '%s\\n' \"$out\"; break; }; done; true";
pub const DARWIN_COMMAND: &str = "system_profiler SPDisplaysDataType -json 2>/dev/null";

/// 偵測流程：`uname -s` → Darwin / 其他 POSIX → 各自的清單指令；`uname` 不存在 → 試 PowerShell。
/// `run` 在裝置上跑一個指令，回 (exit code, stdout)。失敗一律當作「問不到」，不報錯。
/// Detection over an injectable exec: never an error, just an empty list when nothing answers.
pub async fn detect_with<F, Fut>(run: F) -> Screens
where
    F: Fn(String, Duration) -> Fut,
    Fut: Future<Output = anyhow::Result<(Option<u32>, String)>>,
{
    if let Ok((Some(0), out)) = run("uname -s".into(), DETECT_TIMEOUT).await {
        let os = out.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
        if os == "Darwin" {
            let screens = match run(DARWIN_COMMAND.into(), LIST_TIMEOUT).await {
                Ok((_, json)) => parse_system_profiler(&json),
                Err(_) => Vec::new(),
            };
            return Screens { os: "darwin", source: (!screens.is_empty()).then_some("system_profiler"), screens };
        }
        if !os.is_empty() && !os.contains(' ') {
            let screens = match run(LINUX_COMMAND.into(), LIST_TIMEOUT).await {
                Ok((_, out)) => parse_xrandr(&out),
                Err(_) => Vec::new(),
            };
            return Screens { os: "linux", source: (!screens.is_empty()).then_some("xrandr"), screens };
        }
    }
    match run(powershell_command(WINDOWS_SCRIPT), LIST_TIMEOUT).await {
        Ok((_, out)) if out.contains("TELEPY|") => {
            let screens = parse_powershell(&out);
            Screens { os: "windows", source: (!screens.is_empty()).then_some("powershell"), screens }
        }
        _ => Screens { os: "unknown", source: None, screens: Vec::new() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[test]
    fn xrandr_monitors_with_positions_and_primary() {
        let out = "Monitors: 2\n 0: +*eDP-1 1920/344x1080/194+0+0  eDP-1\n 1: +HDMI-1 2560/597x1440/336+1920+0  HDMI-1\n";
        let s = parse_xrandr(out);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0], Screen { name: "eDP-1".into(), x: Some(0), y: Some(0), width: 1920, height: 1080, primary: true });
        assert_eq!(s[1], Screen { name: "HDMI-1".into(), x: Some(1920), y: Some(0), width: 2560, height: 1440, primary: false });
        // 負位移、沒有尾端名稱。/ Negative offset, no trailing name.
        let s = parse_xrandr(" 0: +DP-2 1280/300x1024/200+-1280+0\n");
        assert_eq!((s[0].x, s[0].name.as_str()), (Some(-1280), "DP-2"));
        assert!(parse_xrandr("Can't open display :0\n").is_empty());
        assert!(parse_xrandr("Monitors: 0\n").is_empty());
    }

    #[test]
    fn system_profiler_displays_without_positions_skipping_mirrors() {
        let json = r#"{"SPDisplaysDataType":[{"_name":"Apple M2","spdisplays_ndrvs":[
            {"_name":"Color LCD","_spdisplays_pixels":"3456 x 2234","_spdisplays_resolution":"1728 x 1117 @ 120.00Hz","spdisplays_main":"spdisplays_yes","spdisplays_mirror":"spdisplays_off"},
            {"_name":"DELL U2720Q","spdisplays_resolution":"2560 x 1440 (QHD/WQHD - Wide Quad High Definition)","spdisplays_mirror":"spdisplays_off"},
            {"_name":"Mirror","_spdisplays_resolution":"1728 x 1117 @ 60.00Hz","spdisplays_mirror":"spdisplays_on"}
        ]}]}"#;
        let s = parse_system_profiler(json);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0], Screen { name: "Color LCD".into(), x: None, y: None, width: 1728, height: 1117, primary: true });
        assert_eq!(s[1], Screen { name: "DELL U2720Q".into(), x: None, y: None, width: 2560, height: 1440, primary: false });
        assert!(parse_system_profiler("not json").is_empty());
        assert!(parse_system_profiler(r#"{"SPDisplaysDataType":[]}"#).is_empty());
    }

    #[test]
    fn powershell_lines() {
        let out = "\r\nTELEPY|\\\\.\\DISPLAY1|0|0|1920|1080|True\r\nTELEPY|\\\\.\\DISPLAY2|1920|-200|2560|1440|False\r\nnoise\r\n";
        let s = parse_powershell(out);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0], Screen { name: "DISPLAY1".into(), x: Some(0), y: Some(0), width: 1920, height: 1080, primary: true });
        assert_eq!(s[1], Screen { name: "DISPLAY2".into(), x: Some(1920), y: Some(-200), width: 2560, height: 1440, primary: false });
        assert!(parse_powershell("TELEPY|x|a|b|c|d|e\n").is_empty());
    }

    fn fake(answers: Vec<(&'static str, Option<u32>, &'static str)>) -> (impl Fn(String, Duration) -> std::pin::Pin<Box<dyn Future<Output = anyhow::Result<(Option<u32>, String)>> + Send>>, std::sync::Arc<Mutex<Vec<String>>>) {
        let table: HashMap<&'static str, (Option<u32>, &'static str)> = answers.into_iter().map(|(k, c, o)| (k, (c, o))).collect();
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        let run = move |cmd: String, _t: Duration| {
            seen.lock().unwrap().push(cmd.clone());
            let hit = table.iter().find(|(k, _)| cmd.starts_with(*k)).map(|(_, v)| *v);
            Box::pin(async move {
                match hit {
                    Some((code, out)) => Ok((code, out.to_string())),
                    None => Ok((Some(127), String::new())),
                }
            }) as std::pin::Pin<Box<dyn Future<Output = anyhow::Result<(Option<u32>, String)>> + Send>>
        };
        (run, calls)
    }

    #[tokio::test]
    async fn detect_picks_the_tool_by_os() {
        let (run, calls) = fake(vec![("uname -s", Some(0), "Linux\n"), ("for d in", Some(0), "Monitors: 1\n 0: +*HDMI-1 1920/500x1080/300+0+0  HDMI-1\n")]);
        let s = detect_with(run).await;
        assert_eq!((s.os, s.source, s.screens.len()), ("linux", Some("xrandr"), 1));
        assert_eq!(calls.lock().unwrap().len(), 2);

        let (run, _) = fake(vec![("uname -s", Some(0), "Darwin\n"), ("system_profiler", Some(0), r#"{"SPDisplaysDataType":[{"spdisplays_ndrvs":[{"_name":"LCD","_spdisplays_resolution":"1440 x 900 @ 60Hz"}]}]}"#)]);
        let s = detect_with(run).await;
        assert_eq!((s.os, s.source), ("darwin", Some("system_profiler")));
        assert_eq!(s.screens[0].width, 1440);

        // 沒有 uname（Windows）→ PowerShell。/ No uname: PowerShell.
        let (run, calls) = fake(vec![("powershell", Some(0), "TELEPY|\\\\.\\DISPLAY1|0|0|1024|768|True\n")]);
        let s = detect_with(run).await;
        assert_eq!((s.os, s.source, s.screens.len()), ("windows", Some("powershell"), 1));
        assert!(calls.lock().unwrap()[1].starts_with("powershell -NoProfile"));

        // 什麼都沒有。/ Nothing answers.
        let (run, _) = fake(vec![]);
        let s = detect_with(run).await;
        assert_eq!((s.os, s.source, s.screens.len()), ("unknown", None, 0));

        // Linux 但 xrandr 失敗：os 知道、清單空。/ Linux without a usable xrandr.
        let (run, _) = fake(vec![("uname -s", Some(0), "Linux\n")]);
        let s = detect_with(run).await;
        assert_eq!((s.os, s.source, s.screens.len()), ("linux", None, 0));
    }
}
