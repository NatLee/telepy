/**
 * 網頁內遠端桌面的純函式（無 React）：型別、預設埠、從掃描結果猜桌面、錯誤碼 → 翻譯 key + 「卡在哪一段」。
 * 「卡在哪一段」驅動 info 視覺說明（DesktopFlow）把哪條線 / 哪個節點標成失敗。
 * Pure helpers for the in-browser remote desktop: types, default ports, desktop detection from scan results, and
 * error codes → a translation key plus the hop where it stopped (drives the DesktopFlow diagram).
 */
import type { TranslationKey } from "@/locales/en";

export type DesktopProtocol = "rdp" | "vnc";
export type ClipboardPolicy = "both" | "to_remote" | "off";
/** 畫質預設（start 時送給後端 → guacd 參數）。/ Quality preset, turned into guacd parameters at start. */
export type DesktopQuality = "auto" | "speed" | "sharp";
export const QUALITY_VALUES: readonly DesktopQuality[] = ["auto", "speed", "sharp"];
/** Ctrl 當 ⌘：auto = 偵測到 macOS 桌面且瀏覽器不是 Mac 時開。/ auto = on for macOS desktops from a non-Mac browser. */
export type CtrlAsCmdMode = "auto" | "on" | "off";
export const CTRL_MODE_VALUES: readonly CtrlAsCmdMode[] = ["auto", "on", "off"];

export const DEFAULT_PORT: Record<DesktopProtocol, number> = { rdp: 3389, vnc: 5900 };

/** `POST /api/reverse/server/{id}/desktop/start` 的回應。/ The start response. */
export interface DesktopStart {
    session_id: string;
    ws_path: string;
    ticket: string;
    expires_in: number;
    protocol: DesktopProtocol;
    clipboard: ClipboardPolicy;
    quality: DesktopQuality;
    target: { host: string; port: number; label: string; lan_host_id: number | null };
    username: string;
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

/** 這台主機掃描到的桌面服務（3389 = RDP、5900–5909 = VNC）。/ Desktop services seen on a host. */
export function desktopPorts(openPorts: number[]): { protocol: DesktopProtocol; port: number }[] {
    const out: { protocol: DesktopProtocol; port: number }[] = [];
    for (const p of [...openPorts].sort((a, b) => a - b)) {
        if (p === 3389) out.push({ protocol: "rdp", port: p });
        else if (p >= 5900 && p <= 5909) out.push({ protocol: "vnc", port: p });
    }
    return out;
}

export function isValidPort(value: string): boolean {
    if (!/^\d{1,5}$/.test(value.trim())) return false;
    const n = Number(value);
    return n >= 1 && n <= 65535;
}

/** start API 失敗（`{error, code}` + HTTP 狀態）。/ A failed start call. */
export function startFailure(code: string | undefined, status: number, vars: { account: string; address: string }): DesktopFailure {
    switch (code) {
        case "device_offline":
            return { key: "desktop.err.deviceOffline", at: "tunnel" };
        case "device_auth":
            return { key: "desktop.err.deviceAuth", vars: { account: vars.account }, at: "device" };
        case "host_key_changed":
            return { key: "desktop.err.hostKeyChanged", at: "device" };
        case "forwarding_disabled":
            return { key: "desktop.err.forwardingDisabled", at: "device" };
        case "target_unreachable":
            return { key: "desktop.err.targetUnreachable", vars: { address: vars.address }, at: "reach" };
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
export type SpotState = "waiting" | "active" | "ok" | "failed";

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
