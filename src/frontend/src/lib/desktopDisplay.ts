/**
 * 遠端桌面的個人偏好（純函式）：畫面怎麼縮放、遠端要多大的解析度、要不要 HiDPI，以及每次連線的畫質與聲音預設。
 * 存在帳號上（`/api/user/settings` 的 `desktop_display`，後端 `desktop::display` 有同一份規則），換瀏覽器也一樣；
 * localStorage `telepy.desktopDisplay` 只是第一次畫面用的快取（lib/desktopDisplayStore.ts）。
 * The remote desktop preferences (pure): scaling, the remote resolution, HiDPI and the quality / sound defaults.
 * Saved on the account (`desktop_display`, mirrored by the backend's `desktop::display`); localStorage is only the
 * first-paint cache.
 *
 * 每種方式能動態調整的範圍不同 / What can follow the window per way:
 * - RDP：遠端解析度跟著框改（guacd resize-method display-update，瀏覽器送 `size`），或固定一個大小。
 * - VNC：解析度由遠端決定，只在瀏覽器裡縮放；只有支援 SetDesktopSize 的虛擬桌面（TigerVNC、KasmVNC 的 Xvnc）
 *   能被要求跟著框改（預設關，實體螢幕不該被改解析度）。
 * - RustDesk：解析度由遠端決定，只在瀏覽器裡縮放（網頁核心沒有實作改解析度）。
 */

import type { DesktopMode, DesktopQuality } from "./desktop.ts";

const QUALITIES: readonly DesktopQuality[] = ["auto", "speed", "sharp"];

/** 縮放方式。/ How the picture is scaled into the frame. */
export type ScaleMode = "fit" | "shrink" | "actual" | "custom";
export const SCALE_MODES: readonly ScaleMode[] = ["fit", "shrink", "actual", "custom"];

/** RDP 的解析度：跟著視窗，或固定的大小。/ The RDP resolution: follow the window, or a fixed size. */
export type ResolutionChoice = "window" | "fixed";

export interface FixedSize {
    width: number;
    height: number;
}

/** 固定解析度的常見選項。/ Common fixed resolutions. */
export const RESOLUTION_PRESETS: readonly FixedSize[] = [
    { width: 1280, height: 720 },
    { width: 1600, height: 900 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
];

export interface DisplayPrefs {
    scale: ScaleMode;
    /** scale = custom 時的百分比（相對 1:1）。/ The percentage for scale = custom. */
    percent: number;
    resolution: ResolutionChoice;
    /** resolution = fixed 的大小。/ The fixed size. */
    fixed: FixedSize;
    /** 用裝置像素要解析度（Retina 等螢幕上字更銳利，但遠端要自己放大 UI）。/ Ask for device pixels. */
    hidpi: boolean;
    /** VNC 也要求遠端跟著視窗改解析度（只有虛擬桌面會照做）。/ Ask VNC servers to follow the window too. */
    vncResize: boolean;
    /** 畫質預設。/ The quality preset. */
    quality: DesktopQuality;
    /** 聲音（RDP / RustDesk；預設關，吃頻寬）。/ Sound (RDP / RustDesk; off by default). */
    audio: boolean;
}

export const DISPLAY_KEY = "telepy.desktopDisplay";

export const DEFAULT_DISPLAY: DisplayPrefs = {
    scale: "fit",
    percent: 100,
    resolution: "window",
    fixed: { width: 1920, height: 1080 },
    hidpi: false,
    vncResize: false,
    quality: "auto",
    audio: false,
};

/** 改到帳號之前分開存的畫質 / 聲音（還沒有新格式時讀它們）。/ The keys quality / sound used before they moved to the account. */
export const LEGACY_QUALITY_KEY = "telepy.desktopQuality";
export const LEGACY_AUDIO_KEY = "telepy.desktopAudio";

export const MIN_PERCENT = 25;
export const MAX_PERCENT = 400;
/** 和後端一樣的下限。/ The backend's minimum side. */
export const MIN_DIMENSION = 200;
export const MAX_DIMENSION = 16384;

const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : null);

