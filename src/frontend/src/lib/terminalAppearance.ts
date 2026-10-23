/**
 * 網頁終端機外觀:可選的字型(Nerd Font Mono)與配色,以及「個人預設 + 這台裝置的覆寫」的合成規則。
 * 純資料與純函式,不碰 DOM / localStorage(那些在 lib/userPrefs.ts 與 hooks/useTerminalAppearance.ts)。
 * 後端只存 id(`/api/user/settings` 的 terminal_font / terminal_scheme,與
 * `/api/reverse/server/{id}/terminal-profile`),不認得的 id 一律回到預設,所以從清單拿掉一項不會壞。
 * Web-terminal appearance: the font (Nerd Font Mono) and colour-scheme catalogue plus the rule that
 * merges the personal default with a per-device override. Pure data and functions; storage lives in
 * lib/userPrefs.ts and hooks/useTerminalAppearance.ts. The backend stores ids only, and an unknown id
 * falls back to the default, so removing an entry here never breaks a saved setting.
 */
import type { TranslationKey } from "@/locales/en";

export interface TerminalFont {
    id: string;
    /** 顯示名稱(產品名,不翻譯)。/ Display name (a product name, not translated). */
    name: string;
    /** CSS font-family 名稱(terminal-fonts.css 的 @font-face)。/ The @font-face family in terminal-fonts.css. */
    family: string;
    /** 字型不是 @font-face 宣告的,而是 next/font 給的 CSS 變數(0xProto)。/ Family comes from a next/font CSS variable. */
    cssVar?: string;
    note: TranslationKey;
}

/** xterm.js 的 ITheme 子集(16 色 + 前景 / 背景 / 游標 / 選取)。/ The ITheme subset xterm.js uses here. */
export interface TerminalPalette {
    background: string;
    foreground: string;
    cursor: string;
    cursorAccent: string;
    selectionBackground: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
}

export interface TerminalScheme {
    id: string;
    name: string;
    kind: "dark" | "light";
    theme: TerminalPalette;
}

export const DEFAULT_TERMINAL_FONT = "hack";
export const DEFAULT_TERMINAL_SCHEME = "telepy";

export const TERMINAL_FONTS: TerminalFont[] = [
    { id: "hack", name: "Hack", family: "Hack Nerd Font Mono", note: "terminal.fontNoteHack" },
    { id: "jetbrains-mono", name: "JetBrains Mono", family: "JetBrainsMono NFM", note: "terminal.fontNoteJetbrains" },
    { id: "fira-code", name: "Fira Code", family: "FiraCode Nerd Font Mono", note: "terminal.fontNoteFira" },
    { id: "cascadia-code", name: "Cascadia Code", family: "CaskaydiaCove NFM", note: "terminal.fontNoteCascadia" },
    { id: "meslo", name: "Meslo LGS", family: "MesloLGS Nerd Font Mono", note: "terminal.fontNoteMeslo" },
    { id: "0xproto", name: "0xProto", family: "0xProto Nerd Font", cssVar: "--font-0xproto", note: "terminal.fontNoteProto" },
];

