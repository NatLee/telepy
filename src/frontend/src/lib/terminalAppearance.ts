/**
 * 網頁終端機外觀:可選的字型(Nerd Font Mono)與配色、粗體的畫法、連字,以及「個人預設 + 這台裝置的覆寫」
 * 的合成規則。純資料與純函式,不碰 DOM / localStorage(那些在 lib/userPrefs.ts 與 hooks/useTerminalAppearance.ts)。
 * 後端只存 id(`/api/user/settings` 的 terminal_*,與 `/api/reverse/server/{id}/terminal-profile`),不認得的 id
 * 一律回到預設,所以從清單拿掉一項(或刪掉一個自訂配色)不會壞。自訂配色(lib/terminalSchemes.ts)由呼叫端傳進
 * 查表函式,內建清單之外的 id 才會在那裡找到。
 * Web-terminal appearance: the font (Nerd Font Mono) and colour-scheme catalogue, the bold style and
 * ligatures, plus the rule that merges the personal default with a per-device override. Pure data and
 * functions; storage lives in lib/userPrefs.ts and hooks/useTerminalAppearance.ts. The backend stores ids
 * only, and an unknown id falls back to the default, so removing an entry (or deleting a custom scheme)
 * never breaks a saved setting. Custom schemes (lib/terminalSchemes.ts) are passed into the lookups.
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
    /** 有的真實字體(terminal-fonts.css / layout.tsx 宣告的);沒有的由瀏覽器合成。/ Real faces shipped; the rest is synthesised. */
    faces: TerminalFace[];
    /** 字型本身有程式連字(calt)。/ The font has programming ligatures (calt). */
    ligatures: boolean;
}

export type TerminalFace = "bold" | "italic" | "boldItalic";

/**
 * 粗體的畫法:face = 真正的粗體字(預設)、bright = 經典終端機只把顏色換成亮色、both = 兩者都要。
 * How bold text is drawn: the real bold face (default), the classic brighter colour only, or both.
 */
export type TerminalBold = "face" | "bright" | "both";
export const BOLD_STYLES: TerminalBold[] = ["face", "bright", "both"];
export const DEFAULT_TERMINAL_BOLD: TerminalBold = "face";

export function isBoldStyle(v: unknown): v is TerminalBold {
    return typeof v === "string" && (BOLD_STYLES as string[]).includes(v);
}

/** xterm 的粗體相關選項。/ xterm's bold-related options for a bold style. */
export function xtermBoldOptions(bold: TerminalBold): { fontWeight: number; fontWeightBold: number; drawBoldTextInBrightColors: boolean } {
    return { fontWeight: 400, fontWeightBold: bold === "bright" ? 400 : 700, drawBoldTextInBrightColors: bold !== "face" };
}

/** xterm.js 的 ITheme 子集(16 色 + 前景 / 背景 / 游標 / 選取)。/ The ITheme subset xterm.js uses here. */
export interface TerminalPalette {
    background: string;
    foreground: string;
    cursor: string;
    cursorAccent: string;
    selectionBackground: string;
    selectionForeground?: string;
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
    /** 使用者自訂的(lib/terminalSchemes.ts)。/ A user-defined scheme. */
    custom?: boolean;
}

export const DEFAULT_TERMINAL_FONT = "hack";
export const DEFAULT_TERMINAL_SCHEME = "telepy";

const ALL_FACES: TerminalFace[] = ["bold", "italic", "boldItalic"];

