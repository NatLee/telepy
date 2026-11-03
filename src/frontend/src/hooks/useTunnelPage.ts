"use client";

/**
 * 通道頁面的資料：跟列表同一支 `GET /api/reverse/server/dashboard`（列表項目才有健康、在用、分享對象、裝置上的安裝
 * 摘要），挑出這一條；在線 / 延遲 / 健康 / 在用人數跟列表一樣由通知即時更新，其他變動靜默重抓。看不到（刪了、取消分享、
 * id 不對）= `missing`。
 * The tunnel page's data: the list's own `GET /api/reverse/server/dashboard` (only list items carry health, presence,
 * sharees and the install summary), picking this tunnel; online / latency / health / presence follow the notifications
 * live like the list, other changes refetch quietly. Not visible (deleted, unshared, wrong id) = `missing`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/types/notification";
import type { Tunnel } from "@/types/tunnel";

export type TunnelPageState = "loading" | "ok" | "missing" | "error";

/** 這些通知一來就靜默重抓（只要跟這條有關，或沒說是哪條）。/ These refetch quietly when about this tunnel (or none named). */
const RELOAD_ON = [
    NOTIFICATION_ACTIONS.TUNNEL_IP_CHANGED,
    NOTIFICATION_ACTIONS.DEVICE_WARNING,
    NOTIFICATION_ACTIONS.DEVICE_FACTS_UPDATED,
    NOTIFICATION_ACTIONS.TUNNEL_SHARED,
    NOTIFICATION_ACTIONS.TUNNEL_UNSHARED,
    NOTIFICATION_ACTIONS.TUNNEL_PERMISSION_UPDATED,
    NOTIFICATION_ACTIONS.ACCESS_REQUEST_CREATED,
    NOTIFICATION_ACTIONS.ACCESS_REQUEST_DECIDED,
    NOTIFICATION_ACTIONS.ACCESS_REQUEST_UPDATED,
    NOTIFICATION_ACTIONS.TUNNEL_USERNAMES_UPDATED,
    NOTIFICATION_ACTIONS.UPDATED_TUNNELS,
    NOTIFICATION_ACTIONS.HOST_KEY_CHANGED,
    NOTIFICATION_ACTIONS.DEVICE_CLAIM_ATTEMPT,
    NOTIFICATION_ACTIONS.DEVICE_INSTALL_UPDATED,
] as const;

type Fetched = { kind: "ok"; tunnel: Tunnel; online: boolean; latency: number | null } | { kind: "missing" } | { kind: "error" };

/** 讀列表、挑出這一條（不碰 React 狀態）。/ Read the list and pick this tunnel (no React state). */
async function fetchTunnel(id: number): Promise<Fetched> {
    try {
        const res = await apiFetch("/api/reverse/server/dashboard");
        const data = await readJson<{ tunnels?: Tunnel[]; ports?: Record<string, boolean>; latency?: Record<string, number> }>(res);
        if (!res.ok || !data) return { kind: "error" };
        const found = (data.tunnels ?? []).find((t) => t.id === id);
        if (!found) return { kind: "missing" };
        const rtt = data.latency?.[String(found.reverse_port)];
        return { kind: "ok", tunnel: found, online: data.ports?.[String(found.reverse_port)] === true, latency: typeof rtt === "number" ? rtt : null };
    } catch {
        return { kind: "error" };
    }
}

export function useTunnelPage(id: number | null) {
    const [tunnel, setTunnel] = useState<Tunnel | null>(null);
    const [state, setState] = useState<TunnelPageState>("loading");
    // 讀到的是哪條：換了 id 就先當作載入中，不必在 effect 裡清空。/ Which id was loaded: another id reads as loading.
    const [loadedId, setLoadedId] = useState<number | null>(null);
    const [online, setOnline] = useState(false);
    const [latency, setLatency] = useState<number | null>(null);
    const portRef = useRef<number | null>(null);

    // 讀到結果後才 setState（在 await 之後），effect 本身不直接改狀態。/ State changes only after the await.
    const apply = useCallback(
        (r: Fetched) => {
            if (r.kind === "error") {
                setState((s) => (s === "ok" ? s : "error"));
                return;
            }
            setLoadedId(id);
            if (r.kind === "missing") {
                setTunnel(null);
                setState("missing");
                return;
            }
            portRef.current = r.tunnel.reverse_port;
            setTunnel(r.tunnel);
            setOnline(r.online);
            setLatency(r.latency);
            setState("ok");
        },
        [id],
    );

    const load = useCallback(async (): Promise<boolean> => {
        if (!id) return false;
        const r = await fetchTunnel(id);
        apply(r);
        return r.kind !== "error";
    }, [id, apply]);

    useEffect(() => {
        if (!id) return;
        let cancelled = false;
        (async () => {
            const r = await fetchTunnel(id);
            if (!cancelled) apply(r);
        })();
        return () => {
            cancelled = true;
        };
    }, [id, apply]);

    // 連續的通知合併成一次重抓。/ Bursts coalesce into one refetch.
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const reloadSoon = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            timer.current = null;
            void load();
        }, 600);
    }, [load]);
    useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current);
    }, []);

    const handlers: Record<string, (msg: Record<string, unknown>) => void> = {
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_STATUS_DATA]: (msg) => {
            if (Array.isArray(msg.data) && portRef.current !== null) setOnline(msg.data.map(String).includes(String(portRef.current)));
        },
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_STATUS]: (msg) => {
            if (msg.port !== undefined && String(msg.port) === String(portRef.current)) {
                setOnline(msg.status === "connected");
                reloadSoon();
            }
        },
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_LATENCY]: (msg) => {
            const map = msg.latency as Record<string, number> | undefined;
            const rtt = map && portRef.current !== null ? map[String(portRef.current)] : undefined;
            if (typeof rtt === "number") setLatency(rtt);
        },
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_HEALTH]: (msg) => {
            const health = msg.health;
            if (msg.tunnel_id === id && (health === "online" || health === "degraded" || health === "offline")) setTunnel((t) => (t ? { ...t, health } : t));
        },
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_PRESENCE]: (msg) => {
            if (msg.tunnel_id !== id || typeof msg.count !== "number") return;
            const count = msg.count;
            setTunnel((t) => (t ? { ...t, presence: { count, sessions: t.presence?.sessions ?? null } } : t));
            reloadSoon();
        },
    };
    for (const action of RELOAD_ON) {
        handlers[action] = (msg) => {
            if (msg.tunnel_id === undefined || msg.tunnel_id === id) reloadSoon();
        };
    }
    useNotificationHandlers(handlers);

    const current = loadedId === id;
    return { tunnel: current ? tunnel : null, state: current ? state : !id ? "missing" : state === "error" ? "error" : "loading", online, latency, reload: load };
}
