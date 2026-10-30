//! 裝置的基本狀況（OS、kernel、架構、開機多久、CPU、記憶體、根磁碟、負載、ssh 版本、要不要重開機）。
//! 不另外登入、不另開迴圈：跟 `device_info` 每天那一次唯讀腳本一起跑（多一段指令），每個指令都可有可無、
//! 有 `timeout` 時限 1 秒。輸出是 `KEY=value` 行，由純函式 [`parse_facts`] 解析；門檻 → [`warnings`]。
//! Device facts (OS, kernel, arch, uptime, CPU, memory, root disk, load, ssh version, pending reboot), collected by
//! the same daily read-only script `device_info` already runs — no extra login, no extra loop. Every command is
//! optional (1 s each where `timeout` exists); the output is `KEY=value` lines parsed by the pure [`parse_facts`],
//! and thresholds become [`warnings`].

use serde::{Deserialize, Serialize};

/// 磁碟剩不到這個比例（%）或 [`DISK_MIN_FREE_KB`] 就警示。/ Warn when the root disk has less than this % free…
pub const DISK_MIN_FREE_PCT: u64 = 10;
/// …或剩不到 2 GB（但不超過整顆的一半：路由器 100 MB 的根目錄永遠不到 2 GB，只看比例）。
/// …or less than 2 GB — capped at half the disk, so a router's 100 MB root is judged by the percentage alone.
pub const DISK_MIN_FREE_KB: u64 = 2 * 1024 * 1024;

/// 這顆磁碟的絕對下限：2 GB，小磁碟最多一半。/ The absolute floor for this disk: 2 GB, at most half of a small one.
pub fn disk_floor_kb(total_kb: u64) -> u64 {
    DISK_MIN_FREE_KB.min(total_kb / 2)
}
/// 可用記憶體不到這個比例（%）。/ Warn when less than this % of memory is available.
pub const MEM_MIN_AVAIL_PCT: u64 = 10;
/// 1 分鐘負載超過 CPU 數的幾倍。/ Warn when the 1-minute load exceeds this many times the CPU count.
pub const LOAD_PER_CPU: f64 = 2.0;

/// 警示種類（畫面、搜尋 `warn:`、webhook 都用這幾個字）。/ Warning kinds (UI, `warn:` search, webhook).
pub const KINDS: &[&str] = &["disk", "memory", "load", "reboot"];

