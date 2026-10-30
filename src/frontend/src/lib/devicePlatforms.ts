/**
 * 裝置的作業系統與連線方式：建立頁的「支援的機器」、通道列表的 OS 圖示與 SSH / HTTP 標籤、搜尋的 `os:` / `via:`。
 * OS 從每天一次的裝置資訊（`facts.os` / `kernel` / `cpu_model`）判斷；連線方式是 gateway 記下的 `endpoint.transport`
 * （離線時 = 最後一次）。
 * Device platforms and how a device reaches Telepy: the create page's "supported devices", the tunnel list's OS icon
 * and SSH / HTTP badge, and the `os:` / `via:` search keys. The OS comes from the daily device facts, the way in from
 * the gateway's `endpoint.transport` (offline: the last connection).
 *
 * 純函式，`devicePlatforms.test.ts` 有測試。/ Pure; tested in devicePlatforms.test.ts.
 */
import type { DeviceFacts, TunnelEndpoint } from "../types/tunnel";

/** 有圖示的平台。`unix` = 其他 POSIX 系統（FreeBSD、NAS…）。/ Platforms with an icon; `unix` = other POSIX systems. */
export type PlatformId = "linux" | "macos" | "raspberrypi" | "openwrt" | "windows" | "docker" | "unix";

/**
 * 一行指令：`service` = 裝成開機服務（systemd / launchd / procd）；`loop` = 背景重連迴圈 + @reboot crontab；
 * `untested` = 照理可以（POSIX sh），沒測過；`no` = 只能逐步。
 * One command: a boot service, a background loop, should work but untested, or step by step only.
 */
export type JoinSupport = "service" | "loop" | "untested" | "no";

/** 逐步精靈裡適用的腳本（`wizard.connect.*` 的那六種）。/ The wizard scripts that fit. */
export type ScriptKind = "service" | "autossh" | "ssh" | "docker" | "compose" | "windows";

export interface Platform {
    id: PlatformId;
    join: JoinSupport;
    scripts: ScriptKind[];
    /** 可以走網頁 port（HTTP / WebSocket，需要 python3）。/ Can ride the web port (needs python3). */
    web: boolean;
}

/**
 * 支援的機器（順序 = 畫面順序）。一行指令的細節跟 `templates/join_install.sh` 一致：Linux 有 systemd 就裝服務、
 * 沒有（Alpine 等 BusyBox）就是背景迴圈；OpenWrt 用 procd，ssh 用 OpenSSH 或 Dropbear 的 dbclient（≥ 2016.73）。
 * Supported devices, in display order; the one-command details follow templates/join_install.sh.
 */
export const PLATFORMS: Platform[] = [
    { id: "linux", join: "service", scripts: ["service", "autossh", "ssh", "docker", "compose"], web: true },
    { id: "macos", join: "service", scripts: ["autossh", "ssh", "docker", "compose"], web: true },
    { id: "raspberrypi", join: "service", scripts: ["service", "autossh", "ssh", "docker", "compose"], web: true },
    { id: "openwrt", join: "service", scripts: [], web: false },
    { id: "windows", join: "no", scripts: ["windows"], web: false },
    { id: "docker", join: "no", scripts: ["docker", "compose"], web: false },
    { id: "unix", join: "untested", scripts: ["ssh", "autossh"], web: true },
];

const has = (s: string | null | undefined, ...words: string[]) => {
    const v = (s ?? "").toLowerCase();
    return words.some((w) => v.includes(w));
};

/**
 * 從裝置資訊判斷平台；什麼都沒讀到 = null。Raspberry Pi 看 OS 名稱或 CPU 型號（`/proc/cpuinfo` 的 Model）。
 * The platform from device facts; null when nothing was read.
 */
export function platformOf(facts?: DeviceFacts | null): PlatformId | null {
    if (!facts) return null;
    const { os, kernel, cpu_model: cpu } = facts;
    if (has(os, "windows") || has(kernel, "windows")) return "windows";
    if (has(os, "macos", "mac os", "os x") || has(kernel, "darwin")) return "macos";
    if (has(os, "openwrt", "lede")) return "openwrt";
    if (has(os, "raspbian", "raspberry") || has(cpu, "raspberry")) return "raspberrypi";
    if (has(kernel, "linux") || (os && !has(os, "bsd", "sunos", "solaris"))) return "linux";
    if (os || kernel) return "unix";
    return null;
}

/**
 * 卡片上的短名稱：「Ubuntu 24.04.1 LTS」→「Ubuntu 24.04」、「Microsoft Windows 11 Pro 10.0.22631」→「Windows 11 Pro」、
 * 「Debian GNU/Linux 12 (bookworm)」→「Debian 12」。完整字串放在 tooltip。
 * A short name for the chip; the full string goes into the tooltip.
 */
export function shortOs(os?: string | null): string | null {
    let s = (os ?? "").trim();
    if (!s) return null;
    s = s
        .replace(/^Microsoft\s+/i, "")
        .replace(/\s*\([^)]*\)/g, "")
        .replace(/\s+GNU\/Linux/i, "")
        .replace(/\s+LTS\b/i, "")
        .replace(/\s+\d+\.\d+\.\d{4,}$/, "") // Windows 的組建號 / Windows build number
        .replace(/\b(\d+\.\d+)\.\d+\b/, "$1") // 只留主.次版本 / major.minor only
        .replace(/\s{2,}/g, " ")
        .trim();
    return s.length > 28 ? `${s.slice(0, 27)}…` : s;
}

/** 裝置怎麼連 Telepy：`ssh` = SSH port、`http` = 網頁 port（SSH 包在 WebSocket 裡）；不知道 = null。 */
export type Via = "ssh" | "http";

/** How the device reaches Telepy; null when unknown (never connected, or connected before the upgrade). */
export function viaOf(endpoint?: TunnelEndpoint | null): Via | null {
    const t = endpoint?.transport;
    if (t === "tcp") return "ssh";
    if (t === "websocket") return "http";
    return null;
}

/** 搜尋 `os:` 接受的值（平台代號）。/ Values the `os:` search key accepts. */
export const OS_QUERY = new Set<string>(PLATFORMS.map((p) => p.id).filter((id) => id !== "docker"));
/** 搜尋 `via:` 接受的值。/ Values the `via:` search key accepts. */
export const VIA_QUERY = new Set<string>(["ssh", "http"]);

/** `os:linux` 也包含樹莓派（它就是 Linux）。/ `os:linux` includes Raspberry Pis, which run Linux. */
export function matchesOs(query: string, id: PlatformId | null): boolean {
    if (!id) return false;
    return query === id || (query === "linux" && id === "raspberrypi");
}
