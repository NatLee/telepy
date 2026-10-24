"use client";

/**
 * 遠端桌面頁的資料與流程。裝置、可用帳號、區網主機與上線狀態都來自 `GET /api/reverse/lan/topology`；
 * 選定的裝置 / 主機記在網址（`?tunnel=<id>&lanHost=<id>`），隧道選單與網路頁的主機對話框都深連結過來。
 * 連線：`POST …/desktop/start`（帳密只送這一次、連上後就從頁面狀態清掉）→ DesktopViewer 用票證開 WS。
 * 連線中：中繼每秒的串流統計（`stats`）、tunnel 不穩旗標、整張畫面的大小；VNC 連到裝置自己時向
 * `GET …/desktop/screens` 問螢幕配置，選的螢幕記在 localStorage（每個目標一個）。
 * Data and flow for the remote desktop page. Devices, allowed accounts, LAN hosts and online state come from the
 * topology endpoint; the selection lives in the URL. Credentials are sent once and cleared once connected.
 * While connected: the relay's per-second stats, the tunnel's unstable flag, the framebuffer size and, for VNC
 * on the device itself, the detected screen layout.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { apiFetch, readJson } from "@/lib/api";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS, type NotificationPayload } from "@/lib/notificationActions";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import {
    CTRL_MODE_VALUES,
    ctrlAsCmd,
    DEFAULT_PORT,
    desktopPorts,
    isMacBrowser,
    isValidPort,
    pixelRatioFor,
    QUALITY_VALUES,
    startFailure,
    type CtrlAsCmdMode,
    type DesktopFailure,
    type DesktopPhase,
    type DesktopProtocol,
    type DesktopQuality,
    type DesktopStart,
} from "@/lib/desktop";
import type { StreamStats } from "@/lib/desktopStats";
import type { DetectedScreen, Framebuffer } from "@/lib/desktopScreens";
import type { LanHost, TopologyTunnel } from "@/types/lan";
import { useSavedLogins } from "@/hooks/useSavedLogins";
import { useStoredChoice } from "@/hooks/useStoredChoice";

export interface DesktopForm {
    account: string;
    protocol: DesktopProtocol;
    port: string;
    login: string;
    password: string;
    domain: string;
    /** 用憑證庫的哪一筆（null = 自己輸入）。/ Saved login to use (null = type it in). */
    savedId: number | null;
    /** 連線前把輸入的登入存進憑證庫。/ Save the typed login to the vault before connecting. */
    save: boolean;
    saveLabel: string;
}

export interface ScreensState {
    state: "idle" | "loading" | "done" | "failed";
    os: string | null;
    list: DetectedScreen[];
}

const EMPTY_FORM: DesktopForm = { account: "", protocol: "rdp", port: String(DEFAULT_PORT.rdp), login: "", password: "", domain: "", savedId: null, save: false, saveLabel: "" };
const NO_SCREENS: ScreensState = { state: "idle", os: null, list: [] };

