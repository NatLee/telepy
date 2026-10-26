/**
 * API client configuration and shared fetch logic.
 */

import { formatApiError } from "./formatApiError";
import { accessTokenExpiring, canRetryAfterRefresh } from "./session";
import { requestStepUp, STEP_UP_HEADER, stepUpToken } from "./stepUp";
import { translate } from "./translate";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

/** 同分頁換好新 token 後發出（lib/auth.tsx 用它重排下一次續期）。/ Fired after this tab stored a renewed token. */
export const ACCESS_TOKEN_EVENT = "telepy:access-token";

/**
 * 安全地將 Response body 解析為 JSON。
 * Safely parse a Response body as JSON.
 *
 * 反向代理（Traefik/Nginx）在後端無法連線時，會回傳「純文字」body（例如 502 的
 * "Bad Gateway"）或 HTML 錯誤頁，而非 JSON。直接呼叫 res.json() 會丟出難懂的
 * `Unexpected token 'B', "Bad Gateway" is not valid JSON`，並外洩給使用者。
 * 此函式先讀成文字、僅在確實是合法 JSON 時才解析，否則回傳 null，讓呼叫端能改用
 * 以 HTTP 狀態碼為基礎的友善訊息（見 responseError）。
 *
 * A reverse proxy returns 5xx with a plain-text/HTML body (not JSON); res.json() on that
 * throws the cryptic "Unexpected token 'B'..." SyntaxError. Read text first, parse only
 * valid JSON, else return null so callers can fall back to a status-based message.
 */