// faces / ligatures 要跟 terminal-fonts.css(0xProto:layout.tsx)與 src/fonts/terminal/README.md 一致:
// Fira Code 沒有斜體、0xProto 沒有粗斜體,Hack 與 Meslo 沒有連字。
// Keep faces / ligatures in sync with terminal-fonts.css (0xProto: layout.tsx) and src/fonts/terminal/README.md:
// Fira Code has no italic, 0xProto no bold italic; Hack and Meslo have no ligatures.
export const TERMINAL_FONTS: TerminalFont[] = [
    { id: "hack", name: "Hack", family: "Hack Nerd Font Mono", note: "terminal.fontNoteHack", faces: ALL_FACES, ligatures: false },
    { id: "jetbrains-mono", name: "JetBrains Mono", family: "JetBrainsMono NFM", note: "terminal.fontNoteJetbrains", faces: ALL_FACES, ligatures: true },
    { id: "fira-code", name: "Fira Code", family: "FiraCode Nerd Font Mono", note: "terminal.fontNoteFira", faces: ["bold"], ligatures: true },
    { id: "cascadia-code", name: "Cascadia Code", family: "CaskaydiaCove NFM", note: "terminal.fontNoteCascadia", faces: ALL_FACES, ligatures: true },
    { id: "meslo", name: "Meslo LGS", family: "MesloLGS Nerd Font Mono", note: "terminal.fontNoteMeslo", faces: ALL_FACES, ligatures: false },
    { id: "0xproto", name: "0xProto", family: "0xProto Nerd Font", cssVar: "--font-0xproto", note: "terminal.fontNoteProto", faces: ["bold", "italic"], ligatures: true },
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
    bold: TerminalBold;
    ligatures: boolean;
}

/** 這台裝置的覆寫;null = 跟隨個人預設(與後端的 JSON 同形)。/ Per-device override; null inherits (same shape as the API). */
export interface TerminalProfile {
    font: string | null;
    font_size: number | null;
    scheme: string | null;
    bold: string | null;
    ligatures: boolean | null;
}

export const EMPTY_TERMINAL_PROFILE: TerminalProfile = { font: null, font_size: null, scheme: null, bold: null, ligatures: null };

export interface ResolvedTerminalAppearance {
    font: TerminalFont;
    fontSize: number;
    scheme: TerminalScheme;
    bold: TerminalBold;
    /** 已經考慮字型有沒有連字:沒有的字型永遠 false。/ Already gated by the font: false for fonts without ligatures. */
    ligatures: boolean;
}

/** id 的形狀(與後端 `is_choice_id` 相同):內建或自訂配色的 id 都長這樣。/ The id shape (the backend's rule). */
export function isSchemeId(id: unknown): id is string {
    return typeof id === "string" && /^[a-z0-9-]{1,32}$/.test(id);
}

export function isKnownFont(id: unknown): id is string {
    return typeof id === "string" && TERMINAL_FONTS.some((f) => f.id === id);
}

/** 內建或(給了清單時)自訂配色裡認得的 id。/ A built-in id, or a custom one when the list is given. */
export function isKnownScheme(id: unknown, custom: readonly TerminalScheme[] = []): id is string {
    return typeof id === "string" && (TERMINAL_SCHEMES.some((s) => s.id === id) || custom.some((s) => s.id === id));
}

export function terminalFont(id: string | null | undefined): TerminalFont {
    return TERMINAL_FONTS.find((f) => f.id === id) ?? TERMINAL_FONTS.find((f) => f.id === DEFAULT_TERMINAL_FONT)!;
}

/** 先找內建、再找自訂;都沒有就回預設配色(刪掉的自訂配色就是這樣回到預設)。/ Built-ins, then custom, else the default. */
export function terminalScheme(id: string | null | undefined, custom: readonly TerminalScheme[] = []): TerminalScheme {
    return TERMINAL_SCHEMES.find((s) => s.id === id) ?? custom.find((s) => s.id === id) ?? TERMINAL_SCHEMES.find((s) => s.id === DEFAULT_TERMINAL_SCHEME)!;
}

export function clampTerminalFontSize(value: number, fallback: number = 14): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(TERMINAL_FONT_SIZE_RANGE.max, Math.max(TERMINAL_FONT_SIZE_RANGE.min, Math.round(value)));
}

