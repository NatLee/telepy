/**
 * MCP 應用程式連接（OAuth）流程的純函式：哪個登入頁、同意頁的 URL、隧道搜尋與日期顯示。
 * 一般登入是 /login；從同意頁（/oauth/authorize）來的登入走 /oauth/login，畫面講的是「有個 app 要連你的帳號」，
 * 兩個才不會搞混。
 * Pure helpers for the app-connection (OAuth) flow: which sign-in page, the consent URL, tunnel search.
 * A normal sign-in is /login; one that comes from the consent page goes to /oauth/login, which is about the
 * app asking to connect, so the two are never confused.
 */

export const OAUTH_AUTHORIZE_PATH = "/oauth/authorize";
export const OAUTH_LOGIN_PATH = "/oauth/login";

/** 站內路徑才算數（跟 safeNextPath 同一條規則）。/ Same-origin paths only (the safeNextPath rule). */
export function isSafePath(path: string | null | undefined): path is string {
    return !!path && path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
}

/** 這個 next 是同意頁嗎？/ Is this `next` the consent page? */
export function isAuthorizePath(path: string | null | undefined): path is string {
    if (!isSafePath(path)) return false;
    const pathname = path.split(/[?#]/, 1)[0];
    return pathname === OAUTH_AUTHORIZE_PATH || pathname === `${OAUTH_AUTHORIZE_PATH}/`;
}

/** 同意頁 URL 的查詢字串（授權請求本身）；不是同意頁 → null。/ The authorization request inside a consent URL. */
export function authorizeQuery(path: string | null | undefined): string | null {
    if (!isAuthorizePath(path)) return null;
    const q = path.indexOf("?");
    if (q < 0) return "";
    return path.slice(q + 1).split("#", 1)[0];
}

/**
 * 登入頁網址：要回同意頁的走 OAuth 登入頁，其他走一般登入頁；沒有 next 就是一般登入頁。
 * The sign-in URL: OAuth sign-in for the consent page, the normal one otherwise.
 */
export function loginPathFor(next?: string | null): string {
    if (!isSafePath(next)) return "/login";
    const base = isAuthorizePath(next) ? OAUTH_LOGIN_PATH : "/login";
    return `${base}?next=${encodeURIComponent(next)}`;
}

/** 隧道清單的搜尋：名稱不分大小寫的子字串，空白隔開的每個字都要符合。/ Every word must appear in the name. */
export function matchesTunnel(name: string, query: string): boolean {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = name.toLowerCase();
    return words.every((w) => hay.includes(w));
}

/** 這麼多條以上才顯示隧道搜尋框。/ Show the tunnel search from this many tunnels. */
export const TUNNEL_SEARCH_FROM = 7;
