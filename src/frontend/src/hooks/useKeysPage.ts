/**
 * SSH 金鑰頁邏輯：我的金鑰（含指紋 / 最後使用）、我能用的裝置 × 我的金鑰（裝置金鑰清單）、新增 / 刪除 / 改說明、
 * 勾選把金鑰放進某台裝置的清單、立即同步；`?device=<id>` 直接打開那台裝置的管理視窗。
 * Keys page: my keys, the device × key matrix (device key lists), add / delete / describe, toggling a key on a
 * device, sync now; `?device=<id>` opens that device's panel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/types/notification";
import type { KeyDevice, UserKey } from "@/types/keys";
import { deviceKeyError } from "@/lib/deviceKeyErrors";

export interface NewKey {
    key: string;
    name: string;
    description: string;
    /** 建好後要放進哪些裝置的清單。/ Devices whose key list gets the new key. */
    deviceIds: number[];
}

export function useKeysPage() {
    const { showSuccess, showError } = useToast();
    const { t } = useI18n();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const [keys, setKeys] = useState<UserKey[]>([]);
    const [devices, setDevices] = useState<KeyDevice[]>([]);
    const [loading, setLoading] = useState(true);
    /** 正在切換的 `${tunnelId}:${keyId}`。/ Cells being toggled. */
    const [pending, setPending] = useState<Set<string>>(new Set());
    const [syncing, setSyncing] = useState<Set<number>>(new Set());

    const fetchKeys = useCallback(async () => {
        try {
            const res = await apiFetch("/api/reverse/user/keys");
            if (res.ok) setKeys(await res.json());
            else showError(t("keys.fetchFailed"));
        } catch (e) {
            showError(e instanceof Error ? e.message : t("keys.fetchFailed"));
        }
    }, [showError, t]);

    const fetchDevices = useCallback(async () => {
        try {
            const res = await apiFetch("/api/reverse/user/keys/devices");
            if (res.ok) setDevices(await res.json());
        } catch {
            /* the matrix just stays as it was */
        }
    }, []);

    const refresh = useCallback(async () => {
        setLoading(true);
        await Promise.all([fetchKeys(), fetchDevices()]);
        setLoading(false);
    }, [fetchKeys, fetchDevices]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    // 通知可能一次來好幾則（同步完每台裝置各一則）：合併成一次重抓。
    // Notifications arrive in bursts (one per synced device); coalesce them into one refetch.
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scheduleDevices = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(fetchDevices, 250);
    }, [fetchDevices]);
    useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current);
    }, []);
    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.DEVICE_KEYS_UPDATED]: scheduleDevices,
        [NOTIFICATION_ACTIONS.TUNNEL_SHARED]: scheduleDevices,
        [NOTIFICATION_ACTIONS.TUNNEL_UNSHARED]: scheduleDevices,
        [NOTIFICATION_ACTIONS.TUNNEL_PERMISSION_UPDATED]: scheduleDevices,
        [NOTIFICATION_ACTIONS.TUNNEL_USERNAMES_UPDATED]: scheduleDevices,
        [NOTIFICATION_ACTIONS.UPDATED_TUNNELS]: scheduleDevices,
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_STATUS]: scheduleDevices,
    });

    /** 金鑰 id → 在哪些裝置的清單上（含每個帳號的狀態）。/ Key id → devices whose list has it. */
    const placements = useMemo(() => {
        const map = new Map<number, { device: KeyDevice; targets: KeyDevice["keys"][number]["targets"] }[]>();
        for (const d of devices) {
            for (const k of d.keys) {
                const list = map.get(k.user_key_id) ?? [];
                list.push({ device: d, targets: k.targets });
                map.set(k.user_key_id, list);
            }
        }
        return map;
    }, [devices]);

    const addToDevice = useCallback(async (tunnelId: number, keyIds: number[]) => {
        const res = await apiFetch(`/api/reverse/server/${tunnelId}/device-keys`, { method: "POST", body: JSON.stringify({ user_key_ids: keyIds }) });
        if (!res.ok) throw new Error(deviceKeyError(res, await readJson(res), t("keys.toggleFailed")));
    }, [t]);

    const addKey = useCallback(
        async (k: NewKey): Promise<boolean> => {
            try {
                const res = await apiFetch("/api/reverse/user/keys", {
                    method: "POST",
                    body: JSON.stringify({ key: k.key.trim(), host_friendly_name: k.name.trim(), description: k.description }),
                });
                const body = await readJson<UserKey>(res);
                if (!res.ok || !body) {
                    showError(responseError(res, body, t("keys.addFailed")));
                    return false;
                }
                const failed: string[] = [];
                for (const id of k.deviceIds) {
                    try {
                        await addToDevice(id, [body.id]);
                    } catch {
                        failed.push(devices.find((d) => d.tunnel_id === id)?.host_friendly_name ?? String(id));
                    }
                }
                if (failed.length) showError(t("keys.addedButNotOn", { devices: failed.join(", ") }));
                else showSuccess(k.deviceIds.length ? t("keys.addedAndQueued", { count: k.deviceIds.length }) : t("keys.added"));
                await Promise.all([fetchKeys(), fetchDevices()]);
                return true;
            } catch (e) {
                showError(e instanceof Error ? e.message : t("keys.addFailed"));
                return false;
            }
        },
        [addToDevice, devices, fetchDevices, fetchKeys, showError, showSuccess, t]
    );

    const deleteKey = useCallback(
        async (key: UserKey): Promise<boolean> => {
            try {
                const res = await apiFetch(`/api/reverse/user/keys/${key.id}`, { method: "DELETE" });
                if (!res.ok) {
                    showError(t("keys.deleteFailed"));
                    return false;
                }
                showSuccess(t("keys.deleted", { name: key.host_friendly_name }));
                await Promise.all([fetchKeys(), fetchDevices()]);
                return true;
            } catch (e) {
                showError(e instanceof Error ? e.message : t("keys.deleteFailed"));
                return false;
            }
        },
        [fetchDevices, fetchKeys, showError, showSuccess, t]
    );

    const updateDescription = useCallback(
        async (key: UserKey, description: string): Promise<boolean> => {
            try {
                const res = await apiFetch(`/api/reverse/user/keys/${key.id}`, { method: "PATCH", body: JSON.stringify({ description }) });
                if (!res.ok) {
                    showError(t("keys.descriptionUpdateFailed"));
                    return false;
                }
                const updated: UserKey = await res.json();
                setKeys((prev) => prev.map((k) => (k.id === updated.id ? updated : k)));
                showSuccess(t("keys.descriptionUpdated"));
                return true;
            } catch (e) {
                showError(e instanceof Error ? e.message : t("keys.descriptionUpdateFailed"));
                return false;
            }
        },
        [showError, showSuccess, t]
    );

    /** 勾選 / 取消：把我的金鑰放進或移出某台裝置的清單。/ Put a key on, or take it off, a device's list. */
    const toggle = useCallback(
        async (device: KeyDevice, key: UserKey, on: boolean) => {
            const cell = `${device.tunnel_id}:${key.id}`;
            setPending((s) => new Set(s).add(cell));
            try {
                if (on) {
                    await addToDevice(device.tunnel_id, [key.id]);
                } else {
                    const res = await apiFetch(`/api/reverse/server/${device.tunnel_id}/device-keys/${key.id}`, { method: "DELETE" });
                    if (!res.ok) throw new Error(deviceKeyError(res, await readJson(res), t("keys.toggleFailed")));
                }
                await fetchDevices();
            } catch (e) {
                showError(e instanceof Error ? e.message : t("keys.toggleFailed"));
            } finally {
                setPending((s) => {
                    const next = new Set(s);
                    next.delete(cell);
                    return next;
                });
            }
        },
        [addToDevice, fetchDevices, showError, t]
    );

    const syncDevice = useCallback(
        async (device: KeyDevice) => {
            setSyncing((s) => new Set(s).add(device.tunnel_id));
            try {
                const res = await apiFetch(`/api/reverse/server/${device.tunnel_id}/device-keys/sync`, { method: "POST" });
                if (res.ok) showSuccess(t("keys.synced", { device: device.host_friendly_name }));
                else showError(deviceKeyError(res, await readJson(res), t("keys.syncFailed")));
                await fetchDevices();
            } catch (e) {
                showError(e instanceof Error ? e.message : t("keys.syncFailed"));
            } finally {
                setSyncing((s) => {
                    const next = new Set(s);
                    next.delete(device.tunnel_id);
                    return next;
                });
            }
        },
        [fetchDevices, showError, showSuccess, t]
    );

    // ?device=<id>：從隧道選單直接打開某台裝置的管理視窗。/ Deep link from the tunnel menu.
    const deviceParam = Number(searchParams.get("device")) || null;
    const openDevice = useCallback(
        (id: number | null) => {
            const params = new URLSearchParams(searchParams.toString());
            if (id) params.set("device", String(id));
            else params.delete("device");
            const qs = params.toString();
            router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
        },
        [pathname, router, searchParams]
    );

    return {
        keys,
        devices,
        loading,
        placements,
        pending,
        syncing,
        openDeviceId: deviceParam,
        refresh,
        fetchDevices,
        addKey,
        deleteKey,
        updateDescription,
        toggle,
        syncDevice,
        openDevice,
    };
}
