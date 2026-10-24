/**
 * 敏感隧道的 step-up（再確認一次是你）：token 只放這個分頁的 sessionStorage（15 分鐘），REST 用 header、WebSocket 放
 * auth 訊息的 `step_up`。被要求時（403 `step_up_required` / 關閉碼 4008）呼叫 `requestStepUp()`：同時有好幾個連線在要
 * 也只問一次（`StepUpProvider` 註冊實際的對話框流程）。
 * Step-up for sensitive tunnels: the token lives in this tab's sessionStorage (15 minutes) and rides a header (REST) or
 * the WebSocket auth field `step_up`. `requestStepUp()` asks once even when several connections need it at the same time
 * (`StepUpProvider` registers the dialog flow).
 */
export const STEP_UP_HEADER = "X-Telepy-Step-Up";
export const STEP_UP_CLOSE_CODE = 4008;
const KEY = "telepy.stepUp";
/** 快到期的 token 就別用了（避免剛好在路上過期）。/ Don't use a token about to expire. */
const MARGIN_MS = 10_000;

export interface StoredStepUp {
    token: string;
    until: string;
}

/** 還能用的 token（純函式）。/ The token if it is still usable (pure). */
export function usableToken(stored: StoredStepUp | null, now: number = Date.now()): string | null {
    if (!stored?.token || !stored.until) return null;
    const until = Date.parse(stored.until);
    return Number.isFinite(until) && until - MARGIN_MS > now ? stored.token : null;
}

function read(): StoredStepUp | null {
    try {
        const raw = sessionStorage.getItem(KEY);
        return raw ? (JSON.parse(raw) as StoredStepUp) : null;
    } catch {
        return null;
    }
}

/** 這個分頁現在的 step-up token（沒有或過期回 null）。/ This tab's current step-up token, or null. */
export function stepUpToken(): string | null {
    if (typeof window === "undefined") return null;
    return usableToken(read());
}

export function saveStepUp(stored: StoredStepUp) {
    try {
        sessionStorage.setItem(KEY, JSON.stringify(stored));
    } catch {
        // 存不了就只在這次請求裡用不到；下次會再問。/ Can't store it: we'll simply ask again next time.
    }
}

type Handler = () => Promise<boolean>;
let handler: Handler | null = null;
let pending: Promise<boolean> | null = null;

/** StepUpProvider 註冊（卸載時傳 null）。/ Registered by StepUpProvider (null on unmount). */
export function setStepUpHandler(h: Handler | null) {
    handler = h;
}

/** 要一次 step-up；成功回 true。同時多個呼叫共用同一次。/ Ask for a step-up; concurrent callers share one prompt. */
export function requestStepUp(): Promise<boolean> {
    if (stepUpToken()) return Promise.resolve(true);
    if (!handler) return Promise.resolve(false);
    if (!pending) pending = handler().finally(() => (pending = null));
    return pending;
}
