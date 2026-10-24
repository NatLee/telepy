"use client";

/**
 * 網路拓撲頁（#20）：Telepy → 裝置 → 區網主機。資料來自 `GET /api/reverse/lan/topology`，掃描進度走通知
 * （`LAN-SCAN-*`，斷線時每 3 秒輪詢補上），主機表變動（`UPDATED-LAN-HOSTS`）就重抓。
 * Network topology page: Telepy → devices → LAN hosts, live scan progress and host edits.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch, readJson } from "@/lib/api";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS, type NotificationPayload } from "@/lib/notificationActions";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import type { ConnectTarget } from "@/lib/forwardRecipes";
import type { TunnelConfigData } from "@/hooks/useCheatsheetPage";
import { hasSsh, scanRunning } from "@/lib/lanConnect";
import type { LanHost, LanScan, TopologyTunnel } from "@/types/lan";

/** 掃描錯誤碼 → 翻譯；其餘（subnet / ports / username）附上後端的說明。/ Scan error codes → messages. */
const SCAN_ERRORS: Record<string, TranslationKey> = {
    lan_scan_disabled: "network.scanError.disabled",
    lan_scan_forbidden: "network.scanError.forbidden",
    lan_scan_running: "network.scanError.running",
    device_offline: "network.scanError.offline",
};

export interface ScanOptions {
    username?: string | null;
    subnets?: string[];
    ports?: number[];
}

export interface HostInput {
    address?: string;
    label?: string | null;
    username?: string | null;
    ssh_port?: number | null;
}

/** 欄位錯誤（DRF 形狀 `{field: [msg]}`）或整體錯誤。/ Field errors or a general message. */
export type FormErrors = Record<string, string> & { _?: string };

function fieldErrors(data: unknown, fallback: string): FormErrors {
    const out: FormErrors = {};
    if (data && typeof data === "object") {
        for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
            if (Array.isArray(v) && typeof v[0] === "string") out[k] = v[0];
            else if (k === "detail" || k === "error") out._ = String(v);
        }
    }
    if (Object.keys(out).length === 0) out._ = fallback;
    return out;
}

function sanitizeAlias(value: string): string {
    const v = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return v || "telepy-endpoint";
}