// 配色值取自各專案官方的終端機移植(Solarized、Dracula、Nord、Gruvbox、Tokyo Night、Catppuccin)與
// Windows Terminal 內建的 One Half。telepy = 這次之前一直用的配色。
// Values follow each project's official terminal ports (and Windows Terminal's built-in One Half);
// "telepy" is the scheme the terminal always had.
export const TERMINAL_SCHEMES: TerminalScheme[] = [
    {
        id: "telepy", name: "Telepy", kind: "dark",
        theme: {
            background: "#000000", foreground: "#f0f0f0", cursor: "#f0f0f0", cursorAccent: "#000000", selectionBackground: "#3a3d41",
            black: "#000000", red: "#f44747", green: "#608b4e", yellow: "#d7ba7d", blue: "#569cd6", magenta: "#c586c0", cyan: "#4dc9b0", white: "#d4d4d4",
            brightBlack: "#808080", brightRed: "#f48771", brightGreen: "#89d185", brightYellow: "#d7ba7d", brightBlue: "#9cdcfe", brightMagenta: "#c586c0", brightCyan: "#4ec9b0", brightWhite: "#ffffff",
        },
    },
    {
        // brightBlack 用 base01 而非 base03(= 背景色),否則 zsh 自動建議之類的灰字會看不見。
        // brightBlack is base01 rather than base03 (the background) so grey text such as zsh suggestions stays visible.
        id: "solarized-dark", name: "Solarized Dark", kind: "dark",
        theme: {
            background: "#002b36", foreground: "#839496", cursor: "#93a1a1", cursorAccent: "#002b36", selectionBackground: "#073642",
            black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
            brightBlack: "#586e75", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
        },
    },
    {
        id: "solarized-light", name: "Solarized Light", kind: "light",
        theme: {
            background: "#fdf6e3", foreground: "#657b83", cursor: "#586e75", cursorAccent: "#fdf6e3", selectionBackground: "#eee8d5",
            black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
            brightBlack: "#586e75", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
        },
    },
    {
        id: "dracula", name: "Dracula", kind: "dark",
        theme: {
            background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", cursorAccent: "#282a36", selectionBackground: "#44475a",
            black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c", blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
            brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94", brightYellow: "#ffffa5", brightBlue: "#d6acff", brightMagenta: "#ff92df", brightCyan: "#a4ffff", brightWhite: "#ffffff",
        },
    },
    {
        id: "nord", name: "Nord", kind: "dark",
        theme: {
            background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9", cursorAccent: "#2e3440", selectionBackground: "#434c5e",
            black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b", blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
            brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c", brightYellow: "#ebcb8b", brightBlue: "#81a1c1", brightMagenta: "#b48ead", brightCyan: "#8fbcbb", brightWhite: "#eceff4",
        },
    },
    {
        id: "gruvbox-dark", name: "Gruvbox Dark", kind: "dark",
        theme: {
            background: "#282828", foreground: "#ebdbb2", cursor: "#ebdbb2", cursorAccent: "#282828", selectionBackground: "#504945",
            black: "#282828", red: "#cc241d", green: "#98971a", yellow: "#d79921", blue: "#458588", magenta: "#b16286", cyan: "#689d6a", white: "#a89984",
            brightBlack: "#928374", brightRed: "#fb4934", brightGreen: "#b8bb26", brightYellow: "#fabd2f", brightBlue: "#83a598", brightMagenta: "#d3869b", brightCyan: "#8ec07c", brightWhite: "#ebdbb2",
        },
    },
    {
        id: "one-half-dark", name: "One Half Dark", kind: "dark",
        theme: {
            background: "#282c34", foreground: "#dcdfe4", cursor: "#a3b3cc", cursorAccent: "#282c34", selectionBackground: "#474e5d",
            black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#e5c07b", blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#dcdfe4",
            brightBlack: "#5a6374", brightRed: "#e06c75", brightGreen: "#98c379", brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd", brightCyan: "#56b6c2", brightWhite: "#dcdfe4",
        },
    },
    {
        id: "one-half-light", name: "One Half Light", kind: "light",
        theme: {
            background: "#fafafa", foreground: "#383a42", cursor: "#4f525d", cursorAccent: "#fafafa", selectionBackground: "#bfceff",
            black: "#383a42", red: "#e45649", green: "#50a14f", yellow: "#c18401", blue: "#0184bc", magenta: "#a626a4", cyan: "#0997b3", white: "#fafafa",
            brightBlack: "#4f525d", brightRed: "#df6c75", brightGreen: "#98c379", brightYellow: "#e4c07a", brightBlue: "#61afef", brightMagenta: "#c577dd", brightCyan: "#56b5c1", brightWhite: "#ffffff",
        },
    },
    {
        id: "tokyo-night", name: "Tokyo Night", kind: "dark",
        theme: {
            background: "#1a1b26", foreground: "#c0caf5", cursor: "#c0caf5", cursorAccent: "#1a1b26", selectionBackground: "#283457",
            black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68", blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
            brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a", brightYellow: "#e0af68", brightBlue: "#7aa2f7", brightMagenta: "#bb9af7", brightCyan: "#7dcfff", brightWhite: "#c0caf5",
        },
    },
    {
        id: "catppuccin-mocha", name: "Catppuccin Mocha", kind: "dark",
        theme: {
            background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc", cursorAccent: "#1e1e2e", selectionBackground: "#45475a",
            black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af", blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
            brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1", brightYellow: "#f9e2af", brightBlue: "#89b4fa", brightMagenta: "#f5c2e7", brightCyan: "#94e2d5", brightWhite: "#a6adc8",
        },
    },
    {
        id: "catppuccin-latte", name: "Catppuccin Latte", kind: "light",
        theme: {
            background: "#eff1f5", foreground: "#4c4f69", cursor: "#dc8a78", cursorAccent: "#eff1f5", selectionBackground: "#ccd0da",
            black: "#5c5f77", red: "#d20f39", green: "#40a02b", yellow: "#df8e1d", blue: "#1e66f5", magenta: "#ea76cb", cyan: "#179299", white: "#acb0be",
            brightBlack: "#6c6f85", brightRed: "#d20f39", brightGreen: "#40a02b", brightYellow: "#df8e1d", brightBlue: "#1e66f5", brightMagenta: "#ea76cb", brightCyan: "#179299", brightWhite: "#bcc0cc",
        },
    },
];

