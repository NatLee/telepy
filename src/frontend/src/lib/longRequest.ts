/**
 * 長請求（刪通道、盤點 / 改名 / 換裝置上的服務）的純規則：前面的代理（Nginx 60 s、Nginx Proxy Manager ~90 s、
 * Cloudflare 100 s）會先放棄請求回 502 / 504 / 52x，伺服器卻照樣做完（後端 `api::detached`）。頁面在請求帶一個代號
 * （`X-Telepy-Request`），被切斷時改等 `REQUEST-FINISHED {request, status, body}`。I/O 在 `lib/longFetch.ts`。
 *
 * Pure rules for long requests (deleting a tunnel, surveying / renaming / switching a device's service): a proxy in
 * front gives up first with 502 / 504 / 52x while the server still finishes (backend `api::detached`). The page tags
 * the request (`X-Telepy-Request`) and, when it is cut, waits for `REQUEST-FINISHED {request, status, body}` instead.
 * The I/O lives in `lib/longFetch.ts`.
 */

export const REQUEST_HEADER = "X-Telepy-Request";

/**
 * 這個回應是代理切斷的（伺服器多半還在做）：502 / 504 與 Cloudflare 的 520–524。503 不算：那是後端沒在跑。
 * A response from a proxy that gave up (the server is most likely still working): 502 / 504 and Cloudflare's 520–524.
 * 503 is not one: that is the backend being down.
 */
export function isCutStatus(status: number): boolean {
    return status === 502 || status === 504 || (status >= 520 && status <= 524);
}

/** 這個請求的代號（`[a-z0-9-]`，後端只收 1–64 個字）。/ An id for the request (the backend takes 1–64 safe characters). */
export function newRequestId(random: () => number = Math.random): string {
    let s = "r-";
    for (let i = 0; i < 16; i++) s += Math.floor(random() * 36).toString(36);
    return s;
}

export interface Finished {
    status: number;
    body: unknown;
}

/** 這則通知是不是這個請求做完了。/ Is this notification the finish of this request? */
export function finishedFor(msg: { action?: unknown; request?: unknown; status?: unknown; body?: unknown }, id: string): Finished | null {
    if (msg.action !== "REQUEST-FINISHED" || msg.request !== id) return null;
    return { status: typeof msg.status === "number" ? msg.status : 500, body: msg.body ?? null };
}

/** 被切斷之後最多等多久（改名的交接最長約四分鐘）。/ How long to wait after a cut (a rename's handover takes up to ~4 min). */
export const CUT_WAIT_MS = 6 * 60_000;
