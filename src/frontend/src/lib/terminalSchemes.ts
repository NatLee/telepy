/**
 * 使用者自訂的終端機配色(`/api/user/terminal-schemes`)的純函式:API 的形狀、轉成 TerminalScheme、
 * 以及匯入 Windows Terminal 的 scheme JSON 與 base16 YAML。不碰網路 / DOM(hooks/useTerminalSchemes.ts 負責)。
 * Pure helpers for user-defined terminal schemes: the API shape, conversion to a TerminalScheme, and
 * importers for Windows Terminal scheme JSON and base16 YAML. No network / DOM (hooks/useTerminalSchemes.ts).
 */
import { ANSI_KEYS, DEFAULT_TERMINAL_SCHEME, TERMINAL_SCHEMES, type TerminalPalette, type TerminalScheme } from "./terminalAppearance.ts";

/** 後端存的顏色(與 api/terminal_schemes.rs 的 `validate_colors` 同形)。/ The stored colours (the backend's `validate_colors` shape). */
export type SchemeColors = Omit<TerminalPalette, "cursorAccent" | "selectionForeground"> & {
    cursorAccent?: string;
    selectionForeground?: string;
};

export interface CustomScheme {
    id: string;
    name: string;
    colors: SchemeColors;
    created_at?: string;
    updated_at?: string;
}

export const SCHEME_NAME_MAX = 40;
export const MAX_CUSTOM_SCHEMES = 20;

/** 必填的顏色鍵(順序 = 編輯器的順序)。/ Required colour keys, in editor order. */
export const BASE_COLOR_KEYS = ["foreground", "background", "cursor", "selectionBackground"] as const satisfies readonly (keyof SchemeColors)[];
export const OPTIONAL_COLOR_KEYS = ["cursorAccent", "selectionForeground"] as const satisfies readonly (keyof SchemeColors)[];

export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function isHexColor(v: unknown): v is string {
    return typeof v === "string" && HEX_COLOR.test(v);
}

/** `#RGB` / `#RRGGBB` / `RRGGBB`(任意大小寫)→ `#rrggbb`;不是顏色 → null。/ Normalise a hex colour. */
export function normalizeHex(v: unknown): string | null {
    if (typeof v !== "string") return null;
    let s = v.trim();
    if (s.startsWith("#")) s = s.slice(1);
    if (/^[0-9a-f]{3}$/i.test(s)) s = s.split("").map((c) => c + c).join("");
    return /^[0-9a-f]{6}$/i.test(s) ? `#${s.toLowerCase()}` : null;
}

export function isCustomSchemeId(id: unknown): id is string {
    return typeof id === "string" && id.startsWith("custom-");
}

