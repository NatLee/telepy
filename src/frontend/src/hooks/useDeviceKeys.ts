/**
 * 一台裝置的金鑰視窗：清單與裝置上實際的 authorized_keys 合在同一個畫面（每個帳號一張卡）。
 * 打開時若最近沒檢查過就自動「同步」一次（套用清單 + 重讀每個帳號）；之後清單變動由背景同步完成，
 * 收到 DEVICE-KEYS-UPDATED 再重抓（不連裝置）。只有一個「立即同步」動作。
 * One device's key panel: the key list and the accounts' actual authorized_keys in one view. On open it
 * syncs once if the device wasn't checked recently (apply the list + re-read every account); later changes
 * are applied by the background sync and DEVICE-KEYS-UPDATED triggers a cheap refetch. One "sync now" action.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS, type NotificationPayload } from "@/types/notification";
import type { DeviceKeys } from "@/types/keys";
import { deviceKeyError, errorCode } from "@/lib/deviceKeyErrors";

/** 打開時，超過這麼久沒檢查就自動同步。/ Auto-sync on open when the last check is older than this. */
const STALE_MS = 60_000;

/** 最舊的一次檢查；有帳號沒讀過就是 null。/ Oldest check; null when some account was never read. */
export function oldestCheck(d: DeviceKeys | null): number | null {
    const accounts = d?.view.accounts ?? [];
    if (accounts.length === 0 || accounts.some((a) => !a.checked_at && !a.error)) return null;
    const times = accounts.filter((a) => a.checked_at).map((a) => Date.parse(a.checked_at!));
    return times.length ? Math.min(...times) : null;
}

export function useDeviceKeys(tunnelId: number | null, onChanged?: () => void) {
    const { showError, showSuccess } = useToast();
    const { t } = useI18n();
    const [data, setData] = useState<DeviceKeys | null>(null);
    const [loading, setLoading] = useState(false);
    const [notFound, setNotFound] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    /** 正在同步 / 重讀裝置。/ A sync (apply + re-read) is running. */
    const [syncing, setSyncing] = useState(false);
    const autoSynced = useRef<number | null>(null);

    const base = tunnelId ? `/api/reverse/server/${tunnelId}` : null;

    const load = useCallback(async () => {
        if (!base) return null;
        try {
            const res = await apiFetch(`${base}/device-keys`);
            if (res.status === 404) {
                setNotFound(true);
                setData(null);
                return null;
            }
            if (res.ok) {
                const body: DeviceKeys = await res.json();
                setNotFound(false);
                setData(body);
                return body;
            }
        } catch {
            /* keep the last state */
        }
        return null;
    }, [base]);

    /** 套用清單並重讀每個帳號（後端限制 5 秒內不重讀）。/ Apply the list and re-read every account. */
    const sync = useCallback(
        async (quiet = false) => {
            if (!base) return;
            setSyncing(true);
            try {
                const res = await apiFetch(`${base}/device-keys/sync`, { method: "POST" });
                const body = await readJson(res);
                if (res.ok && body && typeof body === "object" && "view" in body) {
                    setData(body as DeviceKeys);
                    onChanged?.();
                } else if (errorCode(body) === "device_offline") {
                    await load();
                } else if (!quiet) {
                    showError(deviceKeyError(res, body, t("keys.syncFailed")));
                }
            } catch (e) {
                if (!quiet) showError(e instanceof Error ? e.message : t("keys.syncFailed"));
            } finally {
                setSyncing(false);
            }
        },
        [base, load, onChanged, showError, t]
    );

    useEffect(() => {
        setData(null);
        setNotFound(false);
        if (!base || tunnelId === null) return;
        let cancelled = false;
        setLoading(true);
        load()
            .then((d) => {
                // 打開時自動檢查一次（太久沒讀過的話）。/ Check once on open when stale.
                if (cancelled || !d?.tunnel.online || autoSynced.current === tunnelId) return;
                const oldest = oldestCheck(d);
                if (oldest === null || Date.now() - oldest > STALE_MS) {
                    autoSynced.current = tunnelId;
                    sync(true);
                }
            })
            .finally(() => !cancelled && setLoading(false));
        return () => {
            cancelled = true;
        };
        // sync 只在打開時用一次，不跟著它變。/ sync is only used once on open.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [base, load, tunnelId]);

    // 關掉再打開同一台時要能再自動檢查。/ Re-arm the auto check after the panel closes.
    useEffect(() => {
        if (tunnelId === null) autoSynced.current = null;
    }, [tunnelId]);

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
        async (label: string, req: () => Promise<Response>, fallback: string) => {
            setBusy(label);
            try {
                const res = await req();
                const body = await readJson(res);
                if (!res.ok) {
                    showError(deviceKeyError(res, body, fallback));
                    return false;
                }
                if (body && typeof body === "object" && "view" in body) setData(body as DeviceKeys);
                else await load();
                onChanged?.();
                return true;
            } catch (e) {
                showError(e instanceof Error ? e.message : fallback);
                return false;
            } finally {
                setBusy(null);
            }
        },
        [load, onChanged, showError]
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

    /** 從某個帳號移除一把不在清單上的金鑰。/ Remove a key that is not on the list from one account. */
    const removeLine = useCallback(
        (username: string, fingerprint: string) =>
            base &&
            run(
                `line:${username}:${fingerprint}`,
                () => apiFetch(`${base}/authorized-keys/remove`, { method: "POST", body: JSON.stringify({ username, fingerprint }) }),
                t("keys.row.removeFailed")
            ),
        [base, run, t]
    );

    /**
     * 一次移除很多把（帳號 → 指紋）：每個帳號一個請求、檔案只改寫一次；不能移的（服務金鑰 / 清單上的 / 已不在）後端會略過。
     * Bulk removal: one request per account, each rewriting the file once; the backend skips keys it must keep.
     */
    const removeLines = useCallback(
        async (groups: Map<string, string[]>) => {
            if (!base || groups.size === 0) return false;
            setBusy("bulk");
            let keys = 0;
            let skipped = 0;
            let failed: string | null = null;
            try {
                for (const [username, fingerprints] of groups) {
                    const res = await apiFetch(`${base}/authorized-keys/remove`, { method: "POST", body: JSON.stringify({ username, fingerprints }) });
                    const body = await readJson(res);
                    if (!res.ok) {
                        failed = deviceKeyError(res, body, t("keys.row.removeFailed"));
                        break;
                    }
                    const r = body as { keys?: number; skipped?: unknown[] } | null;
                    keys += r?.keys ?? 0;
                    skipped += r?.skipped?.length ?? 0;
                }
            } catch (e) {
                failed = e instanceof Error ? e.message : t("keys.row.removeFailed");
            } finally {
                setBusy(null);
            }
            await load();
            onChanged?.();
            if (failed) showError(failed);
            if (keys > 0 || !failed) showSuccess(skipped > 0 ? t("keys.rows.removedSkipped", { count: keys, skipped }) : t("keys.rows.removedToast", { count: keys }));
            return !failed;
        },
        [base, load, onChanged, showError, showSuccess, t]
    );

    return { data, loading, notFound, busy, syncing, load, sync, toggleMine, addAllMine, removeEntry, removeLine, removeLines };
}
