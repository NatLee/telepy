/**
 * 管理區「伺服器狀態」的資料：`GET /api/site/health`（每次都重跑 doctor 的檢查，所以只在進頁面和按重新整理時抓，
 * 不輪詢；進頁面時審計鏈沿用後端背景最近一次的驗證，重新整理才帶 `?fresh=1` 現在驗），以及「已確認」：`POST /api/site/health/ack`（要再驗證時呼叫 `requestReauth` 後重送一次）、
 * `DELETE /api/site/health/ack/{id}`。兩者都回整份結果，直接換上。重新封存審計鏈：`GET /api/site/health/audit`（試算）與
 * `POST /api/site/health/audit/reseal`（一樣要再驗證、回整份結果加上 `resealed`）。
 * Data for the admin "Server health" page: `GET /api/site/health` (every call reruns the doctor checks, so it loads
 * on open and on Refresh only — no polling; on open the audit chain reuses the backend's background verification,
 * Refresh asks for a fresh one with `?fresh=1`), plus acknowledgements: `POST
 * /api/site/health/ack` (retried once with a proof from `requestReauth` when asked) and `DELETE
 * /api/site/health/ack/{id}`. Both answer the whole result, which replaces the current one. Re-sealing the audit
 * chain: `GET /api/site/health/audit` (the dry run) and `POST /api/site/health/audit/reseal` (re-authentication
 * the same way; answers the whole result plus `resealed`).
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { parseReseal, parseResealPlan, type AuditReseal, type AuditResealPlan } from "@/lib/auditReseal";
import { classifyAckError, type AckFailure } from "@/lib/healthAck";
import type { MfaMethod, MfaProof } from "@/lib/mfa";
import { parseServerHealth, type HealthCheck, type ServerHealth } from "@/lib/serverHealth";

/** 確認 / 取消的結果：成功、取消了再驗證、或失敗的原因。/ The outcome: done, re-authentication cancelled, or why it failed. */
export type AckOutcome = { kind: "ok" } | { kind: "cancelled" } | Exclude<AckFailure, { kind: "reauth" }>;

/** 重新封存的結果：成功時附上每張表做了什麼。/ A re-seal's outcome; on success, what was done per table. */
export type ResealOutcome = { kind: "ok"; resealed: AuditReseal[] } | { kind: "cancelled" } | Exclude<AckFailure, { kind: "reauth" }>;

type RequestReauth = (methods: MfaMethod[]) => Promise<MfaProof | null>;

/**
 * POST，被要求再驗證時問一次再重送；回最後的回應或失敗原因。/ POST, retried once with a proof when asked; the final
 * response or why it failed.
 */
async function postWithReauth(path: string, body: Record<string, unknown>, requestReauth: RequestReauth): Promise<Response | { kind: "cancelled" } | Exclude<AckFailure, { kind: "reauth" }>> {
    const post = (reauth?: MfaProof) => apiFetch(path, { method: "POST", body: JSON.stringify({ ...body, ...(reauth ? { reauth } : {}) }) });
    let res = await post();
    if (res.ok) return res;
    const failure = classifyAckError(res.status, await readJson<unknown>(res));
    if (failure.kind !== "reauth") return failure;
    const proof = await requestReauth(failure.methods as MfaMethod[]);
    if (!proof) return { kind: "cancelled" };
    res = await post(proof);
    if (res.ok) return res;
    const again = classifyAckError(res.status, await readJson<unknown>(res));
    return again.kind === "reauth" ? { kind: "other", message: null } : again;
}

export function useServerHealth() {
    const [health, setHealth] = useState<ServerHealth | null>(null);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState(false);

    // 回傳有沒有拿到（重新整理鈕的勾勾）。`fresh` = 審計鏈現在驗。/ Answers whether it arrived (the Refresh button's check); `fresh` = verify the audit chain now.
    const reload = useCallback(async (fresh = false): Promise<boolean> => {
        setBusy(true);
        try {
            const res = await apiFetch(fresh ? "/api/site/health?fresh=1" : "/api/site/health");
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

    // 結果變了 / 已經不是問題：重抓，讓頁面顯示現在的樣子。/ Changed or no longer a problem: reload to show what is there now.
    const settle = useCallback(
        (f: Exclude<AckFailure, { kind: "reauth" }>) => {
            if (f.kind === "changed" || f.kind === "notAProblem") void reload();
            return f;
        },
        [reload],
    );

    const acknowledge = useCallback(
        async (check: HealthCheck, note: string, requestReauth: RequestReauth): Promise<AckOutcome> => {
            try {
                const res = await postWithReauth("/api/site/health/ack", { check_id: check.id, fingerprint: check.fingerprint, note: note.trim() }, requestReauth);
                if (!(res instanceof Response)) return res.kind === "cancelled" ? res : settle(res);
                await apply(res);
                return { kind: "ok" };
            } catch {
                return { kind: "other", message: null };
            }
        },
        [apply, settle],
    );

    /** 試算重新封存（每次打開視窗都重抓）。/ The re-seal dry run (fetched whenever the dialog opens). */
    const loadAuditPlan = useCallback(async (): Promise<AuditResealPlan | null> => {
        try {
            const res = await apiFetch("/api/site/health/audit");
            return res.ok ? parseResealPlan(await readJson<unknown>(res)) : null;
        } catch {
            return null;
        }
    }, []);

    const reseal = useCallback(
        async (fingerprint: string, note: string, requestReauth: RequestReauth): Promise<ResealOutcome> => {
            try {
                const res = await postWithReauth("/api/site/health/audit/reseal", { fingerprint, note: note.trim() }, requestReauth);
                if (!(res instanceof Response)) return res.kind === "cancelled" ? res : settle(res);
                const body = await readJson<unknown>(res.clone());
                const list = body && typeof body === "object" ? (body as Record<string, unknown>).resealed : null;
                await apply(res);
                return { kind: "ok", resealed: Array.isArray(list) ? list.flatMap((r) => parseReseal(r) ?? []) : [] };
            } catch {
                return { kind: "other", message: null };
            }
        },
        [apply, settle],
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

    return { health, failed, busy, reload, acknowledge, unacknowledge, loadAuditPlan, reseal };
}