/** 相對亮度(sRGB),判斷淺 / 深色配色用。/ Relative luminance, to call a scheme light or dark. */
export function luminance(hex: string): number {
    const n = parseInt(hex.slice(1), 16);
    const ch = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

export function schemeKind(background: string): "dark" | "light" {
    return luminance(background) > 0.4 ? "light" : "dark";
}

/** 後端的 colors → xterm 用的 TerminalScheme(cursorAccent 缺省 = 背景色)。/ API colours → TerminalScheme (cursorAccent defaults to the background). */
export function customToScheme(c: CustomScheme): TerminalScheme {
    const theme: TerminalPalette = {
        ...c.colors,
        cursorAccent: c.colors.cursorAccent ?? c.colors.background,
    };
    if (!c.colors.selectionForeground) delete theme.selectionForeground;
    return { id: c.id, name: c.name, kind: schemeKind(c.colors.background), theme, custom: true };
}

/** 內建 / 自訂配色 → 編輯器的起點(「從目前的配色開始」)。/ A scheme → the editor's starting colours. */
export function colorsFromScheme(scheme: TerminalScheme): SchemeColors {
    const t = scheme.theme;
    const out: SchemeColors = {
        foreground: t.foreground, background: t.background, cursor: t.cursor, selectionBackground: t.selectionBackground,
        black: t.black, red: t.red, green: t.green, yellow: t.yellow, blue: t.blue, magenta: t.magenta, cyan: t.cyan, white: t.white,
        brightBlack: t.brightBlack, brightRed: t.brightRed, brightGreen: t.brightGreen, brightYellow: t.brightYellow,
        brightBlue: t.brightBlue, brightMagenta: t.brightMagenta, brightCyan: t.brightCyan, brightWhite: t.brightWhite,
    };
    if (t.cursorAccent && t.cursorAccent !== t.background) out.cursorAccent = t.cursorAccent;
    if (t.selectionForeground) out.selectionForeground = t.selectionForeground;
    return out;
}

export function defaultSchemeColors(): SchemeColors {
    return colorsFromScheme(TERMINAL_SCHEMES.find((s) => s.id === DEFAULT_TERMINAL_SCHEME)!);
}

/** 後端回傳 → CustomScheme[](形狀不對的項目略過)。/ API list → CustomScheme[]; malformed entries are skipped. */
export function parseCustomSchemes(data: unknown): CustomScheme[] {
    if (!Array.isArray(data)) return [];
    const out: CustomScheme[] = [];
    for (const item of data) {
        const o = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        const colors = validateColors(o.colors);
        if (typeof o.id === "string" && typeof o.name === "string" && colors.ok) {
            out.push({ id: o.id, name: o.name, colors: colors.colors, created_at: typeof o.created_at === "string" ? o.created_at : undefined, updated_at: typeof o.updated_at === "string" ? o.updated_at : undefined });
        }
    }
    return out;
}

export type ColorsCheck = { ok: true; colors: SchemeColors } | { ok: false; missing: string[]; bad: string[] };

/** 檢查一組顏色(編輯器送出前、匯入後)。/ Check a colour set (before saving, after importing). */
export function validateColors(v: unknown): ColorsCheck {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const missing: string[] = [];
    const bad: string[] = [];
    const out: Record<string, string> = {};
    for (const k of [...BASE_COLOR_KEYS, ...ANSI_KEYS]) {
        const c = normalizeHex(o[k]);
        if (o[k] === undefined || o[k] === null || o[k] === "") missing.push(k);
        else if (!c) bad.push(k);
        else out[k] = c;
    }
    for (const k of OPTIONAL_COLOR_KEYS) {
        if (o[k] === undefined || o[k] === null || o[k] === "") continue;
        const c = normalizeHex(o[k]);
        if (c) out[k] = c;
        else bad.push(k);
    }
    return missing.length || bad.length ? { ok: false, missing, bad } : { ok: true, colors: out as unknown as SchemeColors };
}

// ---------------------------------------------------------------- importers

export type ImportFormat = "windows-terminal" | "base16";

export type ImportResult =
    | { ok: true; format: ImportFormat; name: string | null; colors: SchemeColors }
    | { ok: false; format: ImportFormat | null; reason: "empty" | "unrecognised" | "incomplete"; missing?: string[] };

/** Windows Terminal 的 scheme 鍵 → 我們的鍵(16 色同名)。/ Windows Terminal scheme keys → ours (the 16 colours share names). */
const WT_KEYS: Record<string, keyof SchemeColors> = {
    foreground: "foreground",
    background: "background",
    cursorColor: "cursor",
    selectionBackground: "selectionBackground",
    purple: "magenta",
    brightPurple: "brightMagenta",
};

/**
 * Windows Terminal 的 scheme JSON(settings.json 裡 `schemes` 的一項,或整個 settings.json 的第一個 scheme)。
 * `purple` = magenta;`cursorColor` = 游標。/ A Windows Terminal scheme object (or a settings.json: its first scheme).
 */
export function parseWindowsTerminalScheme(text: string): ImportResult {
    let data: unknown;
    try { data = JSON.parse(text); } catch { return { ok: false, format: null, reason: "unrecognised" }; }
    let o = (data && typeof data === "object" ? data : null) as Record<string, unknown> | null;
    if (o && Array.isArray(o.schemes) && o.schemes.length) o = o.schemes[0] as Record<string, unknown>;
    if (!o || typeof o !== "object") return { ok: false, format: null, reason: "unrecognised" };
    const raw: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
        const key = WT_KEYS[k] ?? ((ANSI_KEYS as readonly string[]).includes(k) ? (k as keyof SchemeColors) : null);
        if (key) raw[key] = v;
    }
    // WT 自己不一定有 selectionBackground:用 brightBlack 代。/ WT may omit selectionBackground: use brightBlack.
    if (raw.selectionBackground === undefined && raw.brightBlack !== undefined) raw.selectionBackground = raw.brightBlack;
    if (raw.cursor === undefined && raw.foreground !== undefined) raw.cursor = raw.foreground;
    if (Object.keys(raw).length < 4) return { ok: false, format: null, reason: "unrecognised" };
    const check = validateColors(raw);
    if (!check.ok) return { ok: false, format: "windows-terminal", reason: "incomplete", missing: [...check.missing, ...check.bad] };
    return { ok: true, format: "windows-terminal", name: typeof o.name === "string" ? o.name.trim().slice(0, SCHEME_NAME_MAX) || null : null, colors: check.colors };
}

