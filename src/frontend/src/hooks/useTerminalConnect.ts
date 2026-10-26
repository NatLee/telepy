"use client";

/**
 * 終端機頁沒帶 `serverId` 時的選擇器資料：裝置、可用帳號、區網主機與上線狀態都來自 `GET /api/reverse/lan/topology`
 * （和遠端桌面頁同一份）；選定的裝置 / 主機記在網址（`?tunnel=<id>&lanHost=<id>`），上次開的裝置記在
 * localStorage（`telepy.terminalPick`），沒帶參數時從那台開始。按「開啟終端機」= 導到帶 `serverId` 的終端機頁。
 * Data for the terminal page's picker (shown without `serverId`): devices, allowed accounts, LAN hosts and online
 * state from the topology endpoint (the same one the desktop page uses); the selection lives in the URL
 * (`?tunnel=&lanHost=`), the last device in localStorage. "Open terminal" navigates to the terminal page with `serverId`.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { apiFetch, readJson } from "@/lib/api";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS, type NotificationPayload } from "@/lib/notificationActions";
import { getTerminalPageUrl } from "@/lib/tunnelUrls";
import { isValidLogin } from "@/lib/lanConnect";
import type { LanHost, TopologyTunnel } from "@/types/lan";

const PICK_KEY = "telepy.terminalPick";

function readPick(): number | null {
    try {
        const v = Number(localStorage.getItem(PICK_KEY));
        return Number.isInteger(v) && v > 0 ? v : null;
    } catch {
        return null;
    }
}

export function useTerminalConnect() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const tunnelParam = searchParams.get("tunnel");
    const hostParam = searchParams.get("lanHost");

    const [tunnels, setTunnels] = useState<TopologyTunnel[]>([]);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    const [ports, setPorts] = useState<Record<string, boolean>>({});
    const [latency, setLatency] = useState<Record<string, number>>({});
    const [account, setAccount] = useState("");
    const [login, setLogin] = useState("");

    const load = useCallback(async () => {
        try {
            const res = await apiFetch("/api/reverse/lan/topology");
            const data = res.ok ? await readJson<{ tunnels?: TopologyTunnel[] }>(res) : null;
            setFailed(!res.ok);
            setTunnels(Array.isArray(data?.tunnels) ? data!.tunnels : []);
        } catch {
            setFailed(true);
        } finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => { void load(); }, [load]);

    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_STATUS]: (msg: NotificationPayload) => {
            if (msg.port !== undefined) setPorts((prev) => ({ ...prev, [String(msg.port)]: msg.status === "connected" }));
        },
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_STATUS_DATA]: (msg: NotificationPayload) => {
            if (!Array.isArray(msg.data)) return;
            const map: Record<string, boolean> = {};
            for (const p of msg.data) map[String(p)] = true;
            setPorts(map);
        },
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_LATENCY]: (msg: NotificationPayload) => {
            const map = (msg as { latency?: Record<string, number> }).latency;
            if (map) setLatency(map);
        },
        // 掃描完 / 主機被改了：重讀清單（主機選單才會跟上）。/ A scan or an edit changed the hosts: reload the list.
        [NOTIFICATION_ACTIONS.UPDATED_LAN_HOSTS]: () => { void load(); },
    });

    const tunnel = useMemo(() => tunnels.find((tn) => String(tn.id) === tunnelParam) ?? null, [tunnels, tunnelParam]);
    const host: LanHost | null = useMemo(() => (tunnel && hostParam ? tunnel.hosts.find((h) => String(h.id) === hostParam) ?? null : null), [tunnel, hostParam]);
    const isOnline = useCallback((tn: TopologyTunnel) => ports[String(tn.reverse_port)] ?? tn.online ?? false, [ports]);
    const online = tunnel ? isOnline(tunnel) : false;
    const rtt = tunnel ? latency[String(tunnel.reverse_port)] ?? tunnel.rtt_ms : null;

    const replaceQuery = useCallback((patch: Record<string, string | null>) => {
        const params = new URLSearchParams(searchParams.toString());
        for (const [k, v] of Object.entries(patch)) {
            if (v === null) params.delete(k);
            else params.set(k, v);
        }
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    }, [pathname, router, searchParams]);

    // 沒帶 / 帶錯 ?tunnel=：上次開的那台，否則第一台線上、有帳號的裝置。/ Default: the last device, else the first online one with an account.
    useEffect(() => {
        if (loading || tunnels.length === 0 || tunnel) return;
        const remembered = readPick();
        const pick = tunnels.find((tn) => tn.id === remembered)
            ?? tunnels.find((tn) => isOnline(tn) && tn.usernames.length > 0)
            ?? tunnels.find((tn) => tn.usernames.length > 0)
            ?? tunnels[0];
        replaceQuery({ tunnel: String(pick.id), lanHost: null });
    }, [loading, tunnels, tunnel, replaceQuery, isOnline]);

    // 換裝置 → 預設帳號；換主機 → 主機記錄的登入名。/ New device → its default account; new host → its saved login.
    useEffect(() => {
        if (!tunnel) return;
        setAccount((a) => (tunnel.usernames.includes(a) ? a : tunnel.default_username && tunnel.usernames.includes(tunnel.default_username) ? tunnel.default_username : tunnel.usernames[0] ?? ""));
    }, [tunnel]);
    useEffect(() => {
        setLogin(host?.username ?? "");
    }, [host]);

    const setTunnel = useCallback((id: number) => replaceQuery({ tunnel: String(id), lanHost: null }), [replaceQuery]);
    const setHost = useCallback((id: number | null) => replaceQuery({ lanHost: id === null ? null : String(id) }), [replaceQuery]);

    const cleanLogin = login.trim();
    const loginOk = !host || isValidLogin(cleanLogin);
    const canOpen = !!tunnel && online && !!account && loginOk;
    const href = tunnel ? getTerminalPageUrl({ id: tunnel.id, reverse_port: tunnel.reverse_port }, host ? { lanHost: host.id, lanUser: cleanLogin || undefined } : undefined) : null;

    const open = useCallback(() => {
        if (!href || !tunnel) return;
        try { localStorage.setItem(PICK_KEY, String(tunnel.id)); } catch { /* 無痕模式 / private mode */ }
        router.push(href);
    }, [href, tunnel, router]);

    return {
        state: { tunnels, loading, failed, tunnel, host, online, rtt, account, login, loginOk, canOpen, href },
        actions: { setTunnel, setHost, setAccount, setLogin, open, isOnline, reload: load },
    };
}
