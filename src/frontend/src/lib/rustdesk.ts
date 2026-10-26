/**
 * 網頁內 RustDesk 的純函式（無 React）：核心的載入、鍵盤 / 滑鼠事件 → 核心的 JSON、核心事件 → 畫面狀態。
 * 核心 = vendored 的 `public/vendor/rustdesk-web-core/rustdesk-web-core.js`（AGPL；見那裡的 README），一個古典
 * script：裝上 `window.setByName / getByName / init`，讀 `window.onGlobalEvent / onVideoFrame / onRgba`。
 * Pure helpers for in-browser RustDesk: loading the vendored core, turning DOM input into the core's JSON
 * commands and the core's events into page state.
 */
import type { ClipboardPolicy, DesktopFailure } from "@/lib/desktop";
import type { StreamStats } from "@/lib/desktopStats";

/** `POST /api/reverse/server/{id}/rustdesk/start` 的回應。/ The start response. */
export interface RustDeskStart {
    session_id: string;
    ws_path: string;
    ticket: string;
    expires_in: number;
    target: { host: string; port: number; label: string; lan_host_id: number | null };
    username: string;
    /** 剪貼簿方向（選擇套上站台上限），由這一頁的核心套用。/ The clipboard direction, applied by the core in this tab. */
    clipboard?: ClipboardPolicy;
    clipboard_limit?: ClipboardPolicy;
}

export const RUSTDESK_CORE_URL = "/vendor/rustdesk-web-core/rustdesk-web-core.js";

/** 核心裝在 window 上的介面。/ What the core installs on window. */
export interface RustDeskCore {
    init: () => void;
    setByName: (name: string, arg?: unknown) => unknown;
    getByName: (name: string, arg?: unknown) => string;
    rdCore?: { version: string; ready: boolean };
}

let corePromise: Promise<RustDeskCore> | null = null;

/** 載入一次（一個 script 標籤），等它裝好 `init`。/ Load the core once and wait for its globals. */
export function loadRustDeskCore(): Promise<RustDeskCore> {
    if (corePromise) return corePromise;
    corePromise = new Promise<RustDeskCore>((resolve, reject) => {
        const w = window as unknown as Partial<RustDeskCore>;
        if (typeof w.init === "function" && typeof w.setByName === "function") {
            resolve(w as RustDeskCore);
            return;
        }
        const s = document.createElement("script");
        s.src = RUSTDESK_CORE_URL;
        s.async = true;
        s.onload = () => {
            const g = window as unknown as Partial<RustDeskCore>;
            if (typeof g.init === "function" && typeof g.setByName === "function") resolve(g as RustDeskCore);
            else reject(new Error("rustdesk core did not install its globals"));
        };
        s.onerror = () => reject(new Error("rustdesk core failed to load"));
        document.head.appendChild(s);
    }).catch((e) => {
        corePromise = null;
        throw e;
    });
    return corePromise;
}

/** 核心要連的網址：票證放 query，核心會把它當 proxy，id 與 relay 都連同一條。/ The one URL both of the core's sockets use. */
export function rustdeskWsUrl(wsOrigin: string, start: RustDeskStart): string {
    return `${wsOrigin}${start.ws_path}?ticket=${encodeURIComponent(start.ticket)}`;
}

/**
 * 登入用的 peer id：裝置只接受自己的 ID 或「看起來像 IP」的 id（Direct IP Access），所以用目標位址。
 * The peer id for the login: a device accepts its own ID or an IP-looking id, so use the target address.
 */
export function peerIdFor(start: RustDeskStart): string {
    return `${start.target.host}:${start.target.port}`;
}

// ---- keyboard ---------------------------------------------------------------

