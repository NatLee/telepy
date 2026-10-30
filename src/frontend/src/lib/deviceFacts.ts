/**
 * 裝置的基本狀況（後端 `device_facts`）：大小格式、用量、開機時間、下次什麼時候讀、門檻與警示。
 * 門檻跟後端一致（`device_facts.rs` 的常數）；畫面上的「警示」用後端存好的 `warnings`，這裡只算顯示用的狀態。
 * Device facts helpers: sizes, usage, boot time, when the next read is due, thresholds and warnings. The thresholds
 * mirror `device_facts.rs`; the warnings shown are the ones the backend stored, this only derives display state.
 *
 * 純函式，`deviceFacts.test.ts` 有測試。/ Pure; tested in deviceFacts.test.ts.
 */
import type { DeviceFacts, DeviceWarningKind, TunnelEndpoint } from "../types/tunnel";

export const WARNING_KINDS: DeviceWarningKind[] = ["disk", "memory", "load", "reboot"];

/** 跟後端一樣的門檻（磁碟的絕對下限最多是整顆的一半，見 `device_facts::disk_floor_kb`）。/ The backend's thresholds (the disk floor is at most half the disk). */
export const THRESHOLDS = {
    diskMinFreePct: 10,
    diskMinFreeKb: 2 * 1024 * 1024,
    memMinAvailPct: 10,
    loadPerCpu: 2,
} as const;

/** 腳本每天跑一次（連著的時候）。/ The script runs daily while the device is connected. */
export const PROBE_EVERY_MS = 24 * 3600 * 1000;

/** 「立即重新整理」的冷卻。/ "Refresh now" cool-down. */
export const REFRESH_COOLDOWN_MS = 60 * 1000;

/**
 * 實際跑的指令（跟 `device_facts.rs` / `device_info.rs` 的腳本一致；改腳本時一起改）。
 * The commands that actually run (keep in sync with the backend scripts).
 */
export const COMMANDS_POSIX = [
    "hostname",
    "ip -o -4 addr show scope global || ifconfig",
    "uname -sr; uname -m",
    "cat /etc/os-release  ·  sw_vers",
    "cat /proc/uptime  ·  sysctl -n kern.boottime",
    "cat /proc/cpuinfo; lscpu; nproc  ·  sysctl -n machdep.cpu.brand_string hw.ncpu",
    "cat /proc/meminfo  ·  sysctl -n hw.memsize; vm_stat",
    "cat /proc/loadavg  ·  sysctl -n vm.loadavg",
    "df -Pk /",
    "ssh -V",
    "test -f /var/run/reboot-required",
] as const;

export const COMMANDS_WINDOWS = [
    "hostname",
    "Get-NetIPAddress -AddressFamily IPv4",
    "Get-CimInstance Win32_OperatingSystem",
    "Get-CimInstance Win32_Processor",
    "Get-PSDrive C",
    "ssh -V",
] as const;

/** 「1.2 GB」（KB 為單位，跟後端的 `fmt_kb` 一樣）。/ A human size from kilobytes, like the backend's `fmt_kb`. */
export function fmtKb(kb: number): string {
    const units = ["KB", "MB", "GB", "TB", "PB"];
    let v = kb;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i += 1;
    }
    return v >= 100 || i === 0 ? `${Math.round(v)} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`;
}

export interface Usage {
    totalKb: number;
    availKb: number;
    usedKb: number;
    /** 0..100，用掉的比例。/ Percentage used. */
    usedPct: number;
    freePct: number;
}

/** 總量與剩下的 → 用量；缺一個就 null。/ Total and available → usage; null when either is missing. */
export function usage(total?: number | null, avail?: number | null): Usage | null {
    if (total == null || avail == null || total <= 0) return null;
    const a = Math.min(Math.max(avail, 0), total);
    const freePct = (a / total) * 100;
    return { totalKb: total, availKb: a, usedKb: total - a, usedPct: 100 - freePct, freePct };
}

