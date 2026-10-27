/**
 * 網頁內遠端桌面的純函式（無 React）：型別、預設埠、從掃描結果猜桌面、錯誤碼 → 翻譯 key + 「卡在哪一段」。
 * 「卡在哪一段」驅動 info 視覺說明（DesktopFlow）把哪條線 / 哪個節點標成失敗。
 * Pure helpers for the in-browser remote desktop: types, default ports, desktop detection from scan results, and
 * error codes → a translation key plus the hop where it stopped (drives the DesktopFlow diagram).
 */
import type { TranslationKey } from "@/locales/en";
import type { SpotState } from "@/lib/flow";

export type { SpotState };

export type DesktopProtocol = "rdp" | "vnc";
/**
 * 桌面頁的模式：guacd 畫在瀏覽器裡的 RDP / VNC，或 Telepy 只負責轉發、用原生 client 看的 RustDesk（Direct IP）。
 * The page's mode: RDP / VNC rendered by guacd, or RustDesk, which Telepy forwards for the native client.
 */
export type DesktopMode = DesktopProtocol | "rustdesk";
/**
 * 剪貼簿方向：both = 雙向、to_remote = 只能貼進遠端、off = 關閉。每個人自己選（個人設定 `desktop_clipboard`），
 * 站台的同名設定是上限，實際用的是較窄的那個（和後端 `Clipboard::within` 一樣）。
 * Clipboard direction. Each user picks one; the site setting of the same name is the ceiling and the narrower applies
 * (mirrors the backend's `Clipboard::within`).
 */
export type ClipboardPolicy = "both" | "to_remote" | "off";
export const CLIPBOARD_VALUES: readonly ClipboardPolicy[] = ["both", "to_remote", "off"];
const CLIPBOARD_RANK: Record<ClipboardPolicy, number> = { off: 0, to_remote: 1, both: 2 };
export const CLIPBOARD_LABEL: Record<ClipboardPolicy, TranslationKey> = { both: "desktop.clipboard.both", to_remote: "desktop.clipboard.toRemote", off: "desktop.clipboard.off" };

export function isClipboardPolicy(value: unknown): value is ClipboardPolicy {
    return typeof value === "string" && (CLIPBOARD_VALUES as readonly string[]).includes(value);
}

/** 這個方向在上限之內嗎（超過的選項要關掉）。/ Whether a direction fits under the limit. */
export function clipboardAllowed(value: ClipboardPolicy, limit: ClipboardPolicy): boolean {
    return CLIPBOARD_RANK[value] <= CLIPBOARD_RANK[limit];
}

/** 使用者的選擇套上上限。/ The user's choice capped by the site limit. */
export function clipboardWithin(choice: ClipboardPolicy, limit: ClipboardPolicy): ClipboardPolicy {
    return clipboardAllowed(choice, limit) ? choice : limit;
}
/** RustDesk 的 Direct IP Access 埠。/ RustDesk's Direct IP Access port. */
export const RUSTDESK_PORT = 21118;
/** 畫質預設（start 時送給後端 → guacd 參數）。/ Quality preset, turned into guacd parameters at start. */
export type DesktopQuality = "auto" | "speed" | "sharp";
export const QUALITY_VALUES: readonly DesktopQuality[] = ["auto", "speed", "sharp"];
export const QUALITY_LABEL: Record<DesktopQuality, TranslationKey> = { auto: "desktop.quality.auto", speed: "desktop.quality.speed", sharp: "desktop.quality.sharp" };
export const QUALITY_HINT: Record<DesktopQuality, TranslationKey> = {
    auto: "desktop.quality.hint.auto",
    speed: "desktop.quality.hint.speed",
    sharp: "desktop.quality.hint.sharp",
};
/** Ctrl 當 ⌘：auto = 偵測到 macOS 桌面且瀏覽器不是 Mac 時開。/ auto = on for macOS desktops from a non-Mac browser. */
export type CtrlAsCmdMode = "auto" | "on" | "off";
export const CTRL_MODE_VALUES: readonly CtrlAsCmdMode[] = ["auto", "on", "off"];

export const DEFAULT_PORT: Record<DesktopMode, number> = { rdp: 3389, vnc: 5900, rustdesk: RUSTDESK_PORT };

/** `GET …/desktop/probe` 的回應。/ The probe response. */
export interface DesktopProbe {
    reachable: boolean;
    target: { host: string; port: number; label: string; lan_host_id: number | null };
    username: string;
}

/** `POST /api/reverse/server/{id}/desktop/start` 的回應。/ The start response. */
export interface DesktopStart {
    session_id: string;
    ws_path: string;
    ticket: string;
    expires_in: number;
    protocol: DesktopProtocol;
    /** 實際用的方向（選擇套上上限）。/ The direction in effect (the choice under the limit). */
    clipboard: ClipboardPolicy;
    /** 站台上限。/ The site's ceiling. */
    clipboard_limit: ClipboardPolicy;
    quality: DesktopQuality;
    /** 這次有聲音（只有 RDP）。/ Sound is on for this session (RDP only). */
    audio?: boolean;
    target: { host: string; port: number; label: string; lan_host_id: number | null };
    username: string;
}

