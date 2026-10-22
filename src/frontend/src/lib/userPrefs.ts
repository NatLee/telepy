/**
 * 使用者外觀/終端機偏好(主題、終端機字型大小)的常數與 helper。
 * 儲存規則:localStorage 供繪製前(layout.tsx 的 inline script)與 xterm 初始化同步讀取;
 * 本機 → 後端由這裡的 persistUserSetting() 上傳,登入時後端 → 本機的套用
 * 見 lib/i18n.tsx 的 UserSettingsSync(server 為準)。
 * Appearance/terminal preference helpers (theme, terminal font size). localStorage feeds the
 * pre-paint bootstrap script and xterm init synchronously. Local→server uploads go through
 * persistUserSetting() below; the login-time server→local direction lives in UserSettingsSync
 * (lib/i18n.tsx, server-authoritative).
 */

import { apiFetch } from "./api";

export type Theme = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "telepy.theme";
export const THEMES: Theme[] = ["system", "light", "dark"];
/** 主題變更廣播:sidebar 切換器與偏好設定 modal 靠它保持同步。
 *  Theme-change broadcast keeping the sidebar switcher and the prefs modal in sync. */
export const THEME_EVENT = "telepy:theme";

export const TERMINAL_FONT_SIZE_KEY = "telepy.terminalFontSize";
export const TERMINAL_FONT_SIZE_DEFAULT = 14;
export const TERMINAL_FONT_SIZE_MIN = 10;
export const TERMINAL_FONT_SIZE_MAX = 24;
/** 開著的終端機即時套用字型大小用的事件。/ Event for live-applying font size to open terminals. */
export const TERMINAL_FONT_SIZE_EVENT = "telepy:terminal-font-size";

/**
 * 介面顯示大小(百分比):設成 <html> 的 font-size,所有 rem 尺寸一起縮放(見 globals.css)。
 * 小 / 中 / 大三個預設值,偏好設定裡另有 5% 一格的滑桿;layout.tsx 的繪製前 script 會先讀 localStorage。
 * UI display scale in percent, applied as the root font-size so every rem-based size scales together
 * (see globals.css). Three presets plus a 5%-step slider in Preferences; the pre-paint script in
 * layout.tsx reads localStorage first.
 */
export const UI_SCALE_KEY = "telepy.uiScale";
export const UI_SCALE_DEFAULT = 100;
export const UI_SCALE_MIN = 85;
export const UI_SCALE_MAX = 130;
export const UI_SCALE_STEP = 5;
export type UiScalePreset = "small" | "medium" | "large";
export const UI_SCALE_PRESETS: Record<UiScalePreset, number> = { small: 90, medium: 100, large: 115 };
export const UI_SCALE_PRESET_ORDER: UiScalePreset[] = ["small", "medium", "large"];
/** 顯示大小變更廣播(偏好設定 modal 與 sidebar 切換器同步用)。/ Broadcast keeping the switchers in sync. */
export const UI_SCALE_EVENT = "telepy:ui-scale";

export function isTheme(value: unknown): value is Theme {
    return typeof value === "string" && (THEMES as string[]).includes(value);
}

export function readStoredTheme(): Theme {
    if (typeof localStorage === "undefined") return "system";
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : "system";
}

/** 套用主題 class 並存到 localStorage(與 layout.tsx 繪製前 script 的邏輯一致)。
 *  Apply the theme class and persist it (mirrors the pre-paint script in layout.tsx). */
export function applyTheme(theme: Theme) {
    if (typeof document === "undefined") return;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    const dark = theme === "dark"
        || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: theme }));
}

/** 已登入時把單一偏好同步到後端;失敗不擋本機切換(下次登入會再同步)。
 *  Fire-and-forget backend sync; a failure never blocks the local change. */
export function persistUserSetting(patch: Record<string, unknown>) {
    if (typeof localStorage !== "undefined" && localStorage.getItem("accessToken")) {
        apiFetch("/api/user/settings", {
            method: "POST",
            body: JSON.stringify(patch),
        }).catch(() => { });
    }
}

export function clampTerminalFontSize(value: number): number {
    if (Number.isNaN(value)) return TERMINAL_FONT_SIZE_DEFAULT;
    return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)));
}

export function readTerminalFontSize(): number {
    if (typeof localStorage === "undefined") return TERMINAL_FONT_SIZE_DEFAULT;
    const raw = parseInt(localStorage.getItem(TERMINAL_FONT_SIZE_KEY) ?? "", 10);
    return Number.isNaN(raw) ? TERMINAL_FONT_SIZE_DEFAULT : clampTerminalFontSize(raw);
}

/** 存字型大小並廣播給開著的終端機即時套用。/ Persist and broadcast to open terminals. */
export function applyTerminalFontSize(size: number) {
    if (typeof document === "undefined") return;
    const clamped = clampTerminalFontSize(size);
    localStorage.setItem(TERMINAL_FONT_SIZE_KEY, String(clamped));
    window.dispatchEvent(new CustomEvent(TERMINAL_FONT_SIZE_EVENT, { detail: clamped }));
}

/** 夾到 85–130 並對齊 5% 一格。/ Clamp to 85–130 and snap to 5% steps. */
export function clampUiScale(value: number): number {
    if (Number.isNaN(value)) return UI_SCALE_DEFAULT;
    const snapped = Math.round(value / UI_SCALE_STEP) * UI_SCALE_STEP;
    return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, snapped));
}

export function readUiScale(): number {
    if (typeof localStorage === "undefined") return UI_SCALE_DEFAULT;
    const raw = parseInt(localStorage.getItem(UI_SCALE_KEY) ?? "", 10);
    return Number.isNaN(raw) ? UI_SCALE_DEFAULT : clampUiScale(raw);
}

/** 目前的值對應到哪個預設(不是整數格就 null)。/ Which preset the value matches, if any. */
export function uiScalePreset(value: number): UiScalePreset | null {
    return UI_SCALE_PRESET_ORDER.find((p) => UI_SCALE_PRESETS[p] === value) ?? null;
}

/** 套用到 <html>(與 layout.tsx 繪製前 script 的邏輯一致)、存 localStorage、廣播。
 *  Apply to <html> (mirrors the pre-paint script), persist, broadcast. */
export function applyUiScale(value: number) {
    if (typeof document === "undefined") return;
    const clamped = clampUiScale(value);
    localStorage.setItem(UI_SCALE_KEY, String(clamped));
    document.documentElement.style.fontSize = clamped === UI_SCALE_DEFAULT ? "" : `${clamped}%`;
    window.dispatchEvent(new CustomEvent<number>(UI_SCALE_EVENT, { detail: clamped }));
}