/** DOM `KeyboardEvent.code` → 核心的 legacy 鍵名（VK_* 或控制鍵名）。/ DOM code → the core's legacy key names. */
const CODE_TO_VK: Record<string, string> = {
    Enter: "VK_RETURN", NumpadEnter: "VK_RETURN", Backspace: "VK_BACK", Tab: "VK_TAB", Escape: "VK_ESCAPE", Space: "VK_SPACE",
    ArrowLeft: "VK_LEFT", ArrowUp: "VK_UP", ArrowRight: "VK_RIGHT", ArrowDown: "VK_DOWN",
    Home: "VK_HOME", End: "VK_END", PageUp: "VK_PRIOR", PageDown: "VK_NEXT", Insert: "VK_INSERT", Delete: "VK_DELETE",
    CapsLock: "VK_CAPITAL", ScrollLock: "VK_SCROLL", Pause: "VK_PAUSE", PrintScreen: "VK_SNAPSHOT", ContextMenu: "Apps",
    ShiftLeft: "VK_SHIFT", ShiftRight: "RShift", ControlLeft: "VK_CONTROL", ControlRight: "RControl",
    AltLeft: "VK_MENU", AltRight: "RAlt", MetaLeft: "Meta", MetaRight: "RWin", OSLeft: "Meta", OSRight: "RWin",
    NumpadDivide: "VK_DIVIDE", NumpadMultiply: "VK_MULTIPLY", NumpadSubtract: "VK_SUBTRACT", NumpadAdd: "VK_ADD", NumpadDecimal: "VK_DECIMAL",
    Numpad0: "VK_NUMPAD0", Numpad1: "VK_NUMPAD1", Numpad2: "VK_NUMPAD2", Numpad3: "VK_NUMPAD3", Numpad4: "VK_NUMPAD4",
    Numpad5: "VK_NUMPAD5", Numpad6: "VK_NUMPAD6", Numpad7: "VK_NUMPAD7", Numpad8: "VK_NUMPAD8", Numpad9: "VK_NUMPAD9",
    F1: "VK_F1", F2: "VK_F2", F3: "VK_F3", F4: "VK_F4", F5: "VK_F5", F6: "VK_F6",
    F7: "VK_F7", F8: "VK_F8", F9: "VK_F9", F10: "VK_F10", F11: "VK_F11", F12: "VK_F12",
    Convert: "VK_CONVERT", KanaMode: "VK_KANA", Lang1: "VK_HANGUL", Lang2: "VK_HANJA",
};

/** 按住修飾鍵時用實體鍵（Ctrl+C 要送「c」不是 e.key 可能給的別的）。/ Physical key names when a modifier is held. */
const CODE_TO_CHAR: Record<string, string> = {
    Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'",
    Comma: ",", Period: ".", Slash: "/", Backquote: "`",
};

export interface KeyName {
    name: string;
}

/**
 * 一個 keydown / keyup → 核心的 `input_key` 名稱；null = 不送（IME 組字中、未知鍵）。
 * 可列印字元用 `e.key`（已含 shift 的結果），按住 Ctrl / Alt / ⌘ 時改用實體鍵的字元（避免 Alt 組合出的符號）。
 * One key event → the core's legacy key name, or null when it must not be sent.
 */
export function keyNameFor(e: { key: string; code: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; isComposing?: boolean; keyCode?: number }): string | null {
    if (e.isComposing || e.keyCode === 229 || e.key === "Process" || e.key === "Dead") return null;
    const vk = CODE_TO_VK[e.code];
    if (vk) return vk;
    const physical = e.code.startsWith("Key") && e.code.length === 4 ? e.code.slice(3).toLowerCase() : e.code.startsWith("Digit") && e.code.length === 6 ? e.code.slice(5) : CODE_TO_CHAR[e.code];
    if ((e.ctrlKey || e.altKey || e.metaKey) && physical) return physical;
    if (Array.from(e.key).length === 1) return e.key;
    if (physical) return physical;
    return null;
}

export interface KeyFlagsJson {
    name: string;
    down: boolean;
    press: boolean;
    alt: boolean;
    ctrl: boolean;
    shift: boolean;
    command: boolean;
}

/** `input_key` 的參數。/ The `input_key` argument. */
export function inputKeyJson(name: string, down: boolean, e: { altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }): KeyFlagsJson {
    return { name, down, press: false, alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey, command: e.metaKey };
}

// ---- mouse ------------------------------------------------------------------

export type MouseButtonName = "left" | "right" | "wheel" | "back" | "forward" | null;

/** DOM `MouseEvent.button` → 核心的按鍵名。/ DOM button → the core's button name. */
export function mouseButtonName(button: number): MouseButtonName {
    switch (button) {
        case 0: return "left";
        case 1: return "wheel";
        case 2: return "right";
        case 3: return "back";
        case 4: return "forward";
        default: return null;
    }
}

export type MouseJson = Record<string, string>;

/** `send_mouse` 的參數：修飾鍵**有按才放進去**（核心看的是 key 存不存在）。/ Modifier keys only when held. */
export function mouseJson(type: "" | "down" | "up" | "wheel", x: number, y: number, button: MouseButtonName, mods: { altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }): MouseJson {
    const m: MouseJson = { type, x: String(Math.round(x)), y: String(Math.round(y)) };
    if (button) m.buttons = button;
    if (mods.altKey) m.alt = "true";
    if (mods.ctrlKey) m.ctrl = "true";
    if (mods.shiftKey) m.shift = "true";
    if (mods.metaKey) m.command = "true";
    return m;
}

/** 滾輪：RustDesk 的 y 正值 = 往上捲，一次一格。/ Wheel steps: positive y scrolls up. */
export function wheelSteps(deltaX: number, deltaY: number): { x: number; y: number } {
    const step = (d: number) => (d > 0 ? -1 : d < 0 ? 1 : 0);
    return { x: deltaX > 0 ? 1 : deltaX < 0 ? -1 : 0, y: step(deltaY) };
}

// ---- events from the core ---------------------------------------------------

