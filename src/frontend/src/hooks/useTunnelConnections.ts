/**
 * 通道的連線紀錄與在線率（`GET /api/reverse/server/{id}/connections`），詳細資訊視窗打開時才抓。
 * A tunnel's connection history and uptime, fetched when the details dialog opens.
 */
import { useEffect, useState } from "react";
import { apiFetch, readJson } from "@/lib/api";

export interface ConnectionSession {
    ip: string | null;
    connected_at: string;
    disconnected_at: string | null;
    seconds: number | null;
}

export interface TunnelConnections {
    tracked_since: string | null;
    uptime: { h24: number | null; d7: number | null };
    hourly: (number | null)[];
    sessions: ConnectionSession[];
}

export function useTunnelConnections(tunnelId: number | null, isOpen: boolean) {
    // 結果記著是哪條通道的：換了通道就不顯示舊的（不必在 effect 裡清空）。/ Results are keyed by tunnel id.
    const [result, setResult] = useState<{ id: number; data: TunnelConnections | null; failed: boolean } | null>(null);

    useEffect(() => {
        if (!isOpen || !tunnelId) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await apiFetch(`/api/reverse/server/${tunnelId}/connections`);
                const body = await readJson<TunnelConnections>(res);
                if (cancelled) return;
                setResult({ id: tunnelId, data: res.ok && body ? body : null, failed: !(res.ok && body) });
            } catch {
                if (!cancelled) setResult({ id: tunnelId, data: null, failed: true });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [tunnelId, isOpen]);

    const current = isOpen && result?.id === tunnelId ? result : null;
    return { data: current?.data ?? null, failed: current?.failed ?? false };
}
