/**
 * 登入頁的樣子（網站設定 → 登入）：一般 = 產品介紹；低調 = 只寫 Telepy、動態背景和輪流打出來的句子。這裡是純函式：
 * 解析公開端點 / 快取、哪一頁用哪個設定（OAuth 登入頁上要求的是 `telepy` CLI 時用 CLI 那個）、低調頁句子的檢查
 * （跟後端同一套規則）與背景的向日葵點陣座標。
 * How the sign-in pages look (Site settings → Sign-in): standard = product highlights; discreet = only "Telepy", a
 * moving background and lines typed in turn. Pure helpers: parsing the public endpoint / the cache, which setting a
 * page uses (the OAuth page uses the CLI one when the `telepy` CLI is asking), the lines' limits (same rules as the
 * backend) and the sunflower dot field.
 */
import { cliHost } from "./cliClient.ts";

/** 一般 / 低調 / Tapi 版（Tapi 版每一頁有自己的場景，lib/tapiStage `sceneFor`）。/ Standard / discreet / Tapi (each page has its own Tapi scene, lib/tapiStage `sceneFor`). */
export type SignInStyle = "standard" | "discreet" | "tapi";
/**
 * 哪一頁：一般登入頁 / 應用程式（MCP）的 OAuth 登入頁 / `telepy login` 打開的那一頁（同一個 /oauth/login，要求的 app 是 CLI）/
 * 登入後的授權（同意）頁 /oauth/authorize（應用程式與 CLI 共用；CLI 登入完成的那一頁也跟著它）。
 * Which page: the sign-in page, the OAuth page for apps (MCP), the one `telepy login` opens (the same /oauth/login,
 * asked by the CLI), or the approval (consent) page after signing in, /oauth/authorize (apps and the CLI alike; the
 * CLI's "signed in" page follows it too).
 */
export type SignInPageKind = "signin" | "oauth" | "cli" | "consent";

export interface SignInLook {
    style: SignInStyle;
    oauthStyle: SignInStyle;
    cliStyle: SignInStyle;
    /** 授權頁（與 CLI 的完成頁）。/ The approval page (and the CLI's done page). */
    consentStyle: SignInStyle;
    /** 低調頁的句子，一行一句；空白 = 輪播內建的問候語。/ The discreet page's lines, one per line; blank = the built-in ones. */
    message: string;
    /**
     * 生效中的 Google client ID（.env > 網站設定 > 空）；空字串 = 沒有 Google 按鈕；null = 後端沒說（舊後端），用建置時的值。
     * The Google client ID in effect (.env > site setting > ""); "" = no Google button; null = the backend didn't say
     * (an older one), so the build-time value applies.
     */
    googleClientId: string | null;
    /** 網頁與 SSH 各用哪個名稱（PUBLIC_URL 的主機；SSH 主機只在另外設了時），以及正式網址。/ The web / SSH hosts and PUBLIC_URL. */
    webHost: string | null;
    sshHost: string | null;
    publicUrl: string | null;
}

export const SIGNIN_STYLES: readonly SignInStyle[] = ["standard", "discreet", "tapi"];
export const DEFAULT_LOOK: SignInLook = { style: "standard", oauthStyle: "standard", cliStyle: "standard", consentStyle: "standard", message: "", googleClientId: null, webHost: null, sshHost: null, publicUrl: null };
/** 低調頁的句子：最多幾句、每句幾個字（跟後端一樣）。/ How many lines and characters per line (as the backend). */
export const MESSAGE_LINES = 6;
export const LINE_MAX = 80;
/** 整段的上限（永遠不會比逐行的限制先碰到）。/ The whole text (never reached before the per-line limits). */
export const MESSAGE_MAX = MESSAGE_LINES * (LINE_MAX + 1);

const asStyle = (v: unknown): SignInStyle | null => (v === "standard" || v === "discreet" || v === "tapi" ? v : null);

/**
 * 公開端點（`{style, oauth_style, cli_style, consent_style, message}`）或快取（同名的 camelCase）→ SignInLook；
 * 看不懂 = null。沒有 CLI 那個（舊後端、舊快取）= 跟 OAuth 頁一樣；沒有授權頁那個 = 一般，以前就是這樣。
 * The public endpoint's JSON or the cached object → a SignInLook; anything else = null. No CLI look (an older
 * backend or cache) = the OAuth page's, no approval-page look = standard — as they used to be.
 */