/**
 * base16 YAML(`base00: "#…"` … `base0F`,`scheme:` / `name:` 是名稱)→ ANSI,照 base16 範本的慣例:
 * black 00 / red 08 / green 0B / yellow 0A / blue 0D / magenta 0E / cyan 0C / white 05,bright: black 03、
 * white 07、其餘與一般色相同;前景 05、背景 00、游標 05、選取 02。
 * base16 YAML → ANSI the way the base16 templates (alacritty / Windows Terminal) do it.
 */
export function parseBase16(text: string): ImportResult {
    const bases: Record<string, string> = {};
    let name: string | null = null;
    for (const line of text.split(/\r?\n/)) {
        const m = /^\s*(?:"?(base0[0-9A-Fa-f])"?|scheme|name)\s*:\s*(.+?)\s*$/.exec(line);
        if (!m) continue;
        const value = m[2].replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "").trim();
        if (m[1]) {
            const c = normalizeHex(value);
            if (c) bases[m[1].toUpperCase()] = c;
        } else if (!name && value) {
            name = value.slice(0, SCHEME_NAME_MAX);
        }
    }
    const got = Object.keys(bases).length;
    if (got === 0) return { ok: false, format: null, reason: "unrecognised" };
    if (got < 16) {
        const missing = Array.from({ length: 16 }, (_, i) => `base0${i.toString(16).toUpperCase()}`).filter((k) => !bases[k.toUpperCase()]);
        return { ok: false, format: "base16", reason: "incomplete", missing };
    }
    const b = (k: string) => bases[`BASE0${k}`];
    return {
        ok: true,
        format: "base16",
        name,
        colors: {
            foreground: b("5"), background: b("0"), cursor: b("5"), selectionBackground: b("2"),
            black: b("0"), red: b("8"), green: b("B"), yellow: b("A"), blue: b("D"), magenta: b("E"), cyan: b("C"), white: b("5"),
            brightBlack: b("3"), brightRed: b("8"), brightGreen: b("B"), brightYellow: b("A"), brightBlue: b("D"), brightMagenta: b("E"), brightCyan: b("C"), brightWhite: b("7"),
        },
    };
}

/** 自動辨識:`{` 開頭當 JSON,否則試 base16。/ Detect the format: JSON when it starts with `{`, otherwise base16. */
export function parseSchemeImport(text: string): ImportResult {
    const t = text.trim();
    if (!t) return { ok: false, format: null, reason: "empty" };
    if (t.startsWith("{")) return parseWindowsTerminalScheme(t);
    return parseBase16(t);
}

/** 匯出成 Windows Terminal 的 scheme JSON(可貼回 settings.json)。/ Export as a Windows Terminal scheme object. */
export function toWindowsTerminalJson(name: string, c: SchemeColors): string {
    const out: Record<string, string> = { name, foreground: c.foreground, background: c.background, cursorColor: c.cursor, selectionBackground: c.selectionBackground };
    for (const k of ANSI_KEYS) out[k === "magenta" ? "purple" : k === "brightMagenta" ? "brightPurple" : k] = c[k];
    return JSON.stringify(out, null, 2);
}
