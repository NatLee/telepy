/**
 * 送一個長請求；前面的代理把它切斷（502 / 504 / 52x、連線斷掉）時，改等伺服器做完的通知。規則在 `lib/longRequest.ts`。
 * Send a long request; when a proxy in front cuts it (502 / 504 / 52x, a dropped connection), wait for the server's
 * finish notification instead. The rules are in `lib/longRequest.ts`.
 */
import { apiFetch, readJson } from "@/lib/api";
import { CUT_WAIT_MS, finishedFor, isCutStatus, newRequestId, REQUEST_HEADER, type Finished } from "@/lib/longRequest";
import { onNotification } from "@/lib/websocket";

export interface LongResult<T> {
    ok: boolean;
    status: number;
    body: T | null;
    /** 請求被切斷過，結果是從通知來的。/ The request was cut; the result came from the notification. */
    cut: boolean;
}

/** 收不到結果（被切斷又等太久）。/ No result arrived (cut and nothing came in time). */
export class LongRequestLost extends Error {
    constructor(public readonly status: number) {
        super(`request cut (${status}) and no result arrived`);
    }
}

export async function longFetch<T>(endpoint: string, init: RequestInit = {}, opts: { onCut?: (status: number) => void; waitMs?: number } = {}): Promise<LongResult<T>> {
    const id = newRequestId();
    // 先訂閱：結果可能比 504 先到。/ Subscribe first: the result may arrive before the 504 does.
    let resolveDone: (f: Finished) => void = () => {};
    const done = new Promise<Finished>((r) => (resolveDone = r));
    let early: Finished | null = null;
    const stop = onNotification((msg) => {
        const f = finishedFor(msg as Parameters<typeof finishedFor>[0], id);
        if (f) {
            early = f;
            resolveDone(f);
        }
    });
    const waitForFinish = async (status: number): Promise<LongResult<T>> => {
        opts.onCut?.(status);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), opts.waitMs ?? CUT_WAIT_MS)));
        const f = early ?? (await Promise.race([done, timeout]));
        clearTimeout(timer);
        if (!f) throw new LongRequestLost(status);
        return { ok: f.status >= 200 && f.status < 300, status: f.status, body: f.body as T | null, cut: true };
    };
    try {
        const headers = new Headers(init.headers || {});
        headers.set(REQUEST_HEADER, id);
        let res: Response;
        try {
            res = await apiFetch(endpoint, { ...init, headers });
        } catch {
            // 連線斷掉（離線、代理關掉連線）：伺服器可能還在做。/ The connection dropped: the server may still be working.
            return await waitForFinish(0);
        }
        if (isCutStatus(res.status)) return await waitForFinish(res.status);
        return { ok: res.ok, status: res.status, body: await readJson<T>(res), cut: false };
    } finally {
        stop();
    }
}
