/**
 * 一個人的 OAuth grant，分成 `telepy` CLI 的瀏覽器登入與 MCP app（`lib/cliSignIns.splitGrants`）。`userId` = 管理員看別人的。
 * API 頁的「CLI 登入」、MCP 頁 / 偏好設定的「MCP app」與管理使用者視窗共用；撤銷 = `DELETE /api/oauth/grants/{id}`
 * （CLI 登入就是登出那台電腦，MCP app 就是中斷連接）。
 * A person's OAuth grants split into CLI sign-ins and MCP apps. `userId` = an admin looking at someone else's. Shared
 * by the API page's CLI sign-ins, the MCP apps lists and the Manage-user dialog; revoking signs that computer out /
 * disconnects that app.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { splitGrants } from "@/lib/cliSignIns";
import type { OAuthGrant } from "@/types/oauth";

export function useOAuthGrants(userId?: number) {
    const endpoint = userId !== undefined ? `/api/user/users/${userId}/grants` : "/api/oauth/grants";
    const [grants, setGrants] = useState<OAuthGrant[] | null>(null);
    const [failed, setFailed] = useState(false);

    const reload = useCallback(async () => {
        try {
            const res = await apiFetch(endpoint);
            if (!res.ok) throw new Error(String(res.status));
            const data = (await res.json()) as unknown;
            setGrants(Array.isArray(data) ? (data as OAuthGrant[]) : []);
            setFailed(false);
        } catch {
            setFailed(true);
            setGrants((prev) => prev ?? []);
        }
    }, [endpoint]);

    useEffect(() => {
        void reload();
    }, [reload]);

    const split = useMemo(() => (grants === null ? null : splitGrants(grants)), [grants]);

    /** true = 撤銷了（或早就不在）。/ true when revoked (or already gone). */
    const revoke = useCallback(async (g: OAuthGrant) => {
        try {
            const res = await apiFetch(`/api/oauth/grants/${g.id}`, { method: "DELETE" });
            if (!res.ok && res.status !== 404) return false;
            setGrants((prev) => (prev ?? []).filter((x) => x.id !== g.id));
            return true;
        } catch {
            return false;
        }
    }, []);

    const forget = useCallback((id: number) => setGrants((prev) => (prev ?? []).filter((x) => x.id !== id)), []);

    return { grants, cli: split?.cli ?? null, apps: split?.apps ?? null, failed, reload, revoke, forget };
}