const MAX_TEXT: usize = 160;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Facts {
    /// 「Debian GNU/Linux 12 (bookworm)」「macOS 15.1」「Microsoft Windows 11 Pro 10.0.26100」
    pub os: Option<String>,
    /// `uname -sr`（Windows：版本號）。/ `uname -sr` (Windows: the version).
    pub kernel: Option<String>,
    pub arch: Option<String>,
    /// 問的當下已經開機幾秒。/ Seconds since boot when asked.
    pub uptime_s: Option<u64>,
    pub cpu_model: Option<String>,
    pub cpus: Option<u32>,
    pub mem_total_kb: Option<u64>,
    pub mem_avail_kb: Option<u64>,
    /// 根目錄（Windows：C:）。/ The root file system (Windows: C:).
    pub disk_total_kb: Option<u64>,
    pub disk_avail_kb: Option<u64>,
    /// 1 / 5 / 15 分鐘負載（Windows 沒有）。/ 1 / 5 / 15-minute load average (none on Windows).
    pub load: Option<[f64; 3]>,
    /// `ssh -V`
    pub ssh: Option<String>,
    /// 只有 Debian 家族知道（`/var/run/reboot-required`）；其他系統 null。/ Debian family only; null elsewhere.
    pub reboot_required: Option<bool>,
    /// 存的時候算好的警示。/ Warnings, computed when stored.
    #[serde(default)]
    pub warnings: Vec<Warning>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Warning {
    /// disk / memory / load / reboot
    pub kind: String,
    /// 英文一句話（Logs、MCP）。/ One English sentence (Logs, MCP).
    pub detail: String,
}

impl Facts {
    pub fn is_empty(&self) -> bool {
        let Facts { os, kernel, arch, uptime_s, cpu_model, cpus, mem_total_kb, mem_avail_kb, disk_total_kb, disk_avail_kb, load, ssh, reboot_required, warnings: _ } = self;
        os.is_none()
            && kernel.is_none()
            && arch.is_none()
            && uptime_s.is_none()
            && cpu_model.is_none()
            && cpus.is_none()
            && mem_total_kb.is_none()
            && mem_avail_kb.is_none()
            && disk_total_kb.is_none()
            && disk_avail_kb.is_none()
            && load.is_none()
            && ssh.is_none()
            && reboot_required.is_none()
    }
}

/// 一段可讀文字：去掉控制字元、引號、頭尾空白，太長就截斷；空的是 None。/ Clean one text value.
fn text(v: &str) -> Option<String> {
    let cleaned: String = v.chars().filter(|c| !c.is_control()).collect();
    let cleaned = cleaned.trim().trim_matches('"').trim();
    if cleaned.is_empty() {
        return None;
    }
    Some(cleaned.chars().take(MAX_TEXT).collect())
}

/// `ssh -V` 的版本行（不是「ssh: not found」之類的錯誤）。/ A version line, not an error message.
fn looks_like_ssh_version(s: &str) -> bool {
    s.contains("OpenSSH") || s.contains("SSH_") || s.to_ascii_lowercase().contains("dropbear")
}

fn number(v: &str) -> Option<f64> {
    v.trim().trim_end_matches('.').parse::<f64>().ok().filter(|n| n.is_finite() && *n >= 0.0)
}

fn int(v: &str) -> Option<u64> {
    number(v).map(|n| n as u64)
}

/// `{ 1.23 1.45 1.67 }`（macOS）或 `1.23 1.45 1.67`（/proc/loadavg）。/ Both load formats.
fn load(v: &str) -> Option<[f64; 3]> {
    let nums: Vec<f64> = v.trim().trim_start_matches('{').trim_end_matches('}').split_whitespace().filter_map(number).collect();
    (nums.len() >= 3).then(|| [nums[0], nums[1], nums[2]])
}

/// macOS `sysctl -n kern.boottime`：`{ sec = 1729900000, usec = 1 } Sat Oct 26 …`。
fn boot_sec(v: &str) -> Option<u64> {
    let rest = v.split("sec =").nth(1)?;
    int(rest.split(',').next()?)
}

/// 解析腳本輸出的 `KEY=value` 行（不認得的鍵略過；同一個鍵後面的蓋前面的）。
/// Parse the script's `KEY=value` lines; unknown keys are ignored, later lines win.
pub fn parse_facts(out: &str) -> Facts {
    let mut f = Facts::default();
    let (mut now, mut boottime) = (None, None);
    for line in out.lines() {
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim();
        match key.trim() {
            "os" => f.os = text(value).or(f.os),
            "kernel" => f.kernel = text(value).or(f.kernel),
            "arch" => f.arch = text(value).or(f.arch),
            "uptime" => f.uptime_s = int(value).or(f.uptime_s),
            "now" => now = int(value),
            "boottime" => boottime = boot_sec(value),
            "cpu_model" => f.cpu_model = text(value).filter(|m| m != "-").or(f.cpu_model),
            "cpus" => f.cpus = int(value).and_then(|n| u32::try_from(n).ok()).filter(|n| *n > 0).or(f.cpus),
            "mem_total_kb" => f.mem_total_kb = int(value).filter(|n| *n > 0).or(f.mem_total_kb),
            "mem_total_b" => f.mem_total_kb = int(value).filter(|n| *n > 0).map(|b| b / 1024).or(f.mem_total_kb),
            "mem_avail_kb" => f.mem_avail_kb = int(value).or(f.mem_avail_kb),
            "disk_total_kb" => f.disk_total_kb = int(value).filter(|n| *n > 0).or(f.disk_total_kb),
            "disk_avail_kb" => f.disk_avail_kb = int(value).or(f.disk_avail_kb),
            "load" => f.load = load(value).or(f.load),
            "ssh" => f.ssh = text(value).filter(|s| looks_like_ssh_version(s)).or(f.ssh),
            "reboot" => f.reboot_required = match value {
                "1" => Some(true),
                "0" => Some(false),
                _ => f.reboot_required,
            },
            _ => {}
        }
    }
    if f.uptime_s.is_none() {
        if let (Some(now), Some(boot)) = (now, boottime) {
            f.uptime_s = now.checked_sub(boot);
        }
    }
    // 沒有 /etc/os-release 的系統：OS 就寫 kernel。/ No os-release: the kernel names the OS.
    if f.os.is_none() {
        f.os = f.kernel.clone();
    }
    f.warnings = warnings(&f);
    f
}

/// 人看的大小（KB → 「1.2 GB」）。/ A human size from kilobytes.
pub fn fmt_kb(kb: u64) -> String {
    let units = ["KB", "MB", "GB", "TB", "PB"];
    let mut v = kb as f64;
    let mut i = 0;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if v >= 100.0 || i == 0 {
        format!("{:.0} {}", v, units[i])
    } else {
        format!("{:.1} {}", v, units[i])
    }
}

fn pct(part: u64, whole: u64) -> u64 {
    part.saturating_mul(100).checked_div(whole).unwrap_or(0)
}

/// 門檻 → 警示（純函式）：磁碟剩不到 10 % 或 2 GB（小磁碟：一半）、可用記憶體不到 10 %、1 分鐘負載超過 CPU 數兩倍、等著重開機。
/// Thresholds → warnings: disk < 10 % or < 2 GB free (small disks: half), memory < 10 % available, load1 > 2 × CPUs, reboot pending.
pub fn warnings(f: &Facts) -> Vec<Warning> {
    let mut out = Vec::new();
    if let (Some(total), Some(avail)) = (f.disk_total_kb, f.disk_avail_kb) {
        if total > 0 && (avail.saturating_mul(100) < total.saturating_mul(DISK_MIN_FREE_PCT) || avail < disk_floor_kb(total)) {
            out.push(Warning { kind: "disk".into(), detail: format!("root disk: {} free of {} ({}%)", fmt_kb(avail), fmt_kb(total), pct(avail, total)) });
        }
    }
    if let (Some(total), Some(avail)) = (f.mem_total_kb, f.mem_avail_kb) {
        if total > 0 && avail.saturating_mul(100) < total.saturating_mul(MEM_MIN_AVAIL_PCT) {
            out.push(Warning { kind: "memory".into(), detail: format!("memory: {} available of {} ({}%)", fmt_kb(avail), fmt_kb(total), pct(avail, total)) });
        }
    }
    if let (Some([l1, _, _]), Some(cpus)) = (f.load, f.cpus) {
        if l1 > LOAD_PER_CPU * f64::from(cpus) {
            out.push(Warning { kind: "load".into(), detail: format!("load average {l1:.2} on {cpus} CPUs") });
        }
    }
    if f.reboot_required == Some(true) {
        out.push(Warning { kind: "reboot".into(), detail: "a reboot is required to finish installing updates".into() });
    }
    out
}

/// POSIX 那段（接在 `device_info` 的腳本後面，同一個 `sh -c`）。每個指令都可有可無，錯誤丟掉；有 `timeout` 就限 1 秒。
/// The POSIX part, appended to `device_info`'s script (same `sh -c`). Every command is optional; 1 s each with `timeout`.
/// 畫面的資訊視窗列出這些指令（`lib/deviceFacts.ts` 的 COMMANDS_*）；改腳本時一起改。/ The info dialog lists them (`lib/deviceFacts.ts`); keep in sync.
pub const POSIX_SCRIPT: &str = r#"if timeout 1 true >/dev/null 2>&1; then t() { timeout 1 "$@"; }; else t() { "$@"; }; fi
echo "now=$(date +%s)"
echo "kernel=$(uname -sr 2>/dev/null)"
echo "arch=$(uname -m 2>/dev/null)"
if [ "$(uname -s 2>/dev/null)" = Darwin ]; then
echo "os=$(t sw_vers -productName 2>/dev/null) $(t sw_vers -productVersion 2>/dev/null)"
echo "boottime=$(t sysctl -n kern.boottime 2>/dev/null)"
echo "cpu_model=$(t sysctl -n machdep.cpu.brand_string 2>/dev/null)"
echo "cpus=$(t sysctl -n hw.ncpu 2>/dev/null)"
echo "mem_total_b=$(t sysctl -n hw.memsize 2>/dev/null)"
t vm_stat 2>/dev/null | awk '/page size of/ {p=$8} /Pages free/ {f=$3} /Pages inactive/ {i=$3} /Pages speculative/ {s=$3} END {if (p>0) printf "mem_avail_kb=%d\n", (f+i+s)*p/1024}'
echo "load=$(t sysctl -n vm.loadavg 2>/dev/null)"
else
[ -r /etc/os-release ] && echo "os=$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | tr -d '"')"
[ -r /proc/uptime ] && echo "uptime=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"
m=$(grep -m1 -E '^(model name|Model|Hardware|cpu model)' /proc/cpuinfo 2>/dev/null | cut -d: -f2-)
[ -z "$m" ] && m=$(t lscpu 2>/dev/null | sed -n 's/^Model name:[[:space:]]*//p' | head -n 1)
echo "cpu_model=$m"
echo "cpus=$(t nproc 2>/dev/null || t getconf _NPROCESSORS_ONLN 2>/dev/null)"
[ -r /proc/meminfo ] && awk '/^MemTotal:/ {print "mem_total_kb=" $2} /^MemAvailable:/ {print "mem_avail_kb=" $2}' /proc/meminfo 2>/dev/null
[ -r /proc/loadavg ] && echo "load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
if [ -f /etc/debian_version ]; then if [ -f /var/run/reboot-required ]; then echo reboot=1; else echo reboot=0; fi; fi
fi
t df -Pk / 2>/dev/null | awk 'NR==2 {print "disk_total_kb=" $2; print "disk_avail_kb=" $4}'
echo "ssh=$(t ssh -V 2>&1 | head -n 1)"
true"#;

/// PowerShell 那段（放在 `-Command "…"` 裡：不能有雙引號、`%`）。/ The PowerShell part (inside `-Command "…"`: no `"` or `%`).
pub const WINDOWS_SCRIPT: &str = "$o = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue; \
if ($o) { 'os=' + $o.Caption + ' ' + $o.Version; 'kernel=Windows ' + $o.Version; 'uptime=' + [int64]((Get-Date) - $o.LastBootUpTime).TotalSeconds; 'mem_total_kb=' + $o.TotalVisibleMemorySize; 'mem_avail_kb=' + $o.FreePhysicalMemory }; \
'arch=' + $env:PROCESSOR_ARCHITECTURE; \
$c = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { 'cpu_model=' + $c.Name }; \
'cpus=' + $env:NUMBER_OF_PROCESSORS; \
$d = Get-PSDrive C -ErrorAction SilentlyContinue; if ($d) { 'disk_total_kb=' + [int64](($d.Used + $d.Free) / 1024); 'disk_avail_kb=' + [int64]($d.Free / 1024) }; \
try { 'ssh=' + (ssh -V 2>&1 | Select-Object -First 1) } catch {}";

#[cfg(test)]
mod tests {
    use super::*;

    const LINUX: &str = "now=1761500000\nkernel=Linux 6.1.0-26-amd64\narch=x86_64\nos=Debian GNU/Linux 12 (bookworm)\nuptime=360123.45\n\
cpu_model= Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz\ncpus=8\nmem_total_kb=16318412\nmem_avail_kb=9123456\nload=0.52 0.48 0.40\nreboot=1\n\
disk_total_kb=244568380\ndisk_avail_kb=180000000\nssh=OpenSSH_9.2p1 Debian-2+deb12u3, OpenSSL 3.0.14 4 Jun 2024\n";

    #[test]
    fn parses_linux() {
        let f = parse_facts(LINUX);
        assert_eq!(f.os.as_deref(), Some("Debian GNU/Linux 12 (bookworm)"));
        assert_eq!(f.kernel.as_deref(), Some("Linux 6.1.0-26-amd64"));
        assert_eq!(f.arch.as_deref(), Some("x86_64"));
        assert_eq!(f.uptime_s, Some(360123));
        assert_eq!(f.cpu_model.as_deref(), Some("Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz"));
        assert_eq!(f.cpus, Some(8));
        assert_eq!((f.mem_total_kb, f.mem_avail_kb), (Some(16318412), Some(9123456)));
        assert_eq!((f.disk_total_kb, f.disk_avail_kb), (Some(244568380), Some(180000000)));
        assert_eq!(f.load, Some([0.52, 0.48, 0.40]));
        assert!(f.ssh.as_deref().unwrap().starts_with("OpenSSH_9.2p1"));
        assert_eq!(f.reboot_required, Some(true));
        assert_eq!(f.warnings.iter().map(|w| w.kind.as_str()).collect::<Vec<_>>(), vec!["reboot"]);
    }

    #[test]
    fn parses_macos() {
        let out = "now=1761500000\nkernel=Darwin 24.1.0\narch=arm64\nos=macOS 15.1\nboottime={ sec = 1761400000, usec = 431201 } Sat Oct 25 10:00:00 2026\n\
cpu_model=Apple M2\ncpus=8\nmem_total_b=17179869184\nmem_avail_kb=6291456\nload={ 1.91 2.10 2.31 }\n\
disk_total_kb=482797652\ndisk_avail_kb=1500000\nssh=OpenSSH_9.8p1, LibreSSL 3.3.6\n";
        let f = parse_facts(out);
        assert_eq!(f.os.as_deref(), Some("macOS 15.1"));
        assert_eq!(f.uptime_s, Some(100000), "now − boottime");
        assert_eq!(f.mem_total_kb, Some(16 * 1024 * 1024), "bytes → KB");
        assert_eq!(f.load, Some([1.91, 2.10, 2.31]));
        assert_eq!(f.reboot_required, None, "not a Debian system");
        // 1.4 GB 剩下：低於 2 GB。/ 1.4 GB free: under 2 GB.
        assert_eq!(f.warnings.iter().map(|w| w.kind.as_str()).collect::<Vec<_>>(), vec!["disk"]);
        assert!(f.warnings[0].detail.contains("free of"), "{:?}", f.warnings);
    }

    #[test]
    fn parses_windows() {
        let out = "os=Microsoft Windows 11 Pro 10.0.26100\r\nkernel=Windows 10.0.26100\r\nuptime=86400\r\nmem_total_kb=33480000\r\nmem_avail_kb=2000000\r\n\
arch=AMD64\r\ncpu_model=AMD Ryzen 7 5800X 8-Core Processor            \r\ncpus=16\r\ndisk_total_kb=999000000\r\ndisk_avail_kb=500000000\r\n\
ssh=OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2\r\n";
        let f = parse_facts(out);
        assert_eq!(f.os.as_deref(), Some("Microsoft Windows 11 Pro 10.0.26100"));
        assert_eq!(f.cpu_model.as_deref(), Some("AMD Ryzen 7 5800X 8-Core Processor"), "trailing padding trimmed");
        assert_eq!(f.uptime_s, Some(86400));
        assert_eq!(f.load, None, "no load average on Windows");
        assert_eq!(f.warnings.iter().map(|w| w.kind.as_str()).collect::<Vec<_>>(), vec!["memory"], "2 GB of 32 GB available");
    }

    #[test]
    fn missing_commands_leave_gaps() {
        // busybox：沒有 os-release、沒有 nproc、ssh 不在（「sh: ssh: not found」不是版本）。
        // A busybox box: no os-release, no nproc, no ssh client.
        let f = parse_facts("now=1\nkernel=Linux 5.10.0\narch=armv7l\ncpus=\ncpu_model=-\nssh=sh: ssh: not found\nload=garbage\n");
        assert_eq!(f.os.as_deref(), Some("Linux 5.10.0"), "falls back to the kernel");
        assert_eq!((f.cpus, f.ssh.as_deref(), f.load, f.cpu_model.as_deref()), (None, None, None, None));
        assert!(f.warnings.is_empty());
        assert!(parse_facts("").is_empty());
        assert!(parse_facts("nonsense\nfoo=bar\n").is_empty());
    }

    #[test]
    fn thresholds() {
        let base = Facts { cpus: Some(4), load: Some([7.9, 1.0, 1.0]), disk_total_kb: Some(100 * 1024 * 1024), disk_avail_kb: Some(11 * 1024 * 1024), mem_total_kb: Some(1000), mem_avail_kb: Some(100), ..Default::default() };
        assert!(warnings(&base).is_empty(), "load 7.9 ≤ 8, disk 11 %, memory exactly 10 %");
        let f = Facts { load: Some([8.1, 1.0, 1.0]), disk_avail_kb: Some(9 * 1024 * 1024), mem_avail_kb: Some(99), reboot_required: Some(true), ..base.clone() };
        let kinds: Vec<String> = warnings(&f).into_iter().map(|w| w.kind).collect();
        assert_eq!(kinds, vec!["disk", "memory", "load", "reboot"]);
        // 小磁碟：比例沒問題但剩不到 2 GB（3 GB 的一半是 1.5 GB）。/ A small disk: fine by percentage, but under its floor.
        let small = Facts { disk_total_kb: Some(3 * 1024 * 1024), disk_avail_kb: Some(1400 * 1024), ..Default::default() };
        assert_eq!(warnings(&small)[0].kind, "disk");
        assert!(warnings(&Facts { disk_avail_kb: Some(1900 * 1024), ..small.clone() }).is_empty(), "1.9 GB free of 3 GB is fine");
        // 路由器（GL-AR750S）：98 MB 的根目錄剩 91 MB 沒事，剩 8 MB 才警示。/ A router's 98 MB root: 91 MB free is fine, 8 MB is not.
        let router = Facts { disk_total_kb: Some(98 * 1024), disk_avail_kb: Some(91 * 1024), ..Default::default() };
        assert!(warnings(&router).is_empty(), "{:?}", warnings(&router));
        assert_eq!(warnings(&Facts { disk_avail_kb: Some(8 * 1024), ..router })[0].kind, "disk");
        assert_eq!(disk_floor_kb(500 * 1024 * 1024), DISK_MIN_FREE_KB);
        assert_eq!(fmt_kb(1900 * 1024), "1.9 GB");
        assert_eq!(fmt_kb(512), "512 KB");
        assert_eq!(fmt_kb(250 * 1024 * 1024), "250 GB");
    }

    #[test]
    fn stored_json_round_trips() {
        let f = parse_facts(LINUX);
        let s = serde_json::to_string(&f).unwrap();
        assert!(s.contains("\"warnings\":[{\"kind\":\"reboot\""), "{s}");
        assert_eq!(serde_json::from_str::<Facts>(&s).unwrap(), f);
        // 舊的 JSON 沒有 warnings 也讀得進來。/ Older JSON without warnings still reads.
        assert_eq!(serde_json::from_str::<Facts>(r#"{"os":"x"}"#).unwrap().os.as_deref(), Some("x"));
    }

    #[test]
    fn scripts_are_safe_to_embed() {
        assert!(!WINDOWS_SCRIPT.contains('"') && !WINDOWS_SCRIPT.contains('%'), "goes inside cmd.exe's -Command \"…\"");
        assert!(!POSIX_SCRIPT.contains("$$"));
    }
}
