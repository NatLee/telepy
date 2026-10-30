/**
 * 管理區「伺服器狀態」的資料：`GET /api/site/health`（每次都重跑 doctor 的檢查，含審計鏈驗證，所以只在進頁面和
 * 按重新整理時抓，不輪詢），以及「已確認」：`POST /api/site/health/ack`（要再驗證時呼叫 `requestReauth` 後重送一次）、
 * `DELETE /api/site/health/ack/{id}`。兩者都回整份結果，直接換上。
 * Data for the admin "Server health" page: `GET /api/site/health` (every call reruns the doctor checks, audit chain
 * included, so it loads on open and on Refresh only — no polling), plus acknowledgements: `POST
 * /api/site/health/ack` (retried once with a proof from `requestReauth` when asked) and `DELETE
 * /api/site/health/ack/{id}`. Both answer the whole result, which replaces the current one.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { classifyAckError, type AckFailure } from "@/lib/healthAck";
import type { MfaMethod, MfaProof } from "@/lib/mfa";
import { parseServerHealth, type HealthCheck, type ServerHealth } from "@/lib/serverHealth";

/** 確認 / 取消的結果：成功、取消了再驗證、或失敗的原因。/ The outcome: done, re-authentication cancelled, or why it failed. */
export type AckOutcome = { kind: "ok" } | { kind: "cancelled" } | Exclude<AckFailure, { kind: "reauth" }>;

export function useServerHealth() {
    const [health, setHealth] = useState<ServerHealth | null>(null);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState(false);

    // 回傳有沒有拿到（重新整理鈕的勾勾）。/ Answers whether it arrived (the Refresh button's check).
    const reload = useCallback(async (): Promise<boolean> => {
        setBusy(true);
        try {
            const res = await apiFetch("/api/site/health");
            const parsed = res.ok ? parseServerHealth(await readJson<unknown>(res)) : null;
            setHealth(parsed);
            setFailed(!parsed);
            return !!parsed;
        } catch {
            setFailed(true);
            return false;
        } finally {
            setBusy(false);
        }
    }, []);

    useEffect(() => {
        void reload();
    }, [reload]);

    /** 換上回應裡的整份結果；形狀不對就重抓。/ Take the whole result from a response; reload when it looks wrong. */
    const apply = useCallback(
        async (res: Response) => {
            const parsed = parseServerHealth(await readJson<unknown>(res));
            if (parsed) {
                setHealth(parsed);
                setFailed(false);
            } else void reload();
        },
        [reload],
    );

    const acknowledge = useCallback(
        async (check: HealthCheck, note: string, requestReauth: (methods: MfaMethod[]) => Promise<MfaProof | null>): Promise<AckOutcome> => {
            // 結果變了 / 已經不是問題：重抓，讓頁面顯示現在的樣子。/ Changed or no longer a problem: reload to show what is there now.
            const finish = (f: Exclude<AckFailure, { kind: "reauth" }>): AckOutcome => {
                if (f.kind === "changed" || f.kind === "notAProblem") void reload();
                return f;
            };
            const post = (reauth?: MfaProof) =>
                apiFetch("/api/site/health/ack", { method: "POST", body: JSON.stringify({ check_id: check.id, fingerprint: check.fingerprint, note: note.trim(), ...(reauth ? { reauth } : {}) }) });
            try {
                let res = await post();
                if (!res.ok) {
                    const failure = classifyAckError(res.status, await readJson<unknown>(res));
                    if (failure.kind !== "reauth") return finish(failure);
                    const proof = await requestReauth(failure.methods as MfaMethod[]);
                    if (!proof) return { kind: "cancelled" };
                    res = await post(proof);
                    if (!res.ok) {
                        const again = classifyAckError(res.status, await readJson<unknown>(res));
                        return finish(again.kind === "reauth" ? { kind: "other", message: null } : again);
                    }
                }
                await apply(res);
                return { kind: "ok" };
            } catch {
                return { kind: "other", message: null };
            }
        },
        [apply, reload],
    );

    const unacknowledge = useCallback(
        async (check: HealthCheck): Promise<boolean> => {
            if (!check.id) return false;
            try {
                const res = await apiFetch(`/api/site/health/ack/${encodeURIComponent(check.id)}`, { method: "DELETE" });
                if (!res.ok) return false;
                await apply(res);
                return true;
            } catch {
                return false;
            }
        },
        [apply],
    );

    return { health, failed, busy, reload, acknowledge, unacknowledge };
}
