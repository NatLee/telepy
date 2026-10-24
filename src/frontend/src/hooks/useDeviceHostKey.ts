"use client";

/**
 * 裝置 SSH host key（`GET /api/reverse/server/{id}/host-key`）：釘選的、被拒絕待確認的，以及確認 / 忘掉。
 * The device's pinned and refused SSH host keys, plus accept / forget.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";

export interface HostKey {
    key_type: string;
    fingerprint: string;
    public_key: string;
    /** first_use | accepted */
    source: string;
    attempts: number;
    first_seen: string;
    last_seen: string;
}

export interface DeviceHostKeys {
    pinned: HostKey[];
    rejected: HostKey[];
    can_manage: boolean;
}

export function useDeviceHostKey(tunnelId: number | null, isOpen: boolean, onChanged?: () => void) {
    const { t } = useI18n();
    const { showError, showSuccess } = useToast();
    const [result, setResult] = useState<{ id: number; data: DeviceHostKeys | null } | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async (id: number) => {
        try {
            const res = await apiFetch(`/api/reverse/server/${id}/host-key`);
            const body = await readJson<DeviceHostKeys>(res);
            setResult({ id, data: res.ok && body ? body : null });
        } catch {
            setResult({ id, data: null });
        }
    }, []);

    useEffect(() => {
        if (isOpen && tunnelId) void load(tunnelId);
    }, [isOpen, tunnelId, load]);

    const change = useCallback(async (method: "POST" | "DELETE", path: string, body: unknown, done: string) => {
        if (!tunnelId) return;
        setBusy(true);
        try {
            const res = await apiFetch(`/api/reverse/server/${tunnelId}/host-key${path}`, { method, body: body ? JSON.stringify(body) : undefined });
            const data = await readJson<DeviceHostKeys>(res);
            if (!res.ok || !data) {
                showError(responseError(res, data, t("hostKey.changeFailed")));
                return;
            }
            setResult({ id: tunnelId, data });
            showSuccess(done);
            onChanged?.();
        } catch {
            showError(t("hostKey.changeFailed"));
        } finally {
            setBusy(false);
        }
    }, [tunnelId, onChanged, showError, showSuccess, t]);

    return {
        data: result && result.id === tunnelId ? result.data : null,
        loaded: !!result && result.id === tunnelId,
        busy,
        accept: (fingerprint: string) => change("POST", "/accept", { fingerprint }, t("hostKey.accepted")),
        forget: () => change("DELETE", "", null, t("hostKey.forgotten")),
    };
}