/** 自訂百分比：夾在 25–400。/ A custom percentage, clamped. */
export function clampPercent(v: unknown): number {
    const n = int(v);
    return n === null ? DEFAULT_DISPLAY.percent : Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, n));
}

/** 一個寬或高：200–16384，否則 null。/ One side, or null when out of range. */
export function validDimension(v: unknown): number | null {
    const n = int(v);
    return n !== null && n >= MIN_DIMENSION && n <= MAX_DIMENSION ? n : null;
}

/** 讀回存的偏好：壞掉 / 舊的值一律回預設（逐欄）；新格式沒有畫質 / 聲音時用舊的分開存的值。
 * Parse the stored preferences field by field; the old separate quality / sound values fill in when missing. */
export function parseDisplayPrefs(raw: string | null | undefined, legacyQuality?: string | null, legacyAudio?: string | null): DisplayPrefs {
    let o: Record<string, unknown> = {};
    try {
        const v = raw ? JSON.parse(raw) : null;
        if (v && typeof v === "object" && !Array.isArray(v)) o = v as Record<string, unknown>;
    } catch {
        o = {};
    }
    const fixed = o.fixed && typeof o.fixed === "object" ? (o.fixed as Record<string, unknown>) : {};
    const w = validDimension(fixed.width);
    const h = validDimension(fixed.height);
    return {
        scale: SCALE_MODES.includes(o.scale as ScaleMode) ? (o.scale as ScaleMode) : DEFAULT_DISPLAY.scale,
        percent: o.percent === undefined ? DEFAULT_DISPLAY.percent : clampPercent(o.percent),
        resolution: o.resolution === "fixed" ? "fixed" : "window",
        fixed: w && h ? { width: w, height: h } : DEFAULT_DISPLAY.fixed,
        hidpi: o.hidpi === true,
        vncResize: o.vncResize === true,
        quality: QUALITIES.includes(o.quality as DesktopQuality) ? (o.quality as DesktopQuality) : QUALITIES.includes(legacyQuality as DesktopQuality) ? (legacyQuality as DesktopQuality) : DEFAULT_DISPLAY.quality,
        audio: typeof o.audio === "boolean" ? o.audio : legacyAudio === "on",
    };
}

/** 帳號上的格式（snake_case、寬高攤平；和後端 `desktop::display` 一樣）。/ The account's shape, as the backend stores it. */
export interface ServerDisplay {
    scale: ScaleMode;
    percent: number;
    resolution: ResolutionChoice;
    width: number;
    height: number;
    hidpi: boolean;
    vnc_resize: boolean;
    quality: DesktopQuality;
    audio: boolean;
}

export function toServer(p: DisplayPrefs): ServerDisplay {
    const n = parseDisplayPrefs(JSON.stringify(p));
    return { scale: n.scale, percent: n.percent, resolution: n.resolution, width: n.fixed.width, height: n.fixed.height, hidpi: n.hidpi, vnc_resize: n.vncResize, quality: n.quality, audio: n.audio };
}

/** 帳號上的值 → 偏好；null / 不是物件 = 帳號還沒選過。/ The account's value, or null when it has none. */
export function fromServer(v: unknown): DisplayPrefs | null {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    return parseDisplayPrefs(JSON.stringify({ ...o, fixed: { width: o.width, height: o.height }, vncResize: o.vnc_resize }));
}

export function sameDisplay(a: DisplayPrefs, b: DisplayPrefs): boolean {
    return serializeDisplayPrefs(a) === serializeDisplayPrefs(b);
}

/** 存成 JSON（只存認得的欄位）。/ Serialise (known fields only). */
export function serializeDisplayPrefs(p: DisplayPrefs): string {
    return JSON.stringify(parseDisplayPrefs(JSON.stringify(p)));
}