/** 聲音偏好（localStorage `telepy.desktopAudio`，預設關：吃頻寬）。/ The sound preference (off by default: it costs bandwidth). */
export type AudioPref = "on" | "off";
export const AUDIO_PREF_VALUES: readonly AudioPref[] = ["on", "off"];

/** 這種連法有沒有聲音可開：RDP、RustDesk 有；guacd 的 VNC 沒有。/ Whether this mode can carry sound (not guacd's VNC). */
export function soundAvailable(mode: DesktopMode): boolean {
    return mode !== "vnc";
}

/** sharp 時向 guacd 要原生解析度的倍率（最多 2 倍）。/ The HiDPI factor requested for the sharp preset (capped at 2). */
export function pixelRatioFor(quality: DesktopQuality, devicePixelRatio: number): number {
    if (quality !== "sharp") return 1;
    return Math.min(2, Math.max(1, Math.round(devicePixelRatio * 100) / 100));
}

/** Ctrl 是否送成 ⌘。/ Whether Control goes out as Command. */
export function ctrlAsCmd(mode: CtrlAsCmdMode, remoteOs: string | null, browserIsMac: boolean): boolean {
    if (mode === "on") return true;
    if (mode === "off") return false;
    return remoteOs === "darwin" && !browserIsMac;
}

export function isMacBrowser(nav: { platform?: string; userAgent?: string } | undefined): boolean {
    if (!nav) return false;
    return /Mac|iPhone|iPad|iPod/.test(nav.platform || "") || /Macintosh|Mac OS X/.test(nav.userAgent || "");
}

/** 連線的階段（驅動按鈕與示意圖）。/ Connection phase (drives the buttons and the diagram). */
export type DesktopPhase = "idle" | "starting" | "connecting" | "connected" | "failed";

/**
 * 路徑上的位置：你的瀏覽器 ─web─ Telepy ─tunnel─ 裝置 ─reach─ 桌面。
 * Positions on the path: browser ─web─ Telepy ─tunnel─ device ─reach─ desktop.
 */
export type FlowSpot = "browser" | "web" | "telepy" | "tunnel" | "device" | "reach" | "target";

export interface DesktopFailure {
    key: TranslationKey;
    vars?: Record<string, string | number>;
    at: FlowSpot;
}

/** 這台主機掃描到的桌面服務（3389 = RDP、5900–5909 = VNC、21118 = RustDesk）。/ Desktop services seen on a host. */
export function desktopPorts(openPorts: number[]): { protocol: DesktopMode; port: number }[] {
    const out: { protocol: DesktopMode; port: number }[] = [];
    for (const p of [...openPorts].sort((a, b) => a - b)) {
        if (p === 3389) out.push({ protocol: "rdp", port: p });
        else if (p >= 5900 && p <= 5909) out.push({ protocol: "vnc", port: p });
        else if (p === RUSTDESK_PORT) out.push({ protocol: "rustdesk", port: p });
    }
    return out;
}

export function isValidPort(value: string): boolean {
    if (!/^\d{1,5}$/.test(value.trim())) return false;
    const n = Number(value);
    return n >= 1 && n <= 65535;
}

/** start API 失敗（`{error, code}` + HTTP 狀態）。/ A failed start call. */
/**
 * 開始 / 探測失敗的說明。RustDesk 的埠被拒（`target_unreachable`）幾乎都是那台 RustDesk 沒開 Direct IP Access，
 * 所以 RustDesk 模式給它自己的說明，不是 RDP / VNC 那句。
 * Why a start or probe failed. A refused RustDesk port almost always means Direct IP Access is off on that RustDesk,
 * so RustDesk mode gets its own explanation instead of the RDP / VNC one.
 */
export function startFailure(code: string | undefined, status: number, vars: { account: string; address: string }, mode: DesktopMode = "rdp"): DesktopFailure {
    switch (code) {
        case "device_offline":
            return { key: "desktop.err.deviceOffline", at: "tunnel" };
        case "device_auth":
            return { key: "desktop.err.deviceAuth", vars: { account: vars.account }, at: "device" };
        case "host_key_changed":
            return { key: "desktop.err.hostKeyChanged", at: "device" };
        case "device_claimed":
            return { key: "desktop.err.deviceClaimed", at: "device" };
        case "forwarding_disabled":
            return { key: "desktop.err.forwardingDisabled", at: "device" };
        case "target_unreachable":
            return mode === "rustdesk"
                ? { key: "desktop.err.rdDirectIpOff", vars: { address: vars.address }, at: "reach" }
                : { key: "desktop.err.targetUnreachable", vars: { address: vars.address }, at: "reach" };
        case "device_unreachable":
            return { key: "desktop.err.deviceUnreachable", at: "device" };
        case "desktop_busy":
            return { key: "desktop.err.busy", at: "telepy" };
        case "desktop_disabled":
            return { key: "desktop.err.disabled", at: "telepy" };
    }
    if (status === 403) return { key: "desktop.err.forbidden", at: "telepy" };
    if (status === 404) return { key: "desktop.err.notFound", at: "telepy" };
    return { key: "desktop.err.start", at: "telepy" };
}