/** 存好的警示裡認得的種類。/ Known warning kinds among the stored warnings. */
export function warningKinds(endpoint?: TunnelEndpoint | null): DeviceWarningKind[] {
    const ws = endpoint?.facts?.warnings ?? [];
    return WARNING_KINDS.filter((k) => ws.some((w) => w.kind === k));
}

/** 什麼時候開機的（ms）：讀的時間減掉當時開機了多久。/ Boot time: when read minus the uptime then. */
export function bootAt(facts?: DeviceFacts | null, factsAt?: string | null): number | null {
    if (facts?.uptime_s == null || !factsAt) return null;
    const at = Date.parse(factsAt);
    return Number.isNaN(at) ? null : at - facts.uptime_s * 1000;
}

export type NextProbe = { kind: "at"; at: number } | { kind: "soon" } | { kind: "reconnect" } | { kind: "never" };

/**
 * 下一次讀：連著時是上次 + 24 小時（已經過了 / 從沒讀過 = 很快）；離線時是「下次連上」；沒有紀錄 = 從沒連過。
 * Next read: last + 24 h while connected (overdue / never read = soon); "when it reconnects" while offline.
 */
export function nextProbe(endpoint: TunnelEndpoint | null | undefined, now: number): NextProbe {
    if (!endpoint) return { kind: "never" };
    if (!endpoint.live) return { kind: "reconnect" };
    const last = endpoint.probed_at ? Date.parse(endpoint.probed_at) : NaN;
    if (Number.isNaN(last)) return { kind: "soon" };
    // 這次連線還沒問過：連上後 30 秒內就會問。/ Not asked during this connection yet: within 30 s of connecting.
    const connected = Date.parse(endpoint.connected_at);
    if (!Number.isNaN(connected) && last < connected) return { kind: "soon" };
    const at = last + PROBE_EVERY_MS;
    return at <= now ? { kind: "soon" } : { kind: "at", at };
}

/** 還要等幾秒才能再按「立即重新整理」（0 = 可以）。/ Seconds until "Refresh now" is allowed again. */
export function refreshWait(lastRefresh: number | null, now: number): number {
    if (lastRefresh == null) return 0;
    return Math.max(0, Math.ceil((lastRefresh + REFRESH_COOLDOWN_MS - now) / 1000));
}

export type ThresholdState = "ok" | "warn" | "unknown";

export interface ThresholdRow {
    kind: DeviceWarningKind;
    state: ThresholdState;
    /** disk / memory：剩下的比例；load：1 分鐘負載；reboot：null。/ disk / memory: free %; load: load1. */
    value: number | null;
    /** disk / memory：剩下多少（KB）；load：CPU 數。/ disk / memory: free KB; load: CPU count. */
    extra: number | null;
}

/**
 * 每個門檻現在的狀態（資訊視窗的表格）：有存好的警示 = warn，讀得到數字 = ok，不然 unknown。
 * Each threshold's state for the info dialog: a stored warning = warn, a known value = ok, else unknown.
 */
export function thresholdRows(facts?: DeviceFacts | null): ThresholdRow[] {
    const warned = new Set((facts?.warnings ?? []).map((w) => w.kind));
    const state = (kind: DeviceWarningKind, known: boolean): ThresholdState => (warned.has(kind) ? "warn" : known ? "ok" : "unknown");
    const disk = usage(facts?.disk_total_kb, facts?.disk_avail_kb);
    const mem = usage(facts?.mem_total_kb, facts?.mem_avail_kb);
    const load1 = facts?.load?.[0] ?? null;
    return [
        { kind: "disk", state: state("disk", !!disk), value: disk ? disk.freePct : null, extra: disk ? disk.availKb : null },
        { kind: "memory", state: state("memory", !!mem), value: mem ? mem.freePct : null, extra: mem ? mem.availKb : null },
        { kind: "load", state: state("load", load1 != null && facts?.cpus != null), value: load1, extra: facts?.cpus ?? null },
        { kind: "reboot", state: state("reboot", facts?.reboot_required != null), value: null, extra: null },
    ];
}

/** 秒數 → 「3d 4h」「5h 12m」「8m」（單位不翻譯，跟其他地方的時長一樣）。/ A compact duration. */
export function fmtUptime(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
}