/** 每個目標記住選的螢幕。/ The chosen screen, remembered per target. */
function screenStorageKey(tunnelId: number, hostId: number | null): string {
    return `telepy.desktopScreen.${tunnelId}.${hostId ?? "device"}`;
}

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
    const [quality, setQuality] = useStoredChoice<DesktopQuality>("telepy.desktopQuality", QUALITY_VALUES, "auto");
    const [ctrlMode, setCtrlMode] = useStoredChoice<CtrlAsCmdMode>("telepy.desktopCtrlAsCmd", CTRL_MODE_VALUES, "auto");
    const [stats, setStats] = useState<StreamStats | null>(null);
    const [unstable, setUnstable] = useState(false);
    const [framebuffer, setFramebuffer] = useState<Framebuffer | null>(null);
    const [scale, setScale] = useState<number | null>(null);
    const [screens, setScreens] = useState<ScreensState>(NO_SCREENS);
    const [viewportId, setViewportIdState] = useState<string>("");
    const sessionRef = useRef<DesktopStart | null>(null);
    sessionRef.current = session;
    const connectedRef = useRef(false);
    connectedRef.current = phase === "connected";

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
    // 這個桌面（隧道 + 主機 + 協定）存過的登入。/ Logins saved for this desktop (tunnel + host + protocol).
    const saved = useSavedLogins(tunnel ? { tunnelId: tunnel.id, hostId: host?.id ?? null, protocol: form.protocol } : null, !!tunnel);
    const savedLogin = saved.list.find((c) => c.id === form.savedId) ?? null;
    const canConnect = !!tunnel && online && !!form.account && isValidPort(form.port) && (phase === "idle" || phase === "failed");

    const connect = useCallback(async () => {
        if (!tunnel) return;
        setFailure(null);
        setEndedNormally(false);
        setPhase("starting");
        try {
            // 要存的話先存，之後用存好的那筆開（密碼只送一次）。/ Save first, then start with the saved row.
            let credentialId = savedLogin?.id ?? null;
            if (!credentialId && form.save && form.password) {
                const created = await saved.create({
                    label: form.saveLabel.trim() || `${form.login.trim() || form.protocol.toUpperCase()}@${host ? (host.label || host.hostname || host.address) : tunnel.name}`,
                    protocol: form.protocol,
                    tunnel_id: tunnel.id,
                    lan_host_id: host?.id ?? null,
                    port: Number(form.port),
                    login: form.login.trim(),
                    domain: form.protocol === "rdp" ? form.domain.trim() : "",
                    password: form.password,
                });
                if (typeof created === "string") {
                    setFailure({ key: "desktop.err.saveLogin", vars: { message: created }, at: "telepy" });
                    setPhase("failed");
                    return;
                }
                credentialId = created.id;
                setForm((f) => ({ ...f, savedId: created.id, save: false, saveLabel: "" }));
            }
            const res = await apiFetch(`/api/reverse/server/${tunnel.id}/desktop/start`, {
                method: "POST",
                body: JSON.stringify({
                    protocol: form.protocol,
                    username: form.account,
                    port: Number(form.port),
                    lan_host_id: host?.id ?? null,
                    quality,
                    ...(credentialId
                        ? { credential_id: credentialId }
                        : { login: form.login.trim(), password: form.password, domain: form.protocol === "rdp" ? form.domain.trim() : "" }),
                }),
            });
            const data = await readJson<DesktopStart & { code?: string; error?: string; credential_id?: string[] }>(res);
            if (!res.ok || !data?.ticket) {
                if (data?.credential_id?.[0]) {
                    setFailure({ key: "desktop.err.savedLogin", vars: { message: data.credential_id[0] }, at: "telepy" });
                    setPhase("failed");
                    return;
                }
                setFailure(startFailure(data?.code, res.status, { account: form.account, address }));
                setPhase("failed");
                return;
            }
            // 新 session：統計、畫面大小、螢幕清單歸零；選過的螢幕從 localStorage 拿回來。
            // A new session: fresh stats, framebuffer and screens; the remembered screen choice comes back.
            setStats(null);
            setUnstable(false);
            setFramebuffer(null);
            setScale(null);
            setScreens(NO_SCREENS);
            let remembered = "";
            try {
                remembered = localStorage.getItem(screenStorageKey(tunnel.id, host?.id ?? null)) ?? "";
            } catch {
                // 私密模式：不記得就從整張畫面開始。/ Storage blocked: start from the whole desktop.
            }
            setViewportIdState(remembered);
            setSession(data);
            setPhase("connecting");
        } catch {
            setFailure({ key: "desktop.err.network", at: "web" });
            setPhase("failed");
        }
    }, [tunnel, host, form, address, savedLogin, saved, quality]);

    const onConnected = useCallback(() => {
        setPhase("connected");
        setConnectedAt(Date.now());
        // 連上了就不留密碼。/ Drop the password once connected.
        setForm((f) => ({ ...f, password: "" }));
    }, []);

    const onEnded = useCallback((f: DesktopFailure | null) => {
        setSession(null);
        setConnectedAt(null);
        setStats(null);
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

    /**
     * 使用者按「中斷連線」。連線中的 session 由 viewer 關掉的 WebSocket 結束（中繼立刻移除它，再 POST stop 只會 404）；
     * 還沒連上的（票證剛發、WS 還沒開）才請後端作廢。
     * User disconnect: a connected session ends with the WebSocket the viewer closes; only an unclaimed ticket
     * needs the REST stop.
     */
    const stop = useCallback(() => {
        const s = sessionRef.current;
        if (s && !connectedRef.current) postStop(s.session_id);
        setSession(null);
        setConnectedAt(null);
        setStats(null);
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

    /** 問裝置的螢幕配置（只有桌面就是裝置自己時才問得到）。/ Ask the device for its screen layout (device desktops only). */
    const detectScreens = useCallback(async () => {
        const s = sessionRef.current;
        if (!tunnel || !s || s.target.lan_host_id !== null) return;
        setScreens((prev) => ({ ...prev, state: "loading" }));
        try {
            const res = await apiFetch(`/api/reverse/server/${tunnel.id}/desktop/screens?username=${encodeURIComponent(s.username)}`);
            const data = res.ok ? await readJson<{ os?: string; screens?: DetectedScreen[] }>(res) : null;
            if (sessionRef.current?.session_id !== s.session_id) return;
            if (!res.ok || !data) {
                setScreens({ state: "failed", os: null, list: [] });
                return;
            }
            setScreens({ state: "done", os: data.os ?? null, list: Array.isArray(data.screens) ? data.screens : [] });
        } catch {
            if (sessionRef.current?.session_id === s.session_id) setScreens({ state: "failed", os: null, list: [] });
        }
    }, [tunnel]);

    // VNC 連到裝置自己：連上就問一次（螢幕選單和 Ctrl→⌘ 的預設都要它）。/ VNC on the device: ask once when connected.
    useEffect(() => {
        if (phase === "connected" && session && session.protocol === "vnc" && session.target.lan_host_id === null && screens.state === "idle") void detectScreens();
    }, [phase, session, screens.state, detectScreens]);

    const setViewportId = useCallback((id: string) => {
        setViewportIdState(id);
        if (!tunnel) return;
        try {
            const key = screenStorageKey(tunnel.id, host?.id ?? null);
            if (id) localStorage.setItem(key, id);
            else localStorage.removeItem(key);
        } catch {
            // 記不住就算了。/ Not remembered, that's all.
        }
    }, [tunnel, host]);

    const browserIsMac = typeof navigator !== "undefined" && isMacBrowser(navigator);
    const effectiveCtrlAsCmd = ctrlAsCmd(ctrlMode, screens.os, browserIsMac);
    const pixelRatio = pixelRatioFor(session?.quality ?? quality, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);

    return {
        state: {
            tunnels, loading, tunnel, host, online, form, phase, failure, session, connectedAt, endedNormally, canConnect, address, savedLogins: saved.list, savedLogin,
            quality, ctrlMode, ctrlAsCmd: effectiveCtrlAsCmd, pixelRatio, stats, unstable, framebuffer, scale, screens, viewportId,
        },
        actions: {
            setTunnel, setHost, update, setProtocol, connect, stop, onConnected, onEnded,
            setQuality, setCtrlMode, detectScreens, setViewportId,
            onStats: setStats, onTunnelUnstable: setUnstable, onDisplaySize: setFramebuffer, onScale: setScale,
            dismissFailure: () => { setFailure(null); setPhase("idle"); },
            forgetSaved: async (id: number) => { if (await saved.remove(id)) setForm((f) => ({ ...f, savedId: null })); },
        },
    };
}