/** 16 色的固定順序(色票、預覽用)。/ The 16 ANSI colours in order (swatches, preview). */
export const ANSI_KEYS = [
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const satisfies readonly (keyof TerminalPalette)[];

export const TERMINAL_FONT_SIZE_RANGE = { min: 10, max: 24 } as const;

/** 個人預設(永遠有值)。/ The personal default — always complete. */
export interface TerminalDefaults {
    font: string;
    fontSize: number;
    scheme: string;
}

/** 這台裝置的覆寫;null = 跟隨個人預設(與後端的 JSON 同形)。/ Per-device override; null inherits (same shape as the API). */
export interface TerminalProfile {
    font: string | null;
    font_size: number | null;
    scheme: string | null;
}

export const EMPTY_TERMINAL_PROFILE: TerminalProfile = { font: null, font_size: null, scheme: null };

export interface ResolvedTerminalAppearance {
    font: TerminalFont;
    fontSize: number;
    scheme: TerminalScheme;
}

export function isKnownFont(id: unknown): id is string {
    return typeof id === "string" && TERMINAL_FONTS.some((f) => f.id === id);
}

export function isKnownScheme(id: unknown): id is string {
    return typeof id === "string" && TERMINAL_SCHEMES.some((s) => s.id === id);
}

export function terminalFont(id: string | null | undefined): TerminalFont {
    return TERMINAL_FONTS.find((f) => f.id === id) ?? TERMINAL_FONTS.find((f) => f.id === DEFAULT_TERMINAL_FONT)!;
}

export function terminalScheme(id: string | null | undefined): TerminalScheme {
    return TERMINAL_SCHEMES.find((s) => s.id === id) ?? TERMINAL_SCHEMES.find((s) => s.id === DEFAULT_TERMINAL_SCHEME)!;
}

export function clampTerminalFontSize(value: number, fallback: number = 14): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(TERMINAL_FONT_SIZE_RANGE.max, Math.max(TERMINAL_FONT_SIZE_RANGE.min, Math.round(value)));
}

/** 覆寫中「認得」的欄位才算數;不認得的 id / 超出範圍的大小 = 跟隨預設。
 *  Only recognised override fields count; an unknown id or out-of-range size inherits. */
export function resolveTerminalAppearance(defaults: TerminalDefaults, profile: TerminalProfile | null): ResolvedTerminalAppearance {
    const p = profile ?? EMPTY_TERMINAL_PROFILE;
    const fontId = isKnownFont(p.font) ? p.font : defaults.font;
    const schemeId = isKnownScheme(p.scheme) ? p.scheme : defaults.scheme;
    const size = typeof p.font_size === "number"
        && p.font_size >= TERMINAL_FONT_SIZE_RANGE.min && p.font_size <= TERMINAL_FONT_SIZE_RANGE.max
        ? p.font_size
        : defaults.fontSize;
    return { font: terminalFont(fontId), fontSize: clampTerminalFontSize(size), scheme: terminalScheme(schemeId) };
}

export function hasProfileOverride(profile: TerminalProfile | null): boolean {
    return !!profile && (profile.font !== null || profile.font_size !== null || profile.scheme !== null);
}

/** 後端回傳 → TerminalProfile(形狀不對的欄位當成 null)。/ API JSON → TerminalProfile; malformed fields become null. */
export function parseTerminalProfile(data: unknown): TerminalProfile {
    const o = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    return {
        font: typeof o.font === "string" ? o.font : null,
        font_size: typeof o.font_size === "number" ? o.font_size : null,
        scheme: typeof o.scheme === "string" ? o.scheme : null,
    };
}

const FALLBACK_STACK = "ui-monospace, Menlo, Consolas, 'Courier New', monospace";

/**
 * 字型本身的 family(不含後備字型),給 `document.fonts.load()` 用。cssVar 字型(0xProto)要讀 next/font
 * 產生的名稱,所以由呼叫端傳 resolver(getComputedStyle)。
 * The font's own family (no fallbacks), for `document.fonts.load()`. A cssVar font (0xProto) needs the
 * next/font-generated name, which the caller resolves (getComputedStyle) and passes in.
 */
export function terminalFontPrimary(font: TerminalFont, resolveVar?: (name: string) => string): string {
    if (font.cssVar) return resolveVar?.(font.cssVar).trim() || `"${font.family}"`;
    return `"${font.family}"`;
}

/** 給 xterm 的完整 font-family(xterm 量字寬要實際名稱,不能是 var())。/ Full stack for xterm (no var()). */
export function terminalFontFamily(font: TerminalFont, resolveVar?: (name: string) => string): string {
    return `${terminalFontPrimary(font, resolveVar)}, ${FALLBACK_STACK}`;
}

/** 給 CSS style 的 font-family(可以用 var())。/ The font-family for a CSS style (var() is fine here). */
export function terminalFontCss(font: TerminalFont): string {
    return `${font.cssVar ? `var(${font.cssVar})` : `"${font.family}"`}, ${FALLBACK_STACK}`;
}