export async function readJson<T = unknown>(res: Response): Promise<T | null> {
    let text: string;
    try {
        text = await res.text();
    } catch {
        return null;
    }
    if (!text) return null;
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

/**
 * 依據失敗的 Response 產生「人類可讀」的錯誤訊息。
 * Build a human-readable error message for a failed Response.
 *
 * 優先使用結構化 API 錯誤 body（{detail}/{error}/{field:[...]}）；當 body 非 JSON
 * 或為空（通常是後端啟動中/掛掉造成的代理錯誤）時，改用 HTTP 狀態碼訊息。
 * Prefer a structured API error body; fall back to a status-based message (e.g. proxy 5xx).
 */
export function responseError(
    res: Response,
    body: unknown,
    fallback: string = translate("api.requestFailed")
): string {
    const fromBody = formatApiError(body, "");
    if (fromBody) return fromBody;

    if (res.status === 502 || res.status === 503 || res.status === 504) {
        return translate("api.serverUnavailable", { status: res.status });
    }
    if (res.status >= 500) {
        return translate("api.serverError", { status: res.status });
    }
    if (res.status === 0) {
        return translate("api.cannotReach");
    }
    return `${fallback} (${res.status})`;
}

/**
 * 續期結果：ok = 有可用的 token（換好了，或別的分頁剛換好）；rejected = 伺服器說這個登入結束了
 * （refresh token 過期、登出過、被撤銷、帳號停用）；error = 沒連上伺服器或 5xx，登入狀態不變、稍後再試。
 * Renewal outcome: ok = a usable token (renewed here or by another tab just now); rejected = the server
 * ended this sign-in (refresh token expired, signed out, revoked, account disabled); error = the server could
 * not be reached or answered 5xx, so the sign-in stays and a retry comes later.
 */
export type RefreshOutcome = "ok" | "rejected" | "error";

/**
 * 伺服器說這個登入被登出了的原因（`signed_out`：user = 從別的裝置、admin = 管理員）。lib/auth.tsx 在登出時讀一次並提示。
 * Why the server ended this sign-in (`signed_out`: user = from another device, admin = an administrator).
 * lib/auth.tsx reads it once when it logs out and shows a notice.
 */
let signedOutReason: string | null = null;

export function noteSignedOut(reason: string | null | undefined): void {
    if (reason) signedOutReason = reason;
}

export function takeSignedOutReason(): string | null {
    const r = signedOutReason;
    signedOutReason = null;
    return r;
}

/**
 * 這個瀏覽器被登出了（WebSocket 4010，或 401 帶 `signed_out`）：記下原因、走登出的路。
 * This browser was signed out (WebSocket 4010, or a 401 with `signed_out`): note why and take the logout path.
 */
export function signedOut(reason: string | null | undefined): void {
    if (typeof window === "undefined") return;
    noteSignedOut(reason || "user");
    window.dispatchEvent(new CustomEvent("api:unauthorized"));
}

let inflight: { force: boolean; promise: Promise<RefreshOutcome> } | null = null;

/**
 * 用 refresh token 換新的 access token（後端同時換發新的 refresh token；舊的只在 60 秒寬限內還能用），寫回 localStorage。
 * - 單飛：同時多個呼叫共用一次請求。跨分頁用 Web Locks 串起來，拿到鎖後先看 token 是不是已經被別的分頁換掉了。
 * - force = false（到期前的背景續期）：token 還不急就不打請求。force = true（伺服器剛拒絕了這顆 token：401 / 4001）：
 *   一定打，除非拿到鎖時 token 已經不是剛才那顆（別的分頁換好了）。
 * Exchange the refresh token for a new access token (the backend rotates the refresh token too; the old one
 * works for a 60-second grace only) and store both. Single flight within the tab; a Web Lock serialises tabs,
 * and after taking it the token is re-read in case another tab renewed meanwhile. `force` (the server just
 * rejected the token: 401 / 4001) always sends the request unless the stored token changed in between.
 */
export function refreshSession(opts: { force?: boolean } = {}): Promise<RefreshOutcome> {
    if (typeof window === "undefined") return Promise.resolve("error");
    const force = !!opts.force;
    // 強制續期不能搭順風車坐在「還不急就不打」的背景續期上。/ A forced renewal must not ride on a lazy background one.
    if (inflight && (inflight.force || !force)) return inflight.promise;
    const previous = inflight?.promise;
    const promise = (async () => {
        if (previous) await previous.catch(() => undefined);
        return runRefresh(force);
    })();
    inflight = { force, promise };
    void promise.finally(() => {
        if (inflight?.promise === promise) inflight = null;
    });
    return promise;
}

async function runRefresh(force: boolean): Promise<RefreshOutcome> {
    const seen = localStorage.getItem("accessToken");
    const work = async (): Promise<RefreshOutcome> => {
        const stored = localStorage.getItem("accessToken");
        if (stored && stored !== seen) return "ok";                        // 別的分頁剛換好 / another tab renewed meanwhile
        if (!force && stored && !accessTokenExpiring(stored)) return "ok"; // 還不急 / not due yet
        const refresh = localStorage.getItem("refreshToken");
        if (!refresh) return "rejected";
        let res: Response;
        try {
            res = await fetch(`${API_BASE}/api/auth/token/refresh`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ refresh }),
            });
        } catch {
            return "error";
        }
        if (!res.ok) {
            // 我們送的那顆在等回應時被別的分頁換掉了：它的新 token 已經在 localStorage。
            // The token we sent was replaced by another tab while we waited: its new token is already stored.
            if (localStorage.getItem("refreshToken") !== refresh) return "ok";
            if (res.status === 401) {
                const body = await readJson<{ signed_out?: string }>(res);
                noteSignedOut(body?.signed_out);
            }
            return res.status === 401 || res.status === 400 ? "rejected" : "error";
        }
        const data = await readJson<{ access?: string; access_token?: string; refresh?: string; refresh_token?: string }>(res);
        const access = data?.access_token || data?.access;
        if (!access) return "error";
        localStorage.setItem("accessToken", access);
        const rotated = data?.refresh_token || data?.refresh;
        if (rotated) localStorage.setItem("refreshToken", rotated);
        window.dispatchEvent(new CustomEvent(ACCESS_TOKEN_EVENT));
        return "ok";
    };
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (locks?.request) {
        try {
            return await locks.request("telepy.session-refresh", work);
        } catch {
            return work();
        }
    }
    return work();
}