/**
 * 連線中斷：後端的關閉碼（4xxx，放在 Guacamole status code）或 guacd 的 Guacamole 狀態碼。null = 正常結束。
 * The session ended: our 4xxx close codes (carried as the Guacamole status) or guacd's status codes. null = normal.
 */
export function sessionFailure(code: number, message?: string): DesktopFailure | null {
    switch (code) {
        case 0:
        case 1000:
            return null;
        case 4404:
            return { key: "desktop.err.expired", at: "web" };
        case 4403:
            return { key: "desktop.err.forbidden", at: "telepy" };
        case 4011:
            return { key: "desktop.err.engine", at: "telepy" };
        case 4013:
            return { key: "desktop.err.engineClosed", at: "telepy" };
        case 4014:
            return { key: "desktop.err.stopped", at: "telepy" };
        case 4400:
            return { key: "desktop.err.protocol", at: "web" };
        case 4009:
            return { key: "desktop.err.stopped", at: "telepy" };
        case 4010:
            return { key: "desktop.err.signedOut", at: "web" };
        // Guacamole.Status.Code
        case 0x0201: // SERVER_BUSY
            return { key: "desktop.err.busy", at: "telepy" };
        case 0x0202: // UPSTREAM_TIMEOUT
            return { key: "desktop.err.timeout", at: "target" };
        case 0x0203: // UPSTREAM_ERROR（RDP 帳密錯誤、NLA 失敗常落在這）/ often a failed RDP login
        case 0x0301: // CLIENT_UNAUTHORIZED
        case 0x0303: // CLIENT_FORBIDDEN
            return { key: "desktop.err.loginRejected", at: "target" };
        case 0x0207: // UPSTREAM_NOT_FOUND
        case 0x0208: // UPSTREAM_UNAVAILABLE
            return { key: "desktop.err.noAnswer", at: "target" };
        case 0x0209: // SESSION_CONFLICT
            return { key: "desktop.err.conflict", at: "target" };
        case 0x020a: // SESSION_TIMEOUT
            return { key: "desktop.err.remoteIdle", at: "target" };
        case 0x020b: // SESSION_CLOSED
            return { key: "desktop.err.remoteClosed", at: "target" };
        case 0x0308: // CLIENT_TIMEOUT
            return { key: "desktop.err.timeout", at: "web" };
    }
    return { key: "desktop.err.generic", vars: { message: message || String(code) }, at: "telepy" };
}

/** 經過了多久：`42s` / `3:05` / `1:02:09`。/ Elapsed time for the toolbar. */
export function formatElapsed(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    if (m > 0) return `${m}:${String(sec).padStart(2, "0")}`;
    return `${sec}s`;
}

/**
 * 示意圖每一段的狀態。/ The state of every spot on the diagram.
 * - idle：全部待命；starting：Telepy→裝置那段在做（開通道）；connecting：前兩段好了，裝置→桌面在登入；
 *   connected：全部通；failed：失敗那段之前都算通、那段標紅、之後待命。
 */
const ORDER: FlowSpot[] = ["browser", "web", "telepy", "tunnel", "device", "reach", "target"];

export function spotStates(phase: DesktopPhase, failure: DesktopFailure | null): Record<FlowSpot, SpotState> {
    const all = (s: SpotState) => Object.fromEntries(ORDER.map((k) => [k, s])) as Record<FlowSpot, SpotState>;
    if (phase === "idle") return all("waiting");
    if (phase === "connected") return all("ok");
    if (phase === "failed" && failure) {
        const at = ORDER.indexOf(failure.at);
        return Object.fromEntries(ORDER.map((k, i) => [k, i < at ? "ok" : i === at ? "failed" : "waiting"])) as Record<FlowSpot, SpotState>;
    }
    // starting：REST 正在檢查權限、經裝置開到桌面的通道（桌面本身還沒碰）。connecting：通道好了，guacd 正在登入桌面。
    // starting: the REST call checks access and opens the channel through the device. connecting: guacd is logging in.
    const from = ORDER.indexOf(phase === "starting" ? "telepy" : "target");
    const to = phase === "starting" ? ORDER.indexOf("reach") : ORDER.indexOf("target");
    return Object.fromEntries(ORDER.map((k, i) => [k, i < from ? "ok" : i <= to ? "active" : "waiting"])) as Record<FlowSpot, SpotState>;
}
