/**
 * 裝置的作業系統與連線方式：建立頁的「支援的機器」、通道列表的 OS 圖示與「SSH / SSH over WSS」標籤、搜尋的 `os:` / `via:`。
 * OS 從每天一次的裝置資訊（`facts.os` / `kernel` / `cpu_model`）判斷；連線方式是列表的 `way_in`（加進來時設定的方式 +
 * gateway 記下的實際方式，離線時 = 最後一次）。
 * Device platforms and how a device reaches Telepy: the create page's "supported devices", the tunnel list's OS icon
 * and "SSH / SSH over WSS" badge, and the `os:` / `via:` search keys. The OS comes from the daily device facts, the way
 * in from the list's `way_in` (how it was set up plus the way the gateway saw it come in; offline: the last time).
 *
 * 純函式，`devicePlatforms.test.ts` 有測試。/ Pure; tested in devicePlatforms.test.ts.
 */
import type { DeviceFacts, Tunnel, TunnelWayIn } from "../types/tunnel";

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

/**
 * 裝置怎麼連 Telepy：`ssh` = SSH port；`wss` = 網頁 port，SSH 包在有 TLS 的 WebSocket 裡；`ws` = 同樣但沒有 TLS
 * （Telepy 走 http 時）。
 * How the device reaches Telepy: `ssh` = the SSH port; `wss` = the web port, SSH inside a WebSocket with TLS; `ws` =
 * the same without TLS (Telepy served over http).
 */
export type Via = "ssh" | "wss" | "ws";

/**
 * `live` = 現在連著；`last` = 離線，最後一次用的方式；`setup` = 加進來時設定的方式，之後還沒連上過。
 * `live` = connected now; `last` = offline, the way it last came in; `setup` = how it was set up, not connected since.
 */
export type WayInState = "live" | "last" | "setup";

export interface WayIn {
    via: Via;
    state: WayInState;
    /**
     * 實際走的跟加進來時設定的不同（例如之後切換過，或自動改走網頁 port）：設定的那種；一樣或不知道 = null。
     * When the way it actually came in differs from how it was set up (switched later, or fell back to the web port):
     * the set-up way; null when they match or the set-up way is unknown.
     */
    setup: Via | null;
    /** 設定成自動（SSH port 優先，被擋時自己改走網頁 port）：走哪種都不算「跟設定不同」。
     *  Set up as automatic (the SSH port first, the web port by itself when blocked): either way matches the setup. */
    auto: boolean;
}

type Carrier = "ssh" | "websocket";
const carrier = (v: unknown): Carrier | null => (v === "ssh" || v === "websocket" ? v : null);
/** websocket 的 TLS 不知道時（還沒用那種方式連過）照 Telepy 自己是不是 https 猜。/ Unknown TLS: guess from Telepy's own scheme. */
const viaFor = (c: Carrier, tls: boolean | null | undefined, https: boolean): Via => (c === "ssh" ? "ssh" : (tls ?? https) ? "wss" : "ws");

/**
 * 卡片 / 列表上的「SSH / SSH over WSS」：有連線紀錄就用實際的（連著 = 現在的、離線 = 最後一次），從沒連過用加進來時設定的；
 * 都不知道 = null。舊的後端沒有 `way_in` 時退回 `endpoint.transport`。`https` = Telepy 本身是不是 https。
 * The card / row badge: the actual way when there is a connection on record (now, or the last one), else how it was
 * set up; null when neither is known. Falls back to `endpoint.transport` for an older backend without `way_in`.
 */
export function wayInOf(t: Pick<Tunnel, "way_in" | "endpoint"> | null | undefined, https = true): WayIn | null {
    if (!t) return null;
    const ep = t.endpoint;
    const w: TunnelWayIn | null = t.way_in ?? (ep ? { setup: null, last: ep.transport === "tcp" ? "ssh" : (ep.transport ?? null), live: ep.live, tls: null } : null);
    if (!w) return null;
    const last = carrier(w.last);
    const setup = carrier(w.setup);
    const auto = w.setup === "auto";
    if (last) {
        return { via: viaFor(last, w.tls, https), state: w.live ? "live" : "last", setup: setup && setup !== last ? viaFor(setup, null, https) : null, auto };
    }
    // 自動、還沒連過：先試的是 SSH port。/ Automatic, never connected: the SSH port is tried first.
    if (setup || auto) return { via: viaFor(setup ?? "ssh", null, https), state: "setup", setup: null, auto };
    return null;
}

/** 現在連著的話走哪種（「連到 Telepy 的方式」說明圖用）；離線或不知道 = null。/ The live carrier (for the transport explainer). */
export function liveTransport(t: Pick<Tunnel, "way_in" | "endpoint"> | null | undefined): "tcp" | "websocket" | null {
    const w = wayInOf(t);
    if (!w || w.state !== "live") return null;
    return w.via === "ssh" ? "tcp" : "websocket";
}

/** 搜尋 `os:` 接受的值（平台代號）。/ Values the `os:` search key accepts. */
export const OS_QUERY = new Set<string>(PLATFORMS.map((p) => p.id).filter((id) => id !== "docker"));
/** 搜尋 `via:` 接受的值：ssh 或網頁 port（wss，別名 ws / http / websocket / web）。/ Values the `via:` key accepts. */
export const VIA_QUERY = new Set<string>(["ssh", "wss", "ws", "http", "websocket", "web"]);

/** `via:wss` 和它的別名都是「網頁 port」，不管有沒有 TLS。/ `via:wss` and its aliases all mean the web port, TLS or not. */
export function matchesVia(query: string, w: WayIn | null): boolean {
    if (!w) return false;
    return query === "ssh" ? w.via === "ssh" : w.via !== "ssh";
}

/** `os:linux` 也包含樹莓派（它就是 Linux）。/ `os:linux` includes Raspberry Pis, which run Linux. */
export function matchesOs(query: string, id: PlatformId | null): boolean {
    if (!id) return false;
    return query === id || (query === "linux" && id === "raspberrypi");
}