export function useNetworkPage() {
    const { t } = useI18n();
    const { showError, showSuccess } = useToast();
    const { user } = useAuth();
    const me = user?.username ?? null;
    const searchParams = useSearchParams();
    const focusTunnel = searchParams.get("tunnel");

    const [tunnels, setTunnels] = useState<TopologyTunnel[]>([]);
    const [loading, setLoading] = useState(true);
    // 即時上下線（通知帶 port → status）。/ Live online state keyed by reverse port.
    const [ports, setPorts] = useState<Record<string, boolean>>({});
    const [query, setQuery] = useState("");
    // 已經提示過完成的掃描（通知與輪詢都可能先看到）。/ Scans whose completion was already announced.
    const announced = useRef<Set<string>>(new Set());
    const firstLoad = useRef(true);

    const fetchTopology = useCallback(async () => {
        try {
            const res = await apiFetch("/api/reverse/lan/topology");
            if (!res.ok) {
                showError(t("network.loadFailed"));
                return;
            }
            const data = await readJson<{ tunnels?: TopologyTunnel[] }>(res);
            const list = Array.isArray(data?.tunnels) ? data!.tunnels : [];
            // 第一次載入時已經結束的掃描不再提示。/ Scans already finished at the first load are not announced.
            if (firstLoad.current) {
                firstLoad.current = false;
                for (const tn of list) if (tn.scan && !scanRunning(tn.scan)) announced.current.add(tn.scan.scan_id);
            }
            setTunnels(list);
        } catch {
            showError(t("network.loadFailed"));
        } finally {
            setLoading(false);
        }
    }, [showError, t]);

    useEffect(() => {
        void fetchTopology();
    }, [fetchTopology]);

    const announce = useCallback(
        (name: string, scan: LanScan) => {
            if (announced.current.has(scan.scan_id)) return;
            announced.current.add(scan.scan_id);
            if (scan.phase === "failed") showError(t("network.scanFailed", { name, error: scan.error ?? "" }));
            else showSuccess(t("network.scanDone", { name, count: scan.hosts_found }));
        },
        [showError, showSuccess, t]
    );

    const patchScan = useCallback((tunnelId: number, patch: Partial<LanScan>) => {
        setTunnels((prev) => prev.map((tn) => (tn.id === tunnelId && tn.scan ? { ...tn, scan: { ...tn.scan, ...patch } } : tn)));
    }, []);

    const refetchSoon = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scheduleRefetch = useCallback(() => {
        if (refetchSoon.current) clearTimeout(refetchSoon.current);
        refetchSoon.current = setTimeout(() => void fetchTopology(), 300);
    }, [fetchTopology]);
    useEffect(() => () => { if (refetchSoon.current) clearTimeout(refetchSoon.current); }, []);

    const handlers = useMemo(
        () => ({
            [NOTIFICATION_ACTIONS.LAN_SCAN_PROGRESS]: (msg: NotificationPayload) => {
                if (typeof msg.tunnel_id !== "number") return;
                patchScan(msg.tunnel_id, { phase: msg.phase, probed: msg.probed, total: msg.total, hosts_found: msg.hosts_found });
            },
            [NOTIFICATION_ACTIONS.LAN_SCAN_DONE]: () => scheduleRefetch(),
            [NOTIFICATION_ACTIONS.UPDATED_LAN_HOSTS]: () => scheduleRefetch(),
            [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_STATUS]: (msg: NotificationPayload) => {
                if (msg.port !== undefined) setPorts((prev) => ({ ...prev, [String(msg.port)]: msg.status === "connected" }));
            },
            [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_STATUS_DATA]: (msg: NotificationPayload) => {
                if (!Array.isArray(msg.data)) return;
                const map: Record<string, boolean> = {};
                for (const p of msg.data) map[String(p)] = true;
                setPorts(map);
            },
        }),
        [patchScan, scheduleRefetch]
    );
    useNotificationHandlers(handlers);

    // 掃描中：每 3 秒輪詢狀態（通知漏掉或 socket 斷線時也會前進）。/ Poll running scans every 3 s.
    const runningIds = tunnels.filter((tn) => scanRunning(tn.scan)).map((tn) => tn.id).join(",");
    useEffect(() => {
        if (!runningIds) return;
        const ids = runningIds.split(",").map(Number);
        const timer = setInterval(async () => {
            for (const id of ids) {
                try {
                    const res = await apiFetch(`/api/reverse/server/${id}/lan/scan`);
                    if (!res.ok) continue;
                    // 回傳的就是掃描狀態（沒有時是 null）。/ The body is the scan status itself, or null.
                    const scan = await readJson<LanScan | null>(res);
                    if (!scan) continue;
                    patchScan(id, scan);
                    if (!scanRunning(scan)) scheduleRefetch();
                } catch { /* 下一輪再試 / retry next tick */ }
            }
        }, 3000);
        return () => clearInterval(timer);
    }, [runningIds, patchScan, scheduleRefetch]);

    // 自己發起的掃描結束 → 提示一次。/ Announce each of my finished scans once.
    useEffect(() => {
        for (const tn of tunnels) if (tn.scan && !scanRunning(tn.scan) && tn.scan.started_by === me) announce(tn.name, tn.scan);
    }, [tunnels, announce, me]);

    const isOnline = useCallback(
        (tn: TopologyTunnel) => {
            const live = ports[String(tn.reverse_port)];
            return live !== undefined ? live : tn.online === true;
        },
        [ports]
    );

    const startScan = useCallback(
        async (tn: TopologyTunnel, opts: ScanOptions): Promise<string | null> => {
            try {
                const res = await apiFetch(`/api/reverse/server/${tn.id}/lan/scan`, {
                    method: "POST",
                    body: JSON.stringify({
                        ...(opts.username ? { username: opts.username } : {}),
                        ...(opts.subnets && opts.subnets.length ? { subnets: opts.subnets } : {}),
                        ...(opts.ports && opts.ports.length ? { ports: opts.ports } : {}),
                    }),
                });
                // 202 的內容是剛開始的掃描狀態；錯誤是 {error, code}（409 另附正在跑的 scan）。
                // 202 carries the new scan status; errors are {error, code} (409 adds the running scan).
                const data = await readJson<LanScan & { error?: string; code?: string; scan?: LanScan }>(res);
                if (res.ok && data?.scan_id) {
                    const scan: LanScan = data;
                    setTunnels((prev) => prev.map((x) => (x.id === tn.id ? { ...x, scan } : x)));
                    return null;
                }
                if (data?.code === "lan_scan_running" && data.scan) {
                    const scan = data.scan;
                    setTunnels((prev) => prev.map((x) => (x.id === tn.id ? { ...x, scan } : x)));
                }
                const key = data?.code ? SCAN_ERRORS[data.code] : undefined;
                if (key) return t(key);
                return t("network.scanError.invalid", { detail: data?.error ?? t("api.unexpectedError") });
            } catch {
                return t("api.unexpectedError");
            }
        },
        [t]
    );

    const addHost = useCallback(
        async (tn: TopologyTunnel, input: HostInput): Promise<FormErrors | null> => {
            try {
                const res = await apiFetch(`/api/reverse/server/${tn.id}/lan/hosts`, { method: "POST", body: JSON.stringify(input) });
                const data = await readJson<LanHost>(res);
                if (res.ok && data) {
                    setTunnels((prev) => prev.map((x) => (x.id === tn.id ? { ...x, hosts: [...x.hosts, data] } : x)));
                    return null;
                }
                return fieldErrors(data, t("api.unexpectedError"));
            } catch {
                return { _: t("api.unexpectedError") };
            }
        },
        [t]
    );

    const updateHost = useCallback(
        async (h: LanHost, input: HostInput): Promise<FormErrors | null> => {
            try {
                const res = await apiFetch(`/api/reverse/server/${h.tunnel_id}/lan/hosts/${h.id}`, { method: "PATCH", body: JSON.stringify(input) });
                const data = await readJson<LanHost>(res);
                if (res.ok && data) {
                    setTunnels((prev) => prev.map((x) => (x.id === h.tunnel_id ? { ...x, hosts: x.hosts.map((y) => (y.id === h.id ? data : y)) } : x)));
                    return null;
                }
                return fieldErrors(data, t("api.unexpectedError"));
            } catch {
                return { _: t("api.unexpectedError") };
            }
        },
        [t]
    );

    const deleteHost = useCallback(
        async (h: LanHost): Promise<boolean> => {
            try {
                const res = await apiFetch(`/api/reverse/server/${h.tunnel_id}/lan/hosts/${h.id}`, { method: "DELETE" });
                if (!res.ok && res.status !== 404) {
                    showError(t("network.deleteFailed"));
                    return false;
                }
                setTunnels((prev) => prev.map((x) => (x.id === h.tunnel_id ? { ...x, hosts: x.hosts.filter((y) => y.id !== h.id) } : x)));
                showSuccess(t("network.hostDeleted", { name: h.label || h.address }));
                return true;
            } catch {
                showError(t("network.deleteFailed"));
                return false;
            }
        },
        [showError, showSuccess, t]
    );

    /**
     * 連線用的裝置別名 / 伺服器位址（跟指令速查頁一樣：多個帳號時取單一帳號的 config，別名才是隧道名稱）。
     * The device alias and server address, resolved like the command sheet does.
     */
    const loadConnectTarget = useCallback(async (tn: TopologyTunnel, deviceUser: string | null): Promise<ConnectTarget> => {
        const fallback: ConnectTarget = {
            alias: sanitizeAlias(tn.name),
            username: deviceUser ?? "USER",
            serverHost: typeof window !== "undefined" ? window.location.hostname : "telepy",
            serverPort: "",
            reversePort: tn.reverse_port,
            mode: "direct",
        };
        try {
            const res = await apiFetch(`/tunnels/server/config/${tn.id}`);
            if (!res.ok) return fallback;
            let data = (await res.json()) as TunnelConfigData;
            const users = data.usernames ?? [];
            const pick = users.find((u) => u.username === deviceUser) ?? users[0];
            if (users.length > 1 && pick) {
                const one = await apiFetch(`/tunnels/server/config/${tn.id}?username_id=${pick.id}`);
                if (one.ok) data = (await one.json()) as TunnelConfigData;
            }
            const host = data.hosts?.[0];
            return {
                ...fallback,
                alias: host?.alias ?? fallback.alias,
                username: deviceUser ?? host?.username ?? fallback.username,
                serverHost: data.server?.host || fallback.serverHost,
                serverPort: data.server?.port ?? "",
            };
        } catch {
            return fallback;
        }
    }, []);

    const q = query.trim().toLowerCase();
    const visible = useMemo(() => {
        if (!q) return tunnels;
        return tunnels
            .map((tn) => {
                if (tn.name.toLowerCase().includes(q)) return tn;
                const hosts = tn.hosts.filter((h) =>
                    [h.address, h.hostname, h.label, h.mac, h.vendor, h.ssh_banner].some((v) => v && v.toLowerCase().includes(q)) ||
                    h.open_ports.some((p) => String(p) === q)
                );
                return hosts.length ? { ...tn, hosts } : null;
            })
            .filter((x): x is TopologyTunnel => x !== null);
    }, [tunnels, q]);

    const stats = useMemo(() => {
        const hosts = tunnels.flatMap((tn) => tn.hosts);
        return {
            devices: tunnels.length,
            online: tunnels.filter(isOnline).length,
            hosts: hosts.length,
            ssh: hosts.filter(hasSsh).length,
        };
    }, [tunnels, isOnline]);

    return {
        state: { tunnels: visible, allTunnels: tunnels, loading, query, stats, focusTunnel },
        actions: { setQuery, refresh: fetchTopology, isOnline, startScan, addHost, updateHost, deleteHost, loadConnectTarget },
    };
}
