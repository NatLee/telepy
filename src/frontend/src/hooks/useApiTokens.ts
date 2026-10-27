/**
 * 個人 API token：列出 / 建立（帳號有第二因素時先再驗證一次）/ 撤銷。`userId` = 管理員看別人的（只能列出與撤銷）。
 * Personal API tokens: list / create (re-authenticating first once the account has a factor) / revoke.
 * With `userId` an admin manages someone else's (list and revoke only).
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useReauth } from "@/hooks/useReauth";
import { needsReauth } from "@/lib/mfa";
import { sortTokens, type ApiToken } from "@/lib/apiTokens";

export interface NewTokenBody {
    name: string;
    scopes: string[];
    tunnel_ids: number[] | null;
    expires_at: string;
}

export type CreateResult = { ok: true; token: ApiToken; secret: string } | { ok: false; errors: Record<string, string>; message?: string } | { ok: false; cancelled: true };

async function readJson(res: Response): Promise<unknown> {
    try {
        return await res.json();
    } catch {
        return null;
    }
}

/** `{field: [msg]}` → `{field: msg}`。/ DRF field errors flattened. */
function fieldErrors(body: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (body && typeof body === "object") {
        for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
            if (Array.isArray(v) && typeof v[0] === "string") out[k] = v[0];
        }
    }
    return out;
}

export function useApiTokens(userId?: number) {
    const endpoint = userId ? `/api/user/users/${userId}/tokens` : "/api/auth/tokens";
    const [tokens, setTokens] = useState<ApiToken[] | null>(null);
    const [failed, setFailed] = useState(false);
    const reauth = useReauth();

    const reload = useCallback(async () => {
        try {
            const res = await apiFetch(endpoint);
            if (!res.ok) throw new Error(String(res.status));
            setTokens(sortTokens((await res.json()) as ApiToken[]));
            setFailed(false);
        } catch {
            setFailed(true);
            setTokens((prev) => prev ?? []);
        }
    }, [endpoint]);

    useEffect(() => {
        void reload();
    }, [reload]);

    const create = useCallback(
        async (body: NewTokenBody): Promise<CreateResult> => {
            const send = (proof?: unknown) => apiFetch("/api/auth/tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(proof ? { ...body, reauth: proof } : body) });
            let res = await send();
            let data = await readJson(res);
            const methods = needsReauth(res.status, data);
            if (methods) {
                const proof = await reauth.request(methods);
                if (!proof) return { ok: false, cancelled: true };
                res = await send(proof);
                data = await readJson(res);
            }
            if (res.status === 201) {
                const d = data as { token: ApiToken; secret: string };
                setTokens((prev) => sortTokens([d.token, ...(prev ?? [])]));
                return { ok: true, token: d.token, secret: d.secret };
            }
            const b = (data ?? {}) as { error?: string; detail?: string };
            return { ok: false, errors: fieldErrors(data), message: b.error ?? b.detail };
        },
        [reauth]
    );

    const revoke = useCallback(
        async (t: ApiToken): Promise<boolean> => {
            const res = await apiFetch(userId ? `/api/user/users/${userId}/tokens/${t.id}` : `/api/auth/tokens/${t.id}`, { method: "DELETE" });
            if (!res.ok && res.status !== 404) return false;
            await reload();
            return true;
        },
        [reload, userId]
    );

    return { tokens, failed, reload, create, revoke, reauthDialog: reauth.dialog };
}