export function parseSignInLook(raw: unknown): SignInLook | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const style = asStyle(o.style);
    const oauthStyle = asStyle(o.oauth_style ?? o.oauthStyle);
    if (!style || !oauthStyle) return null;
    const cliStyle = asStyle(o.cli_style ?? o.cliStyle) ?? oauthStyle;
    const consentStyle = asStyle(o.consent_style ?? o.consentStyle) ?? "standard";
    const google = o.google_client_id !== undefined ? o.google_client_id : o.googleClientId;
    return {
        style,
        oauthStyle,
        cliStyle,
        consentStyle,
        message: typeof o.message === "string" ? o.message.slice(0, MESSAGE_MAX * 2) : "",
        googleClientId: typeof google === "string" ? google.trim() : null,
        webHost: str(o.web_host ?? o.webHost),
        sshHost: str(o.ssh_host ?? o.sshHost),
        publicUrl: str(o.public_url ?? o.publicUrl),
    };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().toLowerCase() : null);

/**
 * 這個分頁是不是用 SSH 主機的名稱在看網頁：PUBLIC_URL 有設、SSH 主機有設、兩者不同、而且這裡的主機就是 SSH 主機時才算
 * （跟後端 `ssh_host::arrives_on_ssh_host` 同一條規則；任何一個不成立 = 正常顯示，絕不會把人鎖在外面）。
 * Whether this tab reached the web through the SSH host's name: only when PUBLIC_URL and the SSH host are set, differ,
 * and this page's host is the SSH host (the backend's rule; anything else = show the page, nobody gets locked out).
 */
export function onSshHost(look: SignInLook | null, hostname: string): boolean {
    if (!look || !look.webHost || !look.sshHost || look.sshHost === look.webHost) return false;
    return hostname.trim().toLowerCase().replace(/\.$/, "") === look.sshHost;
}

/** 同一頁在正式網址上的網址（路徑與查詢照搬）。/ The same page at the public URL (path and query kept). */
export function publicPageUrl(look: SignInLook, pathAndQuery: string): string | null {
    if (!look.publicUrl) return null;
    return `${look.publicUrl.replace(/\/+$/, "")}${pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`}`;
}

/**
 * 登入按鈕要用的 Google client ID：還不知道登入頁設定 = 先不畫（undefined）；後端沒給 = 建置時的
 * NEXT_PUBLIC_GOOGLE_CLIENT_ID；空字串 = 沒有 Google 按鈕。
 * The Google client ID for the button: look not known yet = none for now; the backend didn't say = the build-time
 * NEXT_PUBLIC_GOOGLE_CLIENT_ID; an empty string = no Google button.
 */
export function effectiveGoogleClientId(look: SignInLook | null, buildTime: string | undefined): string | undefined {
    if (!look) return undefined;
    const id = look.googleClientId ?? buildTime ?? "";
    return id || undefined;
}

export const styleOf = (look: SignInLook, page: SignInPageKind): SignInStyle =>
    page === "consent" ? look.consentStyle : page === "cli" ? look.cliStyle : page === "oauth" ? look.oauthStyle : look.style;

/** 四頁都用一般樣子（句子只有低調與 Tapi 版會用到）。/ Every page uses the standard look (only the discreet and Tapi looks use the lines). */
export const allStandard = (look: SignInLook) => (["signin", "oauth", "cli", "consent"] as const).every((p) => styleOf(look, p) === "standard");

/** OAuth 登入頁上要求的 app → 用哪一頁的設定。/ The app asking on the OAuth page → which page's setting applies. */
export const pageForClient = (clientName: string | null | undefined): "oauth" | "cli" => (cliHost(clientName) !== null ? "cli" : "oauth");

/**
 * OAuth 登入頁要不要先等「是誰在要求」才畫：兩個設定一樣就不用等（直接畫），不一樣才等預覽回來。
 * Whether the OAuth page must learn who is asking before painting: only when the two settings differ.
 */
export const needsClient = (look: SignInLook) => look.oauthStyle !== look.cliStyle;

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

/** 預覽螢幕最矮的高度（px），也就是還沒量到之前的高度。/ The preview screens' minimum height (px), also used until measured. */
export const PREVIEW_MIN_HEIGHT = 800;
const PREVIEW_STEP = 20;

/**
 * 預覽螢幕（網站設定 → 登入）要多高：四頁裡最高那一頁的內容放得下，所以每一頁都一樣高、也都看得到全部；至少 800，
 * 往上取到 20 的倍數，晚到的字型或多打一個字不會讓外框跳一兩 px。還沒量到 = 最矮的高度。
 * How tall the preview screens (Site settings → Sign-in) are: tall enough for the tallest of the four pages, so every
 * page gets the same height and shows all of its content; at least 800 and rounded up to 20 px, so a late font or one
 * more typed character does not nudge the frames by a pixel or two. Not measured yet = the minimum.
 */
export function previewHeight(measured: number | null | undefined): number {
    if (!measured || !Number.isFinite(measured) || measured <= PREVIEW_MIN_HEIGHT) return PREVIEW_MIN_HEIGHT;
    return Math.ceil(measured / PREVIEW_STEP) * PREVIEW_STEP;
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