export interface RustDeskDisplay {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface RustDeskPeerInfo {
    username: string;
    hostname: string;
    platform: string;
    version: string;
    displays: RustDeskDisplay[];
    currentDisplay: number;
}

function num(v: unknown): number {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
}

/** `peer_info` / `sync_peer_info` 事件 → 結構。/ The peer-info event as a structure. */
export function parsePeerInfo(fields: Record<string, unknown>, previous?: RustDeskPeerInfo | null): RustDeskPeerInfo {
    let displays: RustDeskDisplay[] = previous?.displays ?? [];
    if (typeof fields.displays === "string") {
        try {
            const raw = JSON.parse(fields.displays);
            if (Array.isArray(raw)) displays = raw.map((d: Record<string, unknown>) => ({ x: num(d.x), y: num(d.y), width: num(d.width), height: num(d.height) }));
        } catch {
            // 壞的 JSON：保留上一次的。/ Keep the previous list on bad JSON.
        }
    }
    const cd = fields.current_display !== undefined ? num(fields.current_display) : previous?.currentDisplay ?? 0;
    return {
        username: String(fields.username ?? previous?.username ?? ""),
        hostname: String(fields.hostname ?? previous?.hostname ?? ""),
        platform: String(fields.platform ?? previous?.platform ?? ""),
        version: String(fields.version ?? previous?.version ?? ""),
        displays,
        currentDisplay: cd >= 0 && cd < displays.length ? cd : 0,
    };
}

/**
 * `update_quality_status` → 延遲面板用的統計。RustDesk 自己量的 `delay` 是它的往返；fps 是每個螢幕一個數，取目前的；
 * 位元率是目標值（kbps）。/ The quality event as stream stats: RustDesk's own round trip, the fps, the target bitrate.
 */
export function qualityToStats(fields: Record<string, unknown>, currentDisplay: number, at = Date.now()): StreamStats {
    let fps = 0;
    if (typeof fields.fps === "string") {
        try {
            const raw = JSON.parse(fields.fps) as Record<string, unknown>;
            const v = raw?.[String(currentDisplay)] ?? Object.values(raw ?? {})[0];
            fps = Math.round(num(v));
        } catch {
            fps = Math.round(num(fields.fps));
        }
    } else {
        fps = Math.round(num(fields.fps));
    }
    const delay = fields.delay === undefined || fields.delay === "" ? null : num(fields.delay);
    const kbps = num(fields.target_bitrate);
    return {
        windowMs: 1000,
        frameMs: null,
        netMs: delay,
        tunnelMs: null,
        fps,
        downBps: Math.round((kbps * 1000) / 8),
        upBps: 0,
        behind: 0,
        merged: 0,
        at,
    };
}

export interface RustDeskMsgbox {
    type: string;
    title: string;
    text: string;
}

/**
 * 核心的 `msgbox` → 怎麼處理：`continue` = 自動確認不加密的直連（隧道本身加密）、`failure` = 結束並顯示原因、
 * `ignore` = 進度訊息。/ What to do with a msgbox from the core.
 */
export function classifyMsgbox(m: RustDeskMsgbox): { kind: "continue" } | { kind: "failure"; failure: DesktopFailure } | { kind: "ignore" } {
    if (m.type.startsWith("insecure-connection")) return { kind: "continue" };
    if (m.type === "re-input-password" || m.type === "input-password") return { kind: "failure", failure: { key: "desktop.err.rdPassword", at: "target" } };
    if (m.type === "error" || m.type === "elevation-error") {
        const text = m.text || m.title || "";
        if (/offline|not the correct id|LOGIN_MSG_OFFLINE/i.test(text)) return { kind: "failure", failure: { key: "desktop.err.rdOffline", at: "target" } };
        if (/No Display/i.test(text)) return { kind: "failure", failure: { key: "desktop.err.rdNoDisplay", at: "target" } };
        if (/closed|WebSocket/i.test(text)) return { kind: "failure", failure: { key: "desktop.err.engineClosed", at: "telepy" } };
        return { kind: "failure", failure: { key: "desktop.err.generic", vars: { message: text }, at: "target" } };
    }
    return { kind: "ignore" };
}

/** 後端的關閉碼（放在 close reason）→ 失敗。/ The backend's close codes. */
export function rustdeskCloseFailure(code: number): DesktopFailure | null {
    switch (code) {
        case 1000:
        case 1005:
            return null;
        case 4404:
            return { key: "desktop.err.expired", at: "web" };
        case 4403:
            return { key: "desktop.err.forbidden", at: "telepy" };
        case 4013:
            return { key: "desktop.err.rdDeviceClosed", at: "target" };
        case 4014:
            return { key: "desktop.err.stopped", at: "telepy" };
        case 4400:
            return { key: "desktop.err.protocol", at: "web" };
        case 4009:
        case 4010:
            return { key: "desktop.err.stopped", at: "telepy" };
    }
    return { key: "desktop.err.generic", vars: { message: String(code) }, at: "telepy" };
}
