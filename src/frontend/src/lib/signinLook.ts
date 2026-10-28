/**
 * 登入頁的樣子（網站設定 → 登入）：一般 = 產品介紹；低調 = 只寫 Telepy、動態背景和輪流打出來的句子。這裡是純函式：
 * 解析公開端點 / 快取、低調頁句子的檢查（跟後端同一套規則）與背景的向日葵點陣座標。
 * How the sign-in pages look (Site settings → Sign-in): standard = product highlights; discreet = only "Telepy", a
 * moving background and lines typed in turn. Pure helpers: parsing the public endpoint / the cache, the lines'
 * limits (same rules as the backend) and the sunflower dot field.
 */
export type SignInStyle = "standard" | "discreet";
/** 哪一頁：一般登入頁 / MCP 應用程式的 OAuth 登入頁。/ Which page: the sign-in page or the OAuth one. */
export type SignInPageKind = "signin" | "oauth";

export interface SignInLook {
    style: SignInStyle;
    oauthStyle: SignInStyle;
    /** 低調頁的句子，一行一句；空白 = 輪播內建的問候語。/ The discreet page's lines, one per line; blank = the built-in ones. */
    message: string;
}

export const SIGNIN_STYLES: readonly SignInStyle[] = ["standard", "discreet"];
export const DEFAULT_LOOK: SignInLook = { style: "standard", oauthStyle: "standard", message: "" };
/** 低調頁的句子：最多幾句、每句幾個字（跟後端一樣）。/ How many lines and characters per line (as the backend). */
export const MESSAGE_LINES = 6;
export const LINE_MAX = 80;
/** 整段的上限（永遠不會比逐行的限制先碰到）。/ The whole text (never reached before the per-line limits). */
export const MESSAGE_MAX = MESSAGE_LINES * (LINE_MAX + 1);

const asStyle = (v: unknown): SignInStyle | null => (v === "standard" || v === "discreet" ? v : null);

/**
 * 公開端點（`{style, oauth_style, message}`）或快取（`{style, oauthStyle, message}`）→ SignInLook；看不懂 = null。
 * The public endpoint's JSON or the cached object → a SignInLook; anything else = null.
 */
export function parseSignInLook(raw: unknown): SignInLook | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const style = asStyle(o.style);
    const oauthStyle = asStyle(o.oauth_style ?? o.oauthStyle);
    if (!style || !oauthStyle) return null;
    return { style, oauthStyle, message: typeof o.message === "string" ? o.message.slice(0, MESSAGE_MAX * 2) : "" };
}

export const styleOf = (look: SignInLook, page: SignInPageKind): SignInStyle => (page === "oauth" ? look.oauthStyle : look.style);

/** 一句有幾個字（Unicode 碼位，跟後端的 chars().count() 一樣）。/ Characters in a line, counted like the backend. */
export const lineLength = (line: string) => [...line.trim()].length;

/**
 * 存好的文字 → 句子：一行一句、去頭尾空白、空行拿掉。空陣列 = 用內建的問候語。
 * The stored text → its lines: one per line, trimmed, blank lines dropped. Empty = the built-in greetings.
 */
export function messageLines(message: string): string[] {
    return message
        .split("\n")
        .map((l) => l.replace(/\r$/, "").trim())
        .filter(Boolean);
}

/** 編輯中的幾列 → 要存的文字（跟後端 `normalize_text` 一樣整理）。/ Editor rows → the text to save (tidied like the backend). */
export const joinLines = (rows: string[]) => messageLines(rows.join("\n")).join("\n");

/** 跟後端一樣整理一段文字。/ Tidy a text the way the backend does. */
export const tidyMessage = (raw: string) => joinLines([raw]);

/** 存檔前的檢查（整理過的字）。/ The check before saving (on the tidied text). */
export function messageProblem(raw: string): "tooLong" | "tooManyLines" | null {
    const lines = messageLines(raw);
    if (lines.length > MESSAGE_LINES) return "tooManyLines";
    if (lines.some((l) => lineLength(l) > LINE_MAX)) return "tooLong";
    return null;
}

/* ── 編輯句子的列（網站設定）。/ Editing the lines as rows (site settings). ── */

