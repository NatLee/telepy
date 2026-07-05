/**
 * 使用者外觀/終端機偏好(主題、終端機字型大小)的常數與純 helper。
 * 儲存規則:localStorage 供繪製前(layout.tsx 的 inline script)與 xterm 初始化同步讀取;
 * 登入後與後端 UserSettings 同步(server 為準,見 lib/i18n.tsx 的 UserSettingsSync)。
 * Appearance/terminal preference helpers (theme, terminal font size). localStorage feeds the
 * pre-paint bootstrap script and xterm init synchronously; after login the values sync with
 * the backend UserSettings (server-authoritative; see UserSettingsSync in lib/i18n.tsx).
 */

export type Theme = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "telepy.theme";
export const THEMES: Theme[] = ["system", "light", "dark"];

export const TERMINAL_FONT_SIZE_KEY = "telepy.terminalFontSize";
export const TERMINAL_FONT_SIZE_DEFAULT = 14;
export const TERMINAL_FONT_SIZE_MIN = 10;
export const TERMINAL_FONT_SIZE_MAX = 24;
/** 開著的終端機即時套用字型大小用的事件。/ Event for live-applying font size to open terminals. */
export const TERMINAL_FONT_SIZE_EVENT = "telepy:terminal-font-size";

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