/** 哪一層給了這個值。/ Which layer supplied a value. */
export type AppearanceSource = "default" | "device";

export interface EffectiveField<T> {
    value: T;
    from: AppearanceSource;
}

/**
 * 每一項的值與來源:覆寫裡「認得」的欄位才算數;不認得的 id(拿掉的字型、刪掉的自訂配色)/ 超出範圍的大小 = 跟隨預設。
 * 連字還要字型有才算開(來源仍照設定算,外觀圖才能說「字型沒有連字」)。
 * Every field's value and where it came from: only recognised override fields count; an unknown id (a removed
 * font, a deleted custom scheme) or an out-of-range size inherits. Ligatures also need a font that has them
 * (the source still follows the setting so the layers diagram can say "this font has none").
 */
export function effectiveAppearance(defaults: TerminalDefaults, profile: TerminalProfile | null, custom: readonly TerminalScheme[] = []): {
    font: EffectiveField<TerminalFont>;
    fontSize: EffectiveField<number>;
    scheme: EffectiveField<TerminalScheme>;
    bold: EffectiveField<TerminalBold>;
    ligatures: EffectiveField<boolean>;
} {
    const p = profile ?? EMPTY_TERMINAL_PROFILE;
    const fontFromDevice = isKnownFont(p.font);
    const schemeFromDevice = isKnownScheme(p.scheme, custom);
    const sizeFromDevice = typeof p.font_size === "number" && p.font_size >= TERMINAL_FONT_SIZE_RANGE.min && p.font_size <= TERMINAL_FONT_SIZE_RANGE.max;
    const boldFromDevice = isBoldStyle(p.bold);
    const ligaturesFromDevice = typeof p.ligatures === "boolean";
    const font = terminalFont(fontFromDevice ? p.font : defaults.font);
    const ligatures = ligaturesFromDevice ? p.ligatures! : defaults.ligatures;
    return {
        font: { value: font, from: fontFromDevice ? "device" : "default" },
        fontSize: { value: clampTerminalFontSize(sizeFromDevice ? p.font_size! : defaults.fontSize), from: sizeFromDevice ? "device" : "default" },
        scheme: { value: terminalScheme(schemeFromDevice ? p.scheme : defaults.scheme, custom), from: schemeFromDevice ? "device" : "default" },
        bold: { value: boldFromDevice ? (p.bold as TerminalBold) : defaults.bold, from: boldFromDevice ? "device" : "default" },
        ligatures: { value: font.ligatures && ligatures, from: ligaturesFromDevice ? "device" : "default" },
    };
}

/** 終端機實際要用的外觀(effectiveAppearance 去掉來源)。/ What the terminal uses (effectiveAppearance without the sources). */
export function resolveTerminalAppearance(defaults: TerminalDefaults, profile: TerminalProfile | null, custom: readonly TerminalScheme[] = []): ResolvedTerminalAppearance {
    const e = effectiveAppearance(defaults, profile, custom);
    return { font: e.font.value, fontSize: e.fontSize.value, scheme: e.scheme.value, bold: e.bold.value, ligatures: e.ligatures.value };
}

export function hasProfileOverride(profile: TerminalProfile | null): boolean {
    return !!profile && (profile.font !== null || profile.font_size !== null || profile.scheme !== null || profile.bold !== null || profile.ligatures !== null);
}

/** 後端回傳 → TerminalProfile(形狀不對的欄位當成 null)。/ API JSON → TerminalProfile; malformed fields become null. */
export function parseTerminalProfile(data: unknown): TerminalProfile {
    const o = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    return {
        font: typeof o.font === "string" ? o.font : null,
        font_size: typeof o.font_size === "number" ? o.font_size : null,
        scheme: typeof o.scheme === "string" ? o.scheme : null,
        bold: typeof o.bold === "string" ? o.bold : null,
        ligatures: typeof o.ligatures === "boolean" ? o.ligatures : null,
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
