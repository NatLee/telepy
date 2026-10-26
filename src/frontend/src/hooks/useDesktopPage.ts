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
 * on the device itself, the detected screen layout; a custom crop area and the chosen screen are remembered per target.
 * RustDesk 模式：預設在瀏覽器裡連（`POST …/rustdesk/start` 發票證 → RustDeskViewer 裡的 RustDesk 核心經 Telepy 的中繼連上
 * 裝置的 Direct IP 埠；密碼只交給核心，不送後端）；另有用 app 的路：從裝置探測埠（`GET …/desktop/probe`）並給出 `ssh -L`
 * 指令（別名來自 `/tunnels/server/config/{id}`，和命令表同一套）。/ RustDesk: in the browser by default (a ticket from
 * `…/rustdesk/start`; the vendored core connects through Telepy's relay and the password stays in the browser), or the
 * native app with a port probe plus the ssh -L command.
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
    type DesktopMode,
    type DesktopPhase,
    type DesktopProbe,
    type DesktopQuality,
    type DesktopStart,
} from "@/lib/desktop";
import type { StreamStats } from "@/lib/desktopStats";
import type { RustDeskPeerInfo, RustDeskStart } from "@/lib/rustdesk";
import { parseStoredArea, type DetectedScreen, type Framebuffer, type Viewport } from "@/lib/desktopScreens";
import type { ConnectMode, ConnectTarget } from "@/lib/forwardRecipes";
import type { TunnelConfigData } from "@/hooks/useCheatsheetPage";
import type { LanHost, TopologyTunnel } from "@/types/lan";
import { useSavedLogins } from "@/hooks/useSavedLogins";
import { useStoredChoice } from "@/hooks/useStoredChoice";
import { useDesktopClipboard } from "@/hooks/useDesktopClipboard";

