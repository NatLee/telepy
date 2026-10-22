import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { apiFetch, readJson } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/types/notification";
import { TargetUser, Tunnel } from "@/types/tunnel";
import type { ConnectMode, ConnectTarget } from "@/lib/forwardRecipes";

/** `/tunnels/server/config/{id}` 的回應（含指令速查用的結構化欄位）。/ Config endpoint response. */
export interface TunnelConfigData {
    config: string;
    usernames: TargetUser[];
    server: { alias: string; host: string; port: string };
    hosts: { alias: string; username: string; username_id: number }[];
    reverse_port: number;
}

const MODE_STORAGE_KEY = "telepy.cheatsheetMode";

/** 與後端 sanitize_host_alias 相同（沒有目標使用者、config 裡沒有裝置區塊時才用到）。/ Mirrors the backend alias sanitizer. */
function sanitizeAlias(value: string): string {
    const v = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return v || "telepy-endpoint";
}

/**
 * 指令速查頁的資料：隧道清單 + 線上狀態、個人金鑰數量、選定隧道的 ssh config / 別名 / 伺服器位址。
 * 選定的隧道放在 URL（?tunnel=<id>），隧道列表的「埠轉發」可以直接深連結過來。
 * Data for the command sheet: tunnels + online state, personal key count, and the selected tunnel's ssh config /
 * alias / server address. The selection lives in the URL (?tunnel=<id>) so the tunnel list can deep-link here.
 */
