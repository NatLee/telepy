/**
 * 一台裝置的金鑰清單視窗：清單（擁有者 / ADMIN 看全部，其他人看自己的）、勾選自己的金鑰、移出、立即同步，
 * 以及（擁有者 / ADMIN）實際讀裝置 authorized_keys 的稽核與移除清單外的金鑰。
 * One device's key-list panel: the list, ticking your own keys, removing entries, sync now, and (owner /
 * ADMIN) the live authorized_keys audit with removal of keys that are not on the list.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS, type NotificationPayload } from "@/types/notification";
import type { AuthorizedKeysAudit, DeviceKeys } from "@/types/keys";
import { deviceKeyError, errorCode } from "@/lib/deviceKeyErrors";

export function useDeviceKeys(tunnelId: number | null, onChanged?: () => void) {
    const { showSuccess, showError } = useToast();
    const { t } = useI18n();
    const [data, setData] = useState<DeviceKeys | null>(null);
    const [loading, setLoading] = useState(false);
    const [notFound, setNotFound] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [audit, setAudit] = useState<AuthorizedKeysAudit | null>(null);
    const [auditLoading, setAuditLoading] = useState(false);
    const [auditError, setAuditError] = useState<string | null>(null);

    const base = tunnelId ? `/api/reverse/server/${tunnelId}` : null;

    const load = useCallback(async () => {
        if (!base) return;
        try {
            const res = await apiFetch(`${base}/device-keys`);
            if (res.status === 404) {
                setNotFound(true);
                setData(null);
                return;
            }
            if (res.ok) {
                setNotFound(false);
                setData(await res.json());
            }
        } catch {
            /* keep the last state */
        }
    }, [base]);

    useEffect(() => {
        setData(null);
        setAudit(null);
        setAuditError(null);
        setNotFound(false);
        if (!base) return;
        setLoading(true);
        load().finally(() => setLoading(false));
    }, [base, load]);

    const onEvent = useCallback(
        (msg: NotificationPayload) => {
            if (msg.tunnel_id === tunnelId || msg.tunnel_id === undefined) load();
        },
        [load, tunnelId]
    );
    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.DEVICE_KEYS_UPDATED]: onEvent,
        [NOTIFICATION_ACTIONS.TUNNEL_USERNAMES_UPDATED]: onEvent,
        [NOTIFICATION_ACTIONS.TUNNEL_PERMISSION_UPDATED]: onEvent,
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_STATUS]: onEvent,
    });

    /** 共用：送出請求 → 成功用回應更新畫面，失敗顯示在地化錯誤。/ Shared request runner. */
    const run = useCallback(
        async (label: string, req: () => Promise<Response>, fallback: string, ok?: string) => {
            setBusy(label);
            try {
                const res = await req();
                const body = await readJson(res);
                if (!res.ok) {
                    showError(deviceKeyError(res, body, fallback));
                    return false;
                }
                if (body && typeof body === "object" && "entries" in body) setData(body as DeviceKeys);
                if (ok) showSuccess(ok);
                onChanged?.();
                return true;
            } catch (e) {
                showError(e instanceof Error ? e.message : fallback);
                return false;
            } finally {
                setBusy(null);
            }
        },
        [onChanged, showError, showSuccess]
    );

    const toggleMine = useCallback(
        (keyId: number, on: boolean) =>
            base &&
            run(
                `key:${keyId}`,
                () =>
                    on
                        ? apiFetch(`${base}/device-keys`, { method: "POST", body: JSON.stringify({ user_key_ids: [keyId] }) })
                        : apiFetch(`${base}/device-keys/${keyId}`, { method: "DELETE" }),
                t("keys.toggleFailed")
            ),
        [base, run, t]
    );

    const addAllMine = useCallback(
        (keyIds: number[]) =>
            base && keyIds.length > 0 && run("all", () => apiFetch(`${base}/device-keys`, { method: "POST", body: JSON.stringify({ user_key_ids: keyIds }) }), t("keys.toggleFailed")),
        [base, run, t]
    );

    const removeEntry = useCallback(
        (keyId: number) => base && run(`entry:${keyId}`, () => apiFetch(`${base}/device-keys/${keyId}`, { method: "DELETE" }), t("keys.toggleFailed")),
        [base, run, t]
    );

    const sync = useCallback(
        () => base && run("sync", () => apiFetch(`${base}/device-keys/sync`, { method: "POST" }), t("keys.syncFailed"), t("keys.synced", { device: data?.tunnel.host_friendly_name ?? "" })),
        [base, data?.tunnel.host_friendly_name, run, t]
    );

    const loadAudit = useCallback(async () => {
        if (!base) return;
        setAuditLoading(true);
        setAuditError(null);
        try {
            const res = await apiFetch(`${base}/authorized-keys`);
            const body = await readJson(res);
            if (res.ok) setAudit(body as AuthorizedKeysAudit);
            else {
                setAudit(null);
                setAuditError(errorCode(body) === "device_offline" ? "offline" : deviceKeyError(res, body, t("keys.audit.failed")));
            }
        } catch (e) {
            setAuditError(e instanceof Error ? e.message : t("keys.audit.failed"));
        } finally {
            setAuditLoading(false);
        }
    }, [base, t]);

    const removeLine = useCallback(
        async (username: string, fingerprint: string) => {
            if (!base) return false;
            const ok = await run(
                `line:${username}:${fingerprint}`,
                () => apiFetch(`${base}/authorized-keys/remove`, { method: "POST", body: JSON.stringify({ username, fingerprint }) }),
                t("keys.audit.removeFailed"),
                t("keys.audit.removed", { account: username })
            );
            if (ok) await loadAudit();
            return ok;
        },
        [base, loadAudit, run, t]
    );

    return { data, loading, notFound, busy, audit, auditLoading, auditError, load, toggleMine, addAllMine, removeEntry, sync, loadAudit, removeLine };
}