/**
 * 伺服器剛拒絕了 access token（REST 401、WebSocket 4001）：換一顆再試；成功回 true。
 * ReconnectingSocket / 終端頁 / 區網終端機在收到 4001 時呼叫，然後重連一次。
 * The server just rejected the access token (REST 401, WebSocket 4001): renew it; true on success.
 * Called by ReconnectingSocket, the terminal page and LAN terminals on 4001 before their one reconnect.
 */
export async function refreshAccessToken(): Promise<boolean> {
    return (await refreshSession({ force: true })) === "ok";
}

/**
 * 登出：請伺服器撤銷這個登入 session（refresh token 之後不能再續期）。盡力而為、不等回應，頁面要走了所以 keepalive。
 * Logout: ask the server to revoke this sign-in session. Best effort, not awaited; keepalive because the page is leaving.
 */
export function revokeSession(refresh: string): void {
    try {
        void fetch(`${API_BASE}/api/auth/logout`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refresh }),
            keepalive: true,
        }).catch(() => undefined);
    } catch {
        /* 離開頁面中 / leaving the page */
    }
}

export async function apiFetch(
    endpoint: string,
    options: RequestInit = {},
    /** 內部用：step-up 之後重送一次。/ Internal: the one retry after a step-up. */
    stepUpRetried = false,
    /** 內部用：續期之後重送一次。/ Internal: the one retry after a token renewal. */
    refreshRetried = false,
): Promise<Response> {
    // Prefix appropriate url
    const url = endpoint.startsWith("http") ? endpoint : `${API_BASE}${endpoint}`;

    // Read token from localStorage directly
    const accessToken =
        typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;

    const headers = new Headers(options.headers || {});
    // Do not set Content-Type for FormData — browser must set multipart/form-data with boundary
    const isFormData = options.body instanceof FormData;
    if (!isFormData) {
        headers.set("Content-Type", "application/json");
    }

    if (accessToken) {
        headers.set("Authorization", `Bearer ${accessToken}`);
    }
    // 敏感隧道的 step-up token（有才帶）。/ The step-up token for sensitive tunnels, when there is one.
    const stepUp = stepUpToken();
    if (stepUp) headers.set(STEP_UP_HEADER, stepUp);

    const response = await fetch(url, { ...options, headers });

    // 401：多半是 access token 到期了。先用 refresh token 換一顆再重送一次；伺服器拒絕續期才算登入結束
    // （api:unauthorized → lib/auth.tsx 登出）。沒連上伺服器時什麼都不做（登入狀態不變，回原本的 401）。
    // 登入類端點的 401 是帳密錯，不續期；沒帶 token 的請求也不續期（本來就沒登入）。
    // 401: usually an expired access token. Renew with the refresh token and retry once; only a refused
    // renewal ends the sign-in (api:unauthorized → logout in lib/auth.tsx). An unreachable server changes
    // nothing. Login endpoints and token-less requests are never renewed.
    if (response.status === 401 && typeof window !== "undefined") {
        if (!refreshRetried && canRetryAfterRefresh(endpoint, !!accessToken)) {
            const outcome = await refreshSession({ force: true });
            if (outcome === "ok") return apiFetch(endpoint, options, stepUpRetried, true);
            if (outcome === "rejected") window.dispatchEvent(new CustomEvent("api:unauthorized"));
            return response;
        }
        window.dispatchEvent(new CustomEvent("api:unauthorized"));
    }

    // 管理員在使用中途要求兩步驟：重抓 profile，讓 AppLayout 換成設定畫面（lib/auth.tsx 監聽）。
    // The admin started requiring two-step sign-in mid-session: refetch the profile so the gate appears.
    // 敏感隧道要先確認是你：問一次（StepUpProvider），成功就重送。/ A sensitive tunnel wants a step-up: ask once, then retry.
    if (response.status === 403 && typeof window !== "undefined") {
        const body = (await response.clone().json().catch(() => null)) as { code?: string } | null;
        if (body?.code === "mfa_enrollment_required") window.dispatchEvent(new CustomEvent("api:mfa-enrollment-required"));
        if (body?.code === "step_up_required" && !stepUpRetried && (await requestStepUp())) {
            return apiFetch(endpoint, options, true, refreshRetried);
        }
    }

    return response;
}
