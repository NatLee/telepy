/**
 * 登入 session 的純函式：讀 access token 的時間、算什麼時候該在背景續期、哪些 401 不該拿去續期。
 * Pure helpers for the sign-in session: the access token's times, when to renew it in the background and
 * which 401s must not trigger a renewal.
 *
 * 後端每次續期都換發新的 refresh token（舊的只在 60 秒寬限內還能用），所以續期一律走 lib/api 的
 * refreshSession（單飛 + 跨分頁鎖）；這裡只放不碰 window 的計算，方便測試。
 * The backend rotates the refresh token on every renewal (the old one works for a 60-second grace only), so
 * renewals always go through lib/api's refreshSession (single flight + cross-tab lock); only window-free
 * calculations live here, so they can be tested.
 */

/** 到期前多久換新（上限；短效 token 用壽命的一半）。/ How long before expiry to renew (capped at half the lifetime). */
export const REFRESH_LEAD_MS = 2 * 60_000;
/** 排程續期的最短等待。/ The shortest wait before a scheduled renewal. */
export const MIN_REFRESH_DELAY_MS = 5_000;
/** 讀不出到期時間時多久試一次。/ Retry cadence when the expiry cannot be read. */
export const UNKNOWN_EXPIRY_DELAY_MS = 15 * 60_000;
/** 續期沒連上伺服器時多久再試。/ Retry delay after a renewal could not reach the server. */
export const RETRY_DELAY_MS = 60_000;

/**
 * 這些端點的 401 是「登入本身失敗」（帳密錯、token 本來就無效），不是 access token 過期，不該拿去續期。
 * A 401 from these endpoints means the login itself failed, not an expired access token: never renew for them.
 */
export const NO_REFRESH_PATHS = [
    "/api/auth/token",
    "/api/auth/token/refresh",
    "/api/auth/token/verify",
    "/api/auth/logout",
    "/api/auth/register",
    "/api/auth/google/token",
    "/api/auth/mfa/verify",
    "/api/auth/passkey/options",
    "/api/auth/passkey/login",
];

export interface TokenTimes {
    /** 到期（毫秒）。/ Expiry in ms since the epoch. */
    exp: number;
    /** 簽發（毫秒）；沒有就 null。/ Issued-at in ms, or null when absent. */
    iat: number | null;
}

function decodeBase64Url(s: string): string {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** JWT payload 的 exp / iat；不是 JWT 或沒有 exp → null。不驗簽（那是伺服器的事）。
 *  The JWT payload's exp / iat; null when it is not a JWT or has no exp. No signature check (the server's job). */
export function tokenTimes(token: string | null | undefined): TokenTimes | null {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(decodeBase64Url(parts[1])) as { exp?: unknown; iat?: unknown };
        if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;
        const iat = typeof payload.iat === "number" && Number.isFinite(payload.iat) ? payload.iat * 1000 : null;
        return { exp: payload.exp * 1000, iat };
    } catch {
        return null;
    }
}

/** 到期前多久算「該換了」：兩分鐘，但不超過壽命的一半（管理員把 access token 設成 1 分鐘時不會一直換）。
 *  The lead before expiry: two minutes, capped at half the lifetime (a 1-minute access token must not renew nonstop). */
export function refreshLeadMs(times: TokenTimes): number {
    if (times.iat === null || times.exp <= times.iat) return REFRESH_LEAD_MS;
    return Math.min(REFRESH_LEAD_MS, Math.floor((times.exp - times.iat) / 2));
}

/** 該續期了嗎：到期前 lead 內、已過期，或讀不出到期時間（交給伺服器判斷）。
 *  Due for renewal: within the lead of expiry, already expired, or unreadable (let the server decide). */
export function accessTokenExpiring(token: string | null | undefined, now: number = Date.now()): boolean {
    const times = tokenTimes(token);
    if (!times) return true;
    return times.exp - now <= refreshLeadMs(times);
}

/** 下次背景續期要等多久（毫秒）。/ How long to wait before the next background renewal, in ms. */
export function refreshDelayMs(token: string | null | undefined, now: number = Date.now()): number {
    const times = tokenTimes(token);
    if (!times) return UNKNOWN_EXPIRY_DELAY_MS;
    return Math.max(MIN_REFRESH_DELAY_MS, times.exp - refreshLeadMs(times) - now);
}

/** 這個請求的 401 能不能「續期後重送一次」：當時有帶 token，而且不是登入類端點。
 *  Whether a 401 may be retried after a renewal: a token was sent and the endpoint is not a login one. */
export function canRetryAfterRefresh(endpoint: string, hadToken: boolean): boolean {
    if (!hadToken) return false;
    const path = endpoint.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    return !NO_REFRESH_PATHS.includes(path);
}
