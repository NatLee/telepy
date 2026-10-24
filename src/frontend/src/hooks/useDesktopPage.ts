"use client";

/**
 * 遠端桌面頁的資料與流程。裝置、可用帳號、區網主機與上線狀態都來自 `GET /api/reverse/lan/topology`；
 * 選定的裝置 / 主機記在網址（`?tunnel=<id>&lanHost=<id>`），隧道選單與網路頁的主機對話框都深連結過來。
 * 連線：`POST …/desktop/start`（帳密只送這一次、連上後就從頁面狀態清掉）→ DesktopViewer 用票證開 WS。
 * Data and flow for the remote desktop page. Devices, allowed accounts, LAN hosts and online state come from the
 * topology endpoint; the selection lives in the URL. Credentials are sent once and cleared once connected.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { apiFetch, readJson } from "@/lib/api";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS, type NotificationPayload } from "@/lib/notificationActions";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { DEFAULT_PORT, desktopPorts, isValidPort, startFailure, type DesktopFailure, type DesktopPhase, type DesktopProtocol, type DesktopStart } from "@/lib/desktop";
import type { LanHost, TopologyTunnel } from "@/types/lan";

export interface DesktopForm {
    account: string;
    protocol: DesktopProtocol;
    port: string;
    login: string;
    password: string;
    domain: string;
}

const EMPTY_FORM: DesktopForm = { account: "", protocol: "rdp", port: String(DEFAULT_PORT.rdp), login: "", password: "", domain: "" };

export function useDesktopPage() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const tunnelParam = searchParams.get("tunnel");
    const hostParam = searchParams.get("lanHost");
    const { t } = useI18n();
    const { showError } = useToast();

    const [tunnels, setTunnels] = useState<TopologyTunnel[]>([]);
    const [loading, setLoading] = useState(true);
    const [ports, setPorts] = useState<Record<string, boolean>>({});
    const [form, setForm] = useState<DesktopForm>(EMPTY_FORM);
    const [phase, setPhase] = useState<DesktopPhase>("idle");
    const [failure, setFailure] = useState<DesktopFailure | null>(null);
    const [session, setSession] = useState<DesktopStart | null>(null);
    const [connectedAt, setConnectedAt] = useState<number | null>(null);
    const [endedNormally, setEndedNormally] = useState(false);
    const sessionRef = useRef<DesktopStart | null>(null);
    sessionRef.current = session;

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await apiFetch("/api/reverse/lan/topology");
                const data = res.ok ? await readJson<{ tunnels?: TopologyTunnel[] }>(res) : null;
                if (cancelled) return;
                if (!res.ok) showError(t("desktop.loadFailed"));
                setTunnels(Array.isArray(data?.tunnels) ? data!.tunnels : []);
            } catch {
                if (!cancelled) showError(t("desktop.loadFailed"));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [showError, t]);

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
    });

    const tunnel = useMemo(() => tunnels.find((tn) => String(tn.id) === tunnelParam) ?? null, [tunnels, tunnelParam]);
    const host: LanHost | null = useMemo(() => (tunnel && hostParam ? tunnel.hosts.find((h) => String(h.id) === hostParam) ?? null : null), [tunnel, hostParam]);
    const online = tunnel ? (ports[String(tunnel.reverse_port)] ?? tunnel.online ?? false) : false;

    const replaceQuery = useCallback((patch: Record<string, string | null>) => {
        const params = new URLSearchParams(searchParams.toString());
        for (const [k, v] of Object.entries(patch)) {
            if (v === null) params.delete(k);
            else params.set(k, v);
        }
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    }, [pathname, router, searchParams]);

    // 沒帶 / 帶錯 ?tunnel=：選第一台線上、有帳號的裝置。/ Default to the first online device with an account.
    useEffect(() => {
        if (loading || tunnels.length === 0 || tunnel) return;
        const pick = tunnels.find((tn) => tn.online && tn.usernames.length > 0) ?? tunnels.find((tn) => tn.usernames.length > 0) ?? tunnels[0];
        replaceQuery({ tunnel: String(pick.id), lanHost: null });
    }, [loading, tunnels, tunnel, replaceQuery]);

    // 換裝置 → 預設帳號；換主機 → 依掃描到的桌面服務預填協定與埠。
    // New device → its default account; new host → protocol and port from the desktop services it was seen with.
    useEffect(() => {
        if (!tunnel) return;
        setForm((f) => ({ ...f, account: tunnel.usernames.includes(f.account) ? f.account : tunnel.default_username && tunnel.usernames.includes(tunnel.default_username) ? tunnel.default_username : tunnel.usernames[0] ?? "" }));
    }, [tunnel]);
    useEffect(() => {
        const seen = host ? desktopPorts(host.open_ports) : [];
        if (seen.length > 0) setForm((f) => ({ ...f, protocol: seen[0].protocol, port: String(seen[0].port) }));
    }, [host]);

    const setTunnel = useCallback((id: number) => replaceQuery({ tunnel: String(id), lanHost: null }), [replaceQuery]);
    const setHost = useCallback((id: number | null) => replaceQuery({ lanHost: id === null ? null : String(id) }), [replaceQuery]);
    const update = useCallback((patch: Partial<DesktopForm>) => setForm((f) => ({ ...f, ...patch })), []);
    const setProtocol = useCallback((protocol: DesktopProtocol) => {
        setForm((f) => {
            const other: DesktopProtocol = protocol === "rdp" ? "vnc" : "rdp";
            const port = f.port === String(DEFAULT_PORT[other]) || !isValidPort(f.port) ? String(DEFAULT_PORT[protocol]) : f.port;
            return { ...f, protocol, port };
        });
    }, []);

    const address = host ? `${host.address}:${form.port}` : `127.0.0.1:${form.port}`;
    const canConnect = !!tunnel && online && !!form.account && isValidPort(form.port) && (phase === "idle" || phase === "failed");

    const connect = useCallback(async () => {
        if (!tunnel) return;
        setFailure(null);
        setEndedNormally(false);
        setPhase("starting");
        try {
            const res = await apiFetch(`/api/reverse/server/${tunnel.id}/desktop/start`, {
                method: "POST",
                body: JSON.stringify({
                    protocol: form.protocol,
                    username: form.account,
                    port: Number(form.port),
                    lan_host_id: host?.id ?? null,
                    login: form.login.trim(),
                    password: form.password,
                    domain: form.protocol === "rdp" ? form.domain.trim() : "",
                }),
            });
            const data = await readJson<DesktopStart & { code?: string; error?: string }>(res);
            if (!res.ok || !data?.ticket) {
                setFailure(startFailure(data?.code, res.status, { account: form.account, address }));
                setPhase("failed");
                return;
            }
            setSession(data);
            setPhase("connecting");
        } catch {
            setFailure({ key: "desktop.err.network", at: "web" });
            setPhase("failed");
        }
    }, [tunnel, host, form, address]);

    const onConnected = useCallback(() => {
        setPhase("connected");
        setConnectedAt(Date.now());
        // 連上了就不留密碼。/ Drop the password once connected.
        setForm((f) => ({ ...f, password: "" }));
    }, []);

    const onEnded = useCallback((f: DesktopFailure | null) => {
        setSession(null);
        setConnectedAt(null);
        if (f) {
            setFailure(f);
            setPhase("failed");
        } else {
            setPhase("idle");
            setEndedNormally(true);
        }
    }, []);

    const postStop = useCallback((sid: string) => {
        void apiFetch(`/api/reverse/server/desktop/${sid}/stop`, { method: "POST", body: "{}", keepalive: true }).catch(() => undefined);
    }, []);

    /** 使用者按「中斷連線」：先請後端結束（還沒認領的票證也作廢）。/ User disconnect: end it server-side too. */
    const stop = useCallback(() => {
        const s = sessionRef.current;
        if (s) postStop(s.session_id);
        setSession(null);
        setConnectedAt(null);
        setPhase("idle");
        setEndedNormally(true);
    }, [postStop]);

    useEffect(() => {
        const onUnload = () => { const s = sessionRef.current; if (s) postStop(s.session_id); };
        window.addEventListener("beforeunload", onUnload);
        return () => {
            window.removeEventListener("beforeunload", onUnload);
            onUnload();
        };
    }, [postStop]);

    return {
        state: { tunnels, loading, tunnel, host, online, form, phase, failure, session, connectedAt, endedNormally, canConnect, address },
        actions: { setTunnel, setHost, update, setProtocol, connect, stop, onConnected, onEnded, dismissFailure: () => { setFailure(null); setPhase("idle"); } },
    };
}