/** 編輯後要把焦點放在哪一列、游標在第幾個字（UTF-16，跟 input 的 selection 一樣）。/ Where focus and the caret go next. */
export interface RowEdit {
    rows: string[];
    focus: number;
    caret: number;
    /** 放不下而沒加進來的列數。/ Rows left out because the list was full. */
    dropped: number;
}

/**
 * 在第 `i` 列的選取範圍貼上（或按 Enter = 貼上一個換行）：跟文字編輯器一樣，換行把這列切開，多的每行各成一列，
 * 原本游標後面的字接在最後一段後面；最多 MESSAGE_LINES 列，放不下的段落不加。
 * Paste into row `i`'s selection (Enter = pasting a newline): like a text editor, newlines split the row, each extra
 * line becomes a row and the text after the caret follows the last piece; at most MESSAGE_LINES rows, extra pieces
 * are left out.
 */
export function pasteRows(rows: string[], i: number, start: number, end: number, pasted: string): RowEdit {
    const value = rows[i] ?? "";
    const parts = pasted.replace(/\r/g, "").split("\n");
    const room = Math.max(1, MESSAGE_LINES - rows.length + 1);
    const kept = parts.slice(0, room);
    const head = value.slice(0, start);
    const tail = value.slice(end);
    kept[0] = head + kept[0];
    const last = kept.length - 1;
    const caret = kept[last].length;
    kept[last] += tail;
    return { rows: [...rows.slice(0, i), ...kept, ...rows.slice(i + 1)], focus: i + last, caret, dropped: parts.length - kept.length };
}

/** 在第 `i` 列開頭按 Backspace：接到上一列後面。/ Backspace at the start of row `i`: join it onto the row above. */
export function mergeUp(rows: string[], i: number): RowEdit | null {
    if (i <= 0 || i >= rows.length) return null;
    const above = rows[i - 1];
    return { rows: [...rows.slice(0, i - 1), above + rows[i], ...rows.slice(i + 1)], focus: i - 1, caret: above.length, dropped: 0 };
}

/** 拿掉一列（至少留一列空的）。/ Remove a row (one empty row always stays). */
export function removeRow(rows: string[], i: number): string[] {
    const next = rows.filter((_, k) => k !== i);
    return next.length ? next : [""];
}

/** 把一列往上 / 下移一格。/ Move a row up (-1) or down (+1). */
export function moveRow(rows: string[], i: number, by: -1 | 1): string[] {
    const j = i + by;
    if (i < 0 || i >= rows.length || j < 0 || j >= rows.length) return rows;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
}

/**
 * 正在編輯第 `row` 列時，預覽要釘住哪一句：空白的列不算（存的時候會拿掉），空白列本身 = 不釘。
 * Which line the preview pins while row `row` is edited: blank rows don't count (they are dropped on save), and a
 * blank row pins nothing.
 */
export function pinnedLine(rows: string[], row: number | null): number | null {
    if (row === null || !rows[row]?.trim()) return null;
    return rows.slice(0, row).filter((r) => r.trim()).length;
}

export interface SunflowerDot {
    /** 相對中心的座標（px）。/ Offset from the centre in px. */
    x: number;
    y: number;
    /** 離中心多遠，0 = 中心、1 = 最外圈。/ Distance from the centre, 0 = centre, 1 = the rim. */
    t: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * 向日葵（費馬螺旋）點陣：第 i 點在半徑 R·√(i/n)、角度 i × 黃金角。座標取到 0.1 px，伺服器與瀏覽器算出一樣的字串。
 * A sunflower (Fermat spiral) field: dot i sits at radius R·√(i/n) and angle i × the golden angle. Rounded to 0.1 px
 * so the server and the browser render the same strings.
 */
export function sunflower(count: number, radius: number): SunflowerDot[] {
    const n = Math.max(0, Math.floor(count));
    const round = (v: number) => Math.round(v * 10) / 10 || 0;
    return Array.from({ length: n }, (_, i) => {
        const t = n <= 1 ? 0 : Math.sqrt(i / (n - 1));
        const a = i * GOLDEN_ANGLE;
        return { x: round(Math.cos(a) * t * radius), y: round(Math.sin(a) * t * radius), t: Math.round(t * 1000) / 1000 };
    });
}
