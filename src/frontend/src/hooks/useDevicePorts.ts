"use client";

/**
 * 問裝置「你現在在聽哪些 port」（遠端瀏覽器面板用）。`enabled` 變 true 時問一次，`refresh()` 再問；換裝置 / 帳號時
 * 舊的回應丟掉。
 * Asks the device which ports it listens on (for the remote browser panel): once when `enabled` turns true, again on
 * `refresh()`; a late answer for another device / account is dropped.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { portsErrorKey, type DevicePortsData } from "@/lib/devicePorts";
import { useI18n } from "@/lib/i18n";

export function useDevicePorts(serverId: number | string, username: string, enabled: boolean) {
    const { t } = useI18n();
    const [data, setData] = useState<DevicePortsData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const gen = useRef(0);

    const load = useCallback(async (): Promise<boolean> => {
        const mine = ++gen.current;
        setLoading(true);
        try {
            const res = await apiFetch(`/api/reverse/server/${serverId}/remote-browser/ports?username=${encodeURIComponent(username)}`);
            const body = await readJson(res);
            if (mine !== gen.current) return true;
            if (!res.ok) {
                const key = portsErrorKey((body as { code?: unknown } | null)?.code);
                setError(key ? t(key) : t("browser.ports.failed", { error: responseError(res, body, t("browser.unknownError")) }));
                return false;
            }
            setData(body as DevicePortsData);
            setError(null);
            return true;
        } catch {
            if (mine === gen.current) setError(t("browser.ports.failed", { error: t("browser.unknownError") }));
            return false;
        } finally {
            if (mine === gen.current) setLoading(false);
        }
    }, [serverId, username, t]);

    useEffect(() => {
        if (!enabled) return;
        setData(null);
        setError(null);
        void load();
        return () => {
            // 計數器不是 DOM ref：就是要在收掉時讓還沒回來的那次作廢。/ A counter, not a DOM ref: bumping it here is what drops the late answer.
            // eslint-disable-next-line react-hooks/exhaustive-deps
            gen.current++;
        };
    }, [enabled, load]);

    return { data, loading, error, refresh: load };
}