export function useCheatsheetPage() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const tunnelParam = searchParams.get("tunnel");
    const { t } = useI18n();
    const { showError } = useToast();

    const [tunnels, setTunnels] = useState<Tunnel[]>([]);
    const [portsMap, setPortsMap] = useState<Record<string, boolean>>({});
    const [loadingTunnels, setLoadingTunnels] = useState(true);
    const [keyCount, setKeyCount] = useState<number | null>(null);
    const [config, setConfig] = useState<TunnelConfigData | null>(null);
    const [loadingConfig, setLoadingConfig] = useState(false);
    // 使用者在「目標使用者」下拉選的值；只對選它時的那條隧道有效。/ The user's pick, valid only for the tunnel it was made on.
    const [userChoice, setUserChoice] = useState<{ tunnelId: number; usernameId: number } | null>(null);
    const [mode, setModeState] = useState<ConnectMode>("alias");

    useEffect(() => {
        try {
            const saved = localStorage.getItem(MODE_STORAGE_KEY);
            if (saved === "alias" || saved === "direct") setModeState(saved);
        } catch { /* localStorage 不可用時用預設值 / fall back to the default */ }
    }, []);

    const setMode = useCallback((m: ConnectMode) => {
        setModeState(m);
        try { localStorage.setItem(MODE_STORAGE_KEY, m); } catch { /* 忽略 / ignore */ }
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [dash, keys] = await Promise.all([
                    apiFetch("/api/reverse/server/dashboard"),
                    apiFetch("/api/reverse/user/keys"),
                ]);
                if (cancelled) return;
                if (dash.ok) {
                    const data = await readJson<{ tunnels?: Tunnel[]; ports?: Record<string, boolean> }>(dash);
                    setTunnels(Array.isArray(data?.tunnels) ? data!.tunnels : []);
                    setPortsMap(data?.ports && typeof data.ports === "object" ? data.ports : {});
                } else {
                    showError(t("tunnels.fetchFailed"));
                }
                if (keys.ok) {
                    const list = await readJson<unknown[]>(keys);
                    setKeyCount(Array.isArray(list) ? list.length : 0);
                }
            } catch (e: unknown) {
                if (!cancelled) showError(e instanceof Error ? e.message : t("tunnels.fetchFailed"));
            } finally {
                if (!cancelled) setLoadingTunnels(false);
            }
        })();
        return () => { cancelled = true; };
    }, [showError, t]);

    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_STATUS_DATA]: (msg) => {
            if (Array.isArray(msg.data)) {
                const map: Record<string, boolean> = {};
                for (const p of msg.data) map[String(p)] = true;
                setPortsMap(map);
            }
        },
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_STATUS]: (msg) => {
            if (msg.port !== undefined) {
                setPortsMap(prev => ({ ...prev, [String(msg.port)]: msg.status === "connected" }));
            }
        },
    });

    const selected = useMemo(
        () => tunnels.find(tn => String(tn.id) === tunnelParam) ?? null,
        [tunnels, tunnelParam],
    );

    const setTunnel = useCallback((id: number) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set("tunnel", String(id));
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    }, [pathname, router, searchParams]);

    // 沒帶 / 帶錯 ?tunnel= 時，預設選第一條線上的隧道（沒有就第一條）。
    // No or unknown ?tunnel=: default to the first online tunnel (else the first one).
    useEffect(() => {
        if (loadingTunnels || tunnels.length === 0 || selected) return;
        const fallback = tunnels.find(tn => portsMap[String(tn.reverse_port)] === true) ?? tunnels[0];
        setTunnel(fallback.id);
    }, [loadingTunnels, tunnels, selected, portsMap, setTunnel]);

    const selectedId = selected?.id ?? null;
    const requestedUsernameId = userChoice && userChoice.tunnelId === selectedId ? userChoice.usernameId : null;

    useEffect(() => {
        if (selectedId === null) return;
        let cancelled = false;
        (async () => {
            setLoadingConfig(true);
            try {
                const res = await apiFetch(`/tunnels/server/config/${selectedId}`);
                if (!res.ok) {
                    if (!cancelled) { showError(t("config.loadFailed")); setConfig(null); }
                    return;
                }
                let data = await res.json() as TunnelConfigData;
                const users = data.usernames ?? [];
                // 多個目標使用者時，未篩選的 config 別名是 name-user；跟 SSH config 視窗一樣只取一位，別名才是隧道名稱。
                // With several users the unfiltered aliases are name-user; fetch one user like the SSH config modal does.
                if (users.length > 1) {
                    const uid = users.some(u => u.id === requestedUsernameId) ? requestedUsernameId! : users[0].id;
                    const one = await apiFetch(`/tunnels/server/config/${selectedId}?username_id=${uid}`);
                    if (one.ok) data = await one.json() as TunnelConfigData;
                }
                if (!cancelled) setConfig(data);
            } catch (e: unknown) {
                if (!cancelled) showError(e instanceof Error ? e.message : t("config.loadFailedGeneric"));
            } finally {
                if (!cancelled) setLoadingConfig(false);
            }
        })();
        return () => { cancelled = true; };
    }, [selectedId, requestedUsernameId, showError, t]);

    const setUsernameId = useCallback((usernameId: number) => {
        if (selectedId !== null) setUserChoice({ tunnelId: selectedId, usernameId });
    }, [selectedId]);

    // config 屬於目前選的隧道才拿來用（切換隧道時避免短暫顯示上一條的資料）。
    // Only use the config when it belongs to the selected tunnel (avoids flashing the previous one).
    const currentConfig = config && selected && config.reverse_port === selected.reverse_port ? config : null;
    const host = currentConfig?.hosts?.[0] ?? null;

    const target: ConnectTarget | null = selected
        ? {
            alias: host?.alias ?? sanitizeAlias(selected.host_friendly_name),
            username: host?.username ?? "USER",
            serverHost: currentConfig?.server?.host || (typeof window !== "undefined" ? window.location.hostname : "telepy"),
            serverPort: currentConfig?.server?.port ?? "",
            reversePort: selected.reverse_port,
            mode,
        }
        : null;

    return {
        state: {
            tunnels,
            loadingTunnels,
            portsMap,
            selected,
            online: selected ? portsMap[String(selected.reverse_port)] === true : false,
            keyCount,
            config: currentConfig,
            loadingConfig,
            usernameId: host?.username_id ?? null,
            hasTargetUser: (currentConfig?.usernames?.length ?? 0) > 0,
            target,
            mode,
        },
        actions: { setTunnel, setUsernameId, setMode },
    };
}
