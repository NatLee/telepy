"use client";

/**
 * 裝置代理的資料：能經哪些通道代理（`GET /api/proxy/tunnels`）與開著的代理 session（`GET /api/proxy/sessions`）；
 * 有 session 開 / 關時（`PROXY-SESSION-*` 通知）重抓，開著時每 5 秒更新一次流量數字。
 * The device proxy's data: the tunnels it may use and the open sessions; refetched when one opens or closes
 * (`PROXY-SESSION-*`), and every 5 s while any is open so the counters move.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/types/notification";
import { sortSessions, type ProxyInfo, type ProxySession } from "@/lib/proxy";

export function useProxy(scope: "mine" | "all" = "mine") {
    const [info, setInfo] = useState<ProxyInfo | null>(null);
    const [sessions, setSessions] = useState<ProxySession[]>([]);
    const [failed, setFailed] = useState(false);

    const loadSessions = useCallback(async () => {
        try {
            const res = await apiFetch(`/api/proxy/sessions${scope === "all" ? "?scope=all" : ""}`);
            if (res.ok) setSessions(sortSessions(((await readJson(res)) as ProxySession[]) ?? []));
        } catch {
            /* 下一輪再試 / the next round retries */
        }
    }, [scope]);

    const load = useCallback(async (): Promise<boolean> => {
        try {
            const res = await apiFetch("/api/proxy/tunnels");
            if (!res.ok) {
                setFailed(true);
                return false;
            }
            setInfo((await readJson(res)) as ProxyInfo);
            setFailed(false);
            await loadSessions();
            return true;
        } catch {
            setFailed(true);
            return false;
        }
    }, [loadSessions]);

    // 下一個 tick 再抓（React 開發模式先掛上又卸下時，第一次的會被取消）。/ On the next tick (React's dev-mode mount-unmount-mount cancels the first).
    useEffect(() => {
        const id = setTimeout(() => void load(), 0);
        return () => clearTimeout(id);
    }, [load]);

    const handlers = useMemo(
        () => ({
            [NOTIFICATION_ACTIONS.PROXY_SESSION_OPENED]: () => void loadSessions(),
            [NOTIFICATION_ACTIONS.PROXY_SESSION_CLOSED]: () => void loadSessions(),
        }),
        [loadSessions]
    );
    useNotificationHandlers(handlers);

    const open = sessions.length > 0;
    useEffect(() => {
        if (!open) return;
        const id = setInterval(() => void loadSessions(), 5000);
        return () => clearInterval(id);
    }, [open, loadSessions]);

    const end = useCallback(
        async (id: string): Promise<boolean> => {
            const res = await apiFetch(`/api/proxy/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
            await loadSessions();
            return res.ok || res.status === 404;
        },
        [loadSessions]
    );

    return { info, sessions, failed, reload: load, end };
}
