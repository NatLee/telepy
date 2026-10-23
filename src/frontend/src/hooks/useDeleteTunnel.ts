/**
 * 刪除隧道對話框的邏輯:開啟時讀 `GET /api/reverse/server/{id}/delete-check`(誰失去存取、Telepy 在裝置上裝過
 * 哪些金鑰、哪些 MCP 授權 / AI session 受影響),讓使用者選要不要移除金鑰 / 服務金鑰、撤銷只限這條隧道的授權,
 * 再以 query 帶選項 DELETE;回來的報告(每個帳號清掉什麼、還留下什麼)顯示在同一個對話框。
 * Delete-tunnel dialog logic: load the delete check on open, let the user pick what to clean up, DELETE with
 * those options as query parameters and keep the returned report to show what was cleaned.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type { AiSession } from "@/hooks/useAiActivityPage";

export interface DeleteCheckKey {
    fingerprint: string;
    owner: string | null;
    /** null = 已經離開清單、等著被移除。/ null = already left the list, pending removal. */
    name: string | null;
    in_list: boolean;
    accounts: string[];
}

export interface DeleteCheckGrant {
    id: number;
    client_name: string;
    user: { id: number; username: string };
    mine: boolean;
    /** only = 只限這條;shared = 這條 + 其他;all = 不限隧道。/ only / shared / all tunnels. */
    coverage: "only" | "shared" | "all";
    other_tunnels: number;
}

export interface DeleteCheck {
    tunnel: { id: number; name: string; reverse_port: number };
    online: boolean;
    accounts: string[];
    sharees: { id: number; username: string; permission: string }[];
    in_use: number;
    lan_hosts: number;
    device_keys: DeleteCheckKey[];
    grants: DeleteCheckGrant[];
    ai_sessions: AiSession[];
}

export interface DeleteReport {
    deleted: boolean;
    online: boolean;
    accounts: { account: string; removed: number; service_key_removed: boolean; error: string | null }[];
    keys_left: number;
    grants_revoked: number;
    grants_detached: number;
    ai_sessions_closed: number;
    device_disconnected: boolean;
}

export interface DeleteOptions {
    removeDeviceKeys: boolean;
    removeServiceKey: boolean;
    revokeGrants: boolean;
}

export function useDeleteTunnel(tunnelId: number | null, isOpen: boolean, onDeleted: () => void) {
    const { t } = useI18n();
    const [check, setCheck] = useState<{ id: number; data: DeleteCheck | null; error: string | null } | null>(null);
    const [options, setOptions] = useState<DeleteOptions>({ removeDeviceKeys: true, removeServiceKey: false, revokeGrants: true });
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [report, setReport] = useState<DeleteReport | null>(null);

    useEffect(() => {
        if (!isOpen || tunnelId === null) return;
        let cancelled = false;
        (async () => {
            let next: { id: number; data: DeleteCheck | null; error: string | null };
            try {
                const res = await apiFetch(`/api/reverse/server/${tunnelId}/delete-check`);
                const body = await readJson<DeleteCheck>(res);
                next = res.ok && body ? { id: tunnelId, data: body, error: null } : { id: tunnelId, data: null, error: responseError(res, body, t("deleteTunnel.checkFailed")) };
            } catch (e) {
                next = { id: tunnelId, data: null, error: e instanceof Error ? e.message : t("deleteTunnel.checkFailed") };
            }
            if (!cancelled) setCheck(next);
        })();
        return () => {
            cancelled = true;
        };
    }, [isOpen, tunnelId, t]);

    const current = check && check.id === tunnelId ? check : null;
    const data = current?.data ?? null;

    const submit = useCallback(async () => {
        if (tunnelId === null || !data) return;
        setDeleting(true);
        setError(null);
        // 裝置離線時金鑰動不了,不要送出做不到的選項。/ Offline: don't ask for what cannot be done.
        const qs = new URLSearchParams({
            remove_device_keys: String(data.online && options.removeDeviceKeys),
            remove_service_key: String(data.online && options.removeServiceKey),
            revoke_grants: String(options.revokeGrants),
        });
        try {
            const res = await apiFetch(`/api/reverse/server/keys/${tunnelId}?${qs.toString()}`, { method: "DELETE" });
            const body = await readJson<DeleteReport>(res);
            if (res.ok && body) {
                setReport(body);
                onDeleted();
            } else {
                setError(responseError(res, body, t("tunnels.deleteFailed")));
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : t("tunnels.deleteFailed"));
        } finally {
            setDeleting(false);
        }
    }, [tunnelId, data, options, onDeleted, t]);

    const setOption = useCallback(<K extends keyof DeleteOptions>(key: K, value: DeleteOptions[K]) => setOptions((o) => ({ ...o, [key]: value })), []);

    return {
        check: data,
        checkError: current?.error ?? null,
        loading: isOpen && tunnelId !== null && current === null,
        options,
        setOption,
        deleting,
        error,
        report,
        submit,
    };
}