/** HiDPI 開著時用裝置像素的倍率（最多 2 倍）；關著 = 1。/ The device-pixel factor in use (≤ 2), or 1. */
export function pixelRatioFor(hidpi: boolean, devicePixelRatio: number): number {
    if (!hidpi) return 1;
    return Math.min(2, Math.max(1, Math.round((devicePixelRatio || 1) * 100) / 100));
}

/** 遠端解析度要不要跟著框走（start 的 `resize`）。/ Whether the remote resolution follows the frame (start's `resize`). */
export function followsWindow(p: DisplayPrefs, protocol: DesktopMode): boolean {
    if (protocol === "rdp") return p.resolution === "window";
    if (protocol === "vnc") return p.vncResize;
    return false;
}

/** 等比夾進站台上限（和後端的 clamp_size 一樣）。/ Clamp keeping the shape, like the backend's clamp_size. */
export function clampSize(width: number, height: number, max: number): FixedSize {
    const m = Math.max(MIN_DIMENSION, max);
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const long = Math.max(w, h);
    const f = long > m ? m / long : 1;
    const c = (v: number) => Math.min(m, Math.max(MIN_DIMENSION, Math.round(v * f)));
    return { width: c(w), height: c(h) };
}

export interface RequestedSize extends FixedSize {
    dpi: number;
}

/**
 * 向 guacd 要的大小：跟著視窗 = 框的 CSS 大小 ×（HiDPI 倍率）；固定 = 選的大小。dpi 跟著 HiDPI（Windows 會依它放大 UI，
 * xrdp 通常不理）。`max` = 站台上限（未知時不夾，後端照樣會夾）。
 * The size asked of guacd: the frame (× the HiDPI factor) when following the window, else the fixed size.
 */
export function requestedSize(p: DisplayPrefs, protocol: DesktopMode, frame: FixedSize, ratio: number, max: number | null): RequestedSize {
    const pr = Math.max(1, ratio);
    const follow = protocol !== "rdp" || p.resolution === "window";
    const raw = follow
        ? { width: Math.max(320, Math.round(frame.width * pr)), height: Math.max(240, Math.round(frame.height * pr)) }
        : p.fixed;
    const size = max ? clampSize(raw.width, raw.height, max) : raw;
    return { width: size.width, height: size.height, dpi: Math.round(96 * pr) };
}

/** 縮放方式 → 縮放模組的模式。/ The zoom module's starting mode for a scaling choice. */
export function zoomPref(p: DisplayPrefs): { mode: "fit" | "shrink" | "actual" | "custom"; percent: number } {
    return { mode: p.scale, percent: p.percent };
}

/** 每種方式哪些會動態調整（說明用）。/ What follows the window per way (for the explanations). */
export type Dynamic = "remote" | "browser";
export function dynamicFor(protocol: DesktopMode, p: DisplayPrefs): Dynamic {
    return followsWindow(p, protocol) ? "remote" : "browser";
}

/** 「1920×1080」。/ A size label. */
export function sizeLabel(s: FixedSize | null | undefined): string {
    return s ? `${s.width}×${s.height}` : "";
}

/**
 * 連線中的解析度狀態（工具列與偏好說明用）：follows = 遠端跟著框（RDP）；asked = 要求 VNC 跟著（伺服器不支援就不動）；
 * fixed = 固定大小、瀏覽器縮放；remote = 遠端決定、瀏覽器縮放（VNC、RustDesk）。
 * The resolution situation of a session: follows (RDP), asked (VNC asked to follow), fixed, or set by the remote.
 */
export type ResolutionStatus = "follows" | "asked" | "fixed" | "remote";
export function resolutionStatus(protocol: DesktopMode, sessionResize: boolean): ResolutionStatus {
    if (protocol === "rdp") return sessionResize ? "follows" : "fixed";
    if (protocol === "vnc") return sessionResize ? "asked" : "remote";
    return "remote";
}
