/**
 * 登入頁的樣子（網站設定 → 登入）：一般 = 產品介紹；低調 = 只寫 Telepy、動態背景和一句話。這裡是純函式：
 * 解析公開端點 / 快取、低調頁那句話的檢查（跟後端同一套規則）與背景的向日葵點陣座標。
 * How the sign-in pages look (Site settings → Sign-in): standard = product highlights; discreet = only "Telepy", a
 * moving background and one line. Pure helpers: parsing the public endpoint / the cache, the line's limits (same
 * rules as the backend) and the sunflower dot field.
 */
export type SignInStyle = "standard" | "discreet";
/** 哪一頁：一般登入頁 / MCP 應用程式的 OAuth 登入頁。/ Which page: the sign-in page or the OAuth one. */
export type SignInPageKind = "signin" | "oauth";

export interface SignInLook {
    style: SignInStyle;
    oauthStyle: SignInStyle;
    /** 低調頁的那句話；空白 = 輪播內建的句子。/ The discreet page's line; blank = the built-in ones. */
    message: string;
}

export const SIGNIN_STYLES: readonly SignInStyle[] = ["standard", "discreet"];
export const DEFAULT_LOOK: SignInLook = { style: "standard", oauthStyle: "standard", message: "" };
export const MESSAGE_MAX = 200;
export const MESSAGE_LINES = 3;

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

/** 跟後端 `normalize_text` 一樣整理：每行去尾端空白、整段去頭尾空白、換行統一。/ Tidied like the backend's normalize_text. */
export function tidyMessage(raw: string): string {
    return raw
        .split("\n")
        .map((l) => l.replace(/\r$/, "").trimEnd())
        .join("\n")
        .trim();
}

/** 存檔前的檢查（整理過的字）。/ The check before saving (on the tidied text). */
export function messageProblem(raw: string): "tooLong" | "tooManyLines" | null {
    const text = tidyMessage(raw);
    if ([...text].length > MESSAGE_MAX) return "tooLong";
    if (text && text.split("\n").length > MESSAGE_LINES) return "tooManyLines";
    return null;
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