export interface DesktopForm {
    account: string;
    protocol: DesktopMode;
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

export interface ProbeState {
    state: "idle" | "checking" | "ok" | "failed";
    failure: DesktopFailure | null;
    result: DesktopProbe | null;
}

const EMPTY_FORM: DesktopForm = { account: "", protocol: "rdp", port: String(DEFAULT_PORT.rdp), login: "", password: "", domain: "", savedId: null, save: false, saveLabel: "" };
const NO_SCREENS: ScreensState = { state: "idle", os: null, list: [] };
const NO_PROBE: ProbeState = { state: "idle", failure: null, result: null };

/** 每個目標記住選的螢幕。/ The chosen screen, remembered per target. */
function screenStorageKey(tunnelId: number, hostId: number | null): string {
    return `telepy.desktopScreen.${tunnelId}.${hostId ?? "device"}`;
}

/** 每個目標記住框選的區域（JSON）。/ The custom area, remembered per target. */
function areaStorageKey(tunnelId: number, hostId: number | null): string {
    return `telepy.desktopArea.${tunnelId}.${hostId ?? "device"}`;
}

/** 與後端 sanitize_host_alias 相同（config 還沒載入時的別名）。/ Mirrors the backend alias sanitizer. */
function sanitizeAlias(value: string): string {
    const v = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return v || "telepy-endpoint";
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
    // 剪貼簿方向：個人設定（跟著帳號走），站台設定是上限。還沒讀到就不帶，後端用存著的值。
    // The clipboard direction is a per-account setting capped by the site; omitted until loaded so the backend uses the saved one.
    const clipboardPref = useDesktopClipboard();
    const clipboardBody = useMemo(() => (clipboardPref.loaded ? { clipboard: clipboardPref.choice } : {}), [clipboardPref.loaded, clipboardPref.choice]);
    const [stats, setStats] = useState<StreamStats | null>(null);
    const [unstable, setUnstable] = useState(false);
    const [framebuffer, setFramebuffer] = useState<Framebuffer | null>(null);
    const [scale, setScale] = useState<number | null>(null);
    const [screens, setScreens] = useState<ScreensState>(NO_SCREENS);
    const [viewportId, setViewportIdState] = useState<string>("");
    // 框選的區域存成 JSON，畫面大小知道了才解析（區域要在畫面裡才算數）。/ The custom area as stored JSON; parsed once the size is known.
    const [areaRaw, setAreaRaw] = useState<string | null>(null);
    const [selecting, setSelecting] = useState(false);
    const [probeState, setProbeState] = useState<ProbeState>(NO_PROBE);
    const [config, setConfig] = useState<TunnelConfigData | null>(null);
    // 網頁內 RustDesk 的 session（和 guacd 的 `session` 互斥）與對方回報的資訊（螢幕清單、目前螢幕）。
    // The in-browser RustDesk session (never alongside a guacd one) and what the peer reported (its displays).
    const [rdSession, setRdSession] = useState<RustDeskStart | null>(null);
    const [rdInfo, setRdInfo] = useState<RustDeskPeerInfo | null>(null);
    const rdSessionRef = useRef<RustDeskStart | null>(null);
    rdSessionRef.current = rdSession;
    // 交給 RustDesk 核心的密碼：手打的，或 start 回應裡解開的存檔；session 結束就清掉。
    // The password for the RustDesk core: typed, or the saved one unsealed in the start response; cleared with the session.
    const [rdPassword, setRdPassword] = useState("");
    // 隧道延遲（monitor 量的）：RustDesk 的統計沒有這一段，從通知補上。/ The monitor's tunnel RTT, merged into RustDesk's stats.
    const [tunnelMs, setTunnelMs] = useState<number | null>(null);
    const tunnelMsRef = useRef<number | null>(null);
    tunnelMsRef.current = tunnelMs;
    const tunnelRef = useRef<TopologyTunnel | null>(null);
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
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_LATENCY]: (msg: NotificationPayload) => {
            const latency = (msg as { latency?: Record<string, number> }).latency;
            const port = tunnelRef.current?.reverse_port;
            if (latency && port !== undefined && typeof latency[String(port)] === "number") setTunnelMs(latency[String(port)]);
        },
    });

    const tunnel = useMemo(() => tunnels.find((tn) => String(tn.id) === tunnelParam) ?? null, [tunnels, tunnelParam]);
    tunnelRef.current = tunnel;
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
    const setProtocol = useCallback((protocol: DesktopMode) => {
        setForm((f) => {
            // 埠還是別種模式的預設（或打壞了）→ 換成新模式的預設；自己改過的留著。進出 RustDesk 一律換成預設
            // （21118 對 RDP / VNC 沒意義，反過來也是）。/ Swap default ports, keep a typed one; RustDesk always resets.
            const isOtherDefault = (Object.keys(DEFAULT_PORT) as DesktopMode[]).some((m) => m !== protocol && String(DEFAULT_PORT[m]) === f.port);
            const crossesRustDesk = protocol === "rustdesk" || f.protocol === "rustdesk";
            const port = crossesRustDesk || isOtherDefault || !isValidPort(f.port) ? String(DEFAULT_PORT[protocol]) : f.port;
            return { ...f, protocol, port };
        });
    }, []);

    const address = host ? `${host.address}:${form.port}` : `127.0.0.1:${form.port}`;
    const isRustDesk = form.protocol === "rustdesk";
    // 這個桌面（隧道 + 主機 + 協定）存過的登入；RustDesk 存的是固定密碼。/ Logins saved for this desktop (tunnel + host + protocol).
    const saved = useSavedLogins(tunnel ? { tunnelId: tunnel.id, hostId: host?.id ?? null, protocol: form.protocol } : null, !!tunnel);
    const savedLogin = saved.list.find((c) => c.id === form.savedId) ?? null;
    const canConnect = !!tunnel && online && !!form.account && isValidPort(form.port) && (phase === "idle" || phase === "failed");
    const canProbe = !!tunnel && online && !!form.account && isValidPort(form.port) && probeState.state !== "checking";

    /** 連線當下先讀一次隧道延遲（之後靠通知）。/ Read the tunnel RTT once at connect time (notifications keep it fresh). */
    const refreshTunnelMs = useCallback(async (port: number) => {
        try {
            const res = await apiFetch("/api/reverse/server/dashboard");
            const data = res.ok ? await readJson<{ latency?: Record<string, number> }>(res) : null;
            const v = data?.latency?.[String(port)];
            if (typeof v === "number") setTunnelMs(v);
        } catch {
            // 沒有就顯示「—」。/ Shown as unknown.
        }
    }, []);
    /** RustDesk 核心的統計沒有隧道那一段：補上 monitor 的數字。/ RustDesk's stats lack the tunnel hop: merge the monitor's RTT. */
    const onRdStats = useCallback((s: StreamStats) => setStats({ ...s, tunnelMs: tunnelMsRef.current }), []);

    const connect = useCallback(async () => {
        if (!tunnel) return;
        setFailure(null);
        setEndedNormally(false);
        setPhase("starting");
        if (form.protocol === "rustdesk") {
            // 網頁內 RustDesk：只要票證；手打的密碼留在瀏覽器給核心，存檔的由後端解開放進回應。
            // In-browser RustDesk: a ticket; a typed password stays here, a saved one comes back unsealed in the response.
            try {
                let credentialId = savedLogin?.id ?? null;
                if (!credentialId && form.save && form.password) {
                    const created = await saved.create({
                        label: form.saveLabel.trim() || `RustDesk@${host ? (host.label || host.hostname || host.address) : tunnel.name}`,
                        protocol: "rustdesk",
                        tunnel_id: tunnel.id,
                        lan_host_id: host?.id ?? null,
                        port: Number(form.port),
                        login: "",
                        domain: "",
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
                const res = await apiFetch(`/api/reverse/server/${tunnel.id}/rustdesk/start`, {
                    method: "POST",
                    body: JSON.stringify({ username: form.account, port: Number(form.port), lan_host_id: host?.id ?? null, ...clipboardBody, ...(credentialId ? { credential_id: credentialId } : {}) }),
                });
                const data = await readJson<RustDeskStart & { code?: string; credential_id?: string[]; password?: string }>(res);
                if (!res.ok || !data?.ticket) {
                    if (data?.credential_id?.[0]) {
                        setFailure({ key: "desktop.err.savedLogin", vars: { message: data.credential_id[0] }, at: "telepy" });
                        setPhase("failed");
                        return;
                    }
                    setFailure(startFailure(data?.code, res.status, { account: form.account, address }, "rustdesk"));
                    setPhase("failed");
                    return;
                }
                setRdPassword(typeof data.password === "string" ? data.password : form.password);
                void refreshTunnelMs(tunnel.reverse_port);
                setStats(null);
                setUnstable(false);
                setFramebuffer(null);
                setScale(null);
                setScreens(NO_SCREENS);
                setSelecting(false);
                setRdInfo(null);
                setRdSession(data);
                setPhase("connecting");
            } catch {
                setFailure({ key: "desktop.err.network", at: "web" });
                setPhase("failed");
            }
            return;
        }
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
                    ...clipboardBody,
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
            let area: string | null = null;
            try {
                remembered = localStorage.getItem(screenStorageKey(tunnel.id, host?.id ?? null)) ?? "";
                area = localStorage.getItem(areaStorageKey(tunnel.id, host?.id ?? null));
            } catch {
                // 私密模式：不記得就從整張畫面開始。/ Storage blocked: start from the whole desktop.
            }
            setViewportIdState(remembered);
            setAreaRaw(area);
            setSelecting(false);
            setSession(data);
            setPhase("connecting");
        } catch {
            setFailure({ key: "desktop.err.network", at: "web" });
            setPhase("failed");
        }
    }, [tunnel, host, form, address, savedLogin, saved, quality, refreshTunnelMs, clipboardBody]);

    const onConnected = useCallback(() => {
        setPhase("connected");
        setConnectedAt(Date.now());
        // 連上了就不留密碼。/ Drop the password once connected.
        setForm((f) => ({ ...f, password: "" }));
    }, []);

    const onEnded = useCallback((f: DesktopFailure | null) => {
        setSession(null);
        setRdSession(null);
        setRdInfo(null);
        setRdPassword("");
        setConnectedAt(null);
        setStats(null);
        setSelecting(false);
        if (f) {
            setFailure(f);
            setPhase("failed");
        } else {
            setPhase("idle");
            setEndedNormally(true);
        }
    }, []);

    const postStop = useCallback((sid: string, rustdesk = false) => {
        void apiFetch(`/api/reverse/server/${rustdesk ? "rustdesk" : "desktop"}/${sid}/stop`, { method: "POST", body: "{}", keepalive: true }).catch(() => undefined);
    }, []);

    /**
     * 使用者按「中斷連線」。連線中的 session 由 viewer 關掉的 WebSocket 結束（中繼立刻移除它，再 POST stop 只會 404）；
     * 還沒連上的（票證剛發、WS 還沒開）才請後端作廢。
     * User disconnect: a connected session ends with the WebSocket the viewer closes; only an unclaimed ticket
     * needs the REST stop. The same holds for an in-browser RustDesk session: the core closes its WebSocket
     * on `session_close`, which ends the relay.
     */
    const stop = useCallback(() => {
        const s = sessionRef.current;
        if (s && !connectedRef.current) postStop(s.session_id);
        const r = rdSessionRef.current;
        if (r && !connectedRef.current) postStop(r.session_id, true);
        setSession(null);
        setRdSession(null);
        setRdInfo(null);
        setRdPassword("");
        setConnectedAt(null);
        setStats(null);
        setSelecting(false);
        setPhase("idle");
        setEndedNormally(true);
    }, [postStop]);

    useEffect(() => {
        const onUnload = () => { const s = sessionRef.current; if (s) postStop(s.session_id); const r = rdSessionRef.current; if (r) postStop(r.session_id, true); };
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

    // 自訂區域：框選後存起來並選用；畫面大小變了（換 session）就重新驗證。/ The custom crop area.
    const customArea: Viewport | null = framebuffer ? parseStoredArea(areaRaw, framebuffer) : null;
    const startSelecting = useCallback(() => setSelecting(true), []);
    const finishSelecting = useCallback((area: Viewport | null) => {
        setSelecting(false);
        if (!area || !tunnel) return;
        const json = JSON.stringify(area);
        setAreaRaw(json);
        try {
            localStorage.setItem(areaStorageKey(tunnel.id, host?.id ?? null), json);
        } catch {
            // 記不住就這次用。/ Not remembered, used for this session.
        }
        setViewportId("custom");
    }, [tunnel, host, setViewportId]);
    const forgetArea = useCallback(() => {
        setAreaRaw(null);
        if (tunnel) {
            try {
                localStorage.removeItem(areaStorageKey(tunnel.id, host?.id ?? null));
            } catch {
                // 本來就沒存。/ Nothing stored anyway.
            }
        }
        setViewportIdState((id) => (id === "custom" ? "" : id));
        if (tunnel) {
            try {
                if (localStorage.getItem(screenStorageKey(tunnel.id, host?.id ?? null)) === "custom") localStorage.removeItem(screenStorageKey(tunnel.id, host?.id ?? null));
            } catch {
                // 同上。/ Same.
            }
        }
    }, [tunnel, host]);

    // RustDesk：從裝置探測 Direct IP 埠。目標 / 帳號 / 埠一變就歸零。/ RustDesk: probe the port from the device.
    const probeKey = `${tunnel?.id ?? ""}|${host?.id ?? ""}|${form.account}|${form.port}`;
    const probeKeyRef = useRef(probeKey);
    useEffect(() => {
        if (probeKeyRef.current !== probeKey) {
            probeKeyRef.current = probeKey;
            const id = setTimeout(() => setProbeState(NO_PROBE), 0);
            return () => clearTimeout(id);
        }
    }, [probeKey]);
    const runProbe = useCallback(async () => {
        if (!tunnel || !isValidPort(form.port)) return;
        setProbeState({ state: "checking", failure: null, result: null });
        const key = probeKey;
        try {
            const q = new URLSearchParams({ port: form.port, username: form.account });
            if (host) q.set("lan_host_id", String(host.id));
            const res = await apiFetch(`/api/reverse/server/${tunnel.id}/desktop/probe?${q.toString()}`);
            const data = await readJson<DesktopProbe & { code?: string }>(res);
            if (probeKeyRef.current !== key) return;
            if (!res.ok || !data?.reachable) {
                setProbeState({ state: "failed", failure: startFailure(data?.code, res.status, { account: form.account, address }, "rustdesk"), result: null });
                return;
            }
            setProbeState({ state: "ok", failure: null, result: data });
        } catch {
            if (probeKeyRef.current === key) setProbeState({ state: "failed", failure: { key: "desktop.err.network", at: "web" }, result: null });
        }
    }, [tunnel, host, form.port, form.account, address, probeKey]);

    // RustDesk 的 ssh 指令要別名：和命令表一樣讀 config（多個帳號時取這個帳號那一份）。/ The alias for the ssh command.
    const tunnelId = tunnel?.id ?? null;
    useEffect(() => {
        if (!isRustDesk || tunnelId === null) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await apiFetch(`/tunnels/server/config/${tunnelId}`);
                if (!res.ok) return;
                let data = await readJson<TunnelConfigData>(res);
                if (!data) return;
                const users = data.usernames ?? [];
                if (users.length > 1) {
                    const one = users.find((u) => u.username === form.account) ?? users[0];
                    const r2 = await apiFetch(`/tunnels/server/config/${tunnelId}?username_id=${one.id}`);
                    if (r2.ok) data = (await readJson<TunnelConfigData>(r2)) ?? data;
                }
                if (!cancelled) setConfig(data);
            } catch {
                // 沒有別名就用隧道名稱推。/ Without the config the alias is derived from the name.
            }
        })();
        return () => { cancelled = true; };
    }, [isRustDesk, tunnelId, form.account]);
    let connectMode: ConnectMode = "alias";
    try {
        const m = typeof localStorage !== "undefined" ? localStorage.getItem("telepy.cheatsheetMode") : null;
        if (m === "direct") connectMode = "direct";
    } catch {
        // 預設用別名。/ Alias by default.
    }
    const currentConfig = config && tunnel && config.reverse_port === tunnel.reverse_port ? config : null;
    const configHost = currentConfig?.hosts?.find((h) => h.username === form.account) ?? currentConfig?.hosts?.[0] ?? null;
    const connectTarget: ConnectTarget | null = tunnel
        ? {
            alias: configHost?.alias ?? sanitizeAlias(tunnel.name),
            username: form.account || configHost?.username || "USER",
            serverHost: currentConfig?.server?.host || (typeof window !== "undefined" ? window.location.hostname : "telepy"),
            serverPort: currentConfig?.server?.port ?? "",
            reversePort: tunnel.reverse_port,
            mode: connectMode,
        }
        : null;

    const browserIsMac = typeof navigator !== "undefined" && isMacBrowser(navigator);
    const effectiveCtrlAsCmd = ctrlAsCmd(ctrlMode, screens.os, browserIsMac);
    const pixelRatio = pixelRatioFor(session?.quality ?? quality, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);

    return {
        state: {
            tunnels, loading, tunnel, host, online, form, phase, failure, session, connectedAt, endedNormally, canConnect, address, savedLogins: saved.list, savedLogin,
            quality, ctrlMode, ctrlAsCmd: effectiveCtrlAsCmd, pixelRatio, stats, unstable, framebuffer, scale, screens, viewportId,
            customArea, selecting, isRustDesk, canProbe, probeState, connectTarget, configLoaded: !!currentConfig, rdSession, rdInfo, rdPassword,
            clipboard: clipboardPref,
        },
        actions: {
            setTunnel, setHost, update, setProtocol, connect, stop, onConnected, onEnded,
            setQuality, setCtrlMode, setClipboard: clipboardPref.setChoice, detectScreens, setViewportId,
            startSelecting, finishSelecting, forgetArea, runProbe,
            onStats: setStats, onTunnelUnstable: setUnstable, onDisplaySize: setFramebuffer, onScale: setScale, onRdPeerInfo: setRdInfo, onRdStats,
            dismissFailure: () => { setFailure(null); setPhase("idle"); },
            forgetSaved: async (id: number) => { if (await saved.remove(id)) setForm((f) => ({ ...f, savedId: null })); },
        },
    };
}
