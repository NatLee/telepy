"use client";

/**
 * 登記在 Telepy（當 RustDesk 伺服器）的 RustDesk 裝置：清單、改名、移除；`RUSTDESK-DEVICES-UPDATED` 通知時重抓。
 * RustDesk devices enrolled with Telepy's RustDesk server: list, rename, remove; refetched on notifications.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import type { NotificationPayload } from "@/types/notification";
import { sortDevices, type RustDeskDevice, type RustDeskDeviceSession, type RustDeskServerSettings } from "@/lib/rustdeskDevices";

interface ListResponse {
    server?: RustDeskServerSettings;
    devices?: RustDeskDevice[];
}

export function useRustDeskDevices() {
    const [devices, setDevices] = useState<RustDeskDevice[]>([]);
    const [server, setServer] = useState<RustDeskServerSettings | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [failed, setFailed] = useState(false);

    const reload = useCallback(async () => {
        try {
            const res = await apiFetch("/api/rustdesk/devices");
            const data = res.ok ? await readJson<ListResponse>(res) : null;
            if (data) {
                setDevices(Array.isArray(data.devices) ? data.devices : []);
                setServer(data.server ?? null);
            }
            setFailed(!data);
        } catch {
            setFailed(true);
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!cancelled) await reload();
        })();
        return () => { cancelled = true; };
    }, [reload]);

    const handlers = useMemo(() => ({ [NOTIFICATION_ACTIONS.RUSTDESK_DEVICES_UPDATED]: () => void reload() }), [reload]);
    useNotificationHandlers(handlers);

    /** 改名；成功回 null，失敗回錯誤訊息。/ Rename; null on success, else the error message. */
    const rename = useCallback(async (id: number, name: string): Promise<string | null> => {
        const res = await apiFetch(`/api/rustdesk/devices/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
        const data = await readJson<{ name?: string[] | string; detail?: string }>(res);
        if (res.ok) {
            void reload();
            return null;
        }
        return Array.isArray(data?.name) ? data.name[0] : data?.detail ?? "";
    }, [reload]);

    const remove = useCallback(async (id: number): Promise<boolean> => {
        const res = await apiFetch(`/api/rustdesk/devices/${id}`, { method: "DELETE" });
        if (res.ok) setDevices((list) => list.filter((d) => d.id !== id));
        return res.ok;
    }, []);

    const sorted = useMemo(() => sortDevices(devices), [devices]);
    return { devices: sorted, server, loaded, failed, reload, rename, remove };
}

export type RustDeskDevices = ReturnType<typeof useRustDeskDevices>;

/** 一台裝置最近的瀏覽器連線：`enabled` 時（對話框開著）抓、連線開關時（通知）重抓；關掉時留著上次的結果，
 *  關閉動畫期間不會閃回載入中。/ A device's recent browser sessions, fetched while `enabled` and refetched when
 *  sessions open or close; the last result is kept while closed so the closing animation does not flash. */
export function useRustDeskDeviceSessions(deviceId: number | null, enabled: boolean) {
    const [result, setResult] = useState<{ id: number; sessions: RustDeskDeviceSession[] | null } | null>(null);

    const load = useCallback(async (id: number) => {
        try {
            const res = await apiFetch(`/api/rustdesk/devices/${id}/sessions`);
            const data = res.ok ? await readJson<{ sessions?: RustDeskDeviceSession[] }>(res) : null;
            setResult({ id, sessions: Array.isArray(data?.sessions) ? data.sessions : null });
        } catch {
            setResult({ id, sessions: null });
        }
    }, []);

    useEffect(() => {
        if (deviceId === null || !enabled) return;
        const first = setTimeout(() => void load(deviceId), 0);
        return () => clearTimeout(first);
    }, [deviceId, enabled, load]);

    const handlers = useMemo(() => ({
        [NOTIFICATION_ACTIONS.RUSTDESK_DEVICES_UPDATED]: (msg: NotificationPayload) => {
            if (enabled && deviceId !== null && msg.device_id === deviceId) void load(deviceId);
        },
    }), [deviceId, enabled, load]);
    useNotificationHandlers(handlers);

    const current = result && result.id === deviceId ? result : null;
    return { sessions: current?.sessions ?? [], loaded: !!current, failed: !!current && current.sessions === null };
}
