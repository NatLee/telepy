import { useState, useCallback, useEffect, useRef } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/lib/auth";
import { useNotificationHandlers } from "@/lib/websocket";
import { allowNotification } from "@/hooks/useNotifyPrefs";
import { NOTIFICATION_ACTIONS } from "@/types/notification";
import { Tunnel, type DeviceWarningKind, type TunnelDetailsTab } from "@/types/tunnel";
import { WARNING_KINDS } from "@/lib/deviceFacts";
import { useI18n } from "@/lib/i18n";

export function useTunnelsPage() {
    const { t } = useI18n();
    const [tunnels, setTunnels] = useState<Tunnel[]>([]);
    // 通知處理器讀「目前」的列表用（不必等 setState 的 updater 執行）。/ Latest list for notification handlers.
    const tunnelsRef = useRef<Tunnel[]>([]);
    tunnelsRef.current = tunnels;
    const [portsMap, setPortsMap] = useState<Record<string, boolean>>({});
    // 每個 reverse_port 的「裝置↔伺服器」延遲（毫秒）；量不到的 port 缺席，前端一律視為 null。
    const [latencyMap, setLatencyMap] = useState<Record<string, number>>({});
    const [loading, setLoading] = useState(true);

    const [configModal, setConfigModal] = useState<{ isOpen: boolean, tunnelId: number | null }>({ isOpen: false, tunnelId: null });
    const [scriptModal, setScriptModal] = useState<{ isOpen: boolean, tunnelId: number | null, sshPort: number | null }>({ isOpen: false, tunnelId: null, sshPort: null });
    const [usersModal, setUsersModal] = useState<{ isOpen: boolean, tunnelId: number | null, readOnly: boolean }>({ isOpen: false, tunnelId: null, readOnly: false });
    const [detailsModal, setDetailsModal] = useState<{ isOpen: boolean, tunnelId: number | null, tab?: TunnelDetailsTab }>({ isOpen: false, tunnelId: null });
    const [shareModal, setShareModal] = useState<{ isOpen: boolean, tunnelId: number | null }>({ isOpen: false, tunnelId: null });
    const [requestModal, setRequestModal] = useState<{ isOpen: boolean, tunnelId: number | null }>({ isOpen: false, tunnelId: null });
    const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean, tunnelId: number | null, name: string }>({ isOpen: false, tunnelId: null, name: "" });
    const [leaveConfirm, setLeaveConfirm] = useState<{ isOpen: boolean, tunnelId: number | null, name: string }>({ isOpen: false, tunnelId: null, name: "" });

    const { showSuccess, showError, showToast } = useToast();
    const { user } = useAuth();

    // silent = 背景重抓（不轉圈、失敗不吵）；回傳有沒有拿到列表。/ silent = background refresh: no spinner, no error
    // toast. Answers whether the list arrived.
    const load = useCallback(async (silent: boolean): Promise<boolean> => {
        try {
            if (!silent) setLoading(true);
            // 單一「一次到位」端點：一個請求就拿到 tunnels + ports + latency（取代先前 keys/ports/latency
            // 三個平行請求 = 三次往返、三次重複的 JWT 使用者查詢）。latency 由後端一併帶回，後續仍由
            // WebSocket UPDATE-TUNNEL-LATENCY 持續更新；ports/latency 在後端取樣失敗時各自回 {}（容錯與
            // 舊端點一致）。/ Single dashboard endpoint replaces the old 3-request fan-out.
            const res = await apiFetch("/api/reverse/server/dashboard");

            if (res.ok) {
                const data = await readJson<{
                    tunnels?: Tunnel[];
                    ports?: Record<string, boolean>;
                    latency?: Record<string, number>;
                }>(res);
                setTunnels(Array.isArray(data?.tunnels) ? data!.tunnels : []);
                setPortsMap(data?.ports && typeof data.ports === "object" ? data.ports : {});
                // 首屏延遲：有值才套用（後續由 WebSocket 持續更新）。
                if (data?.latency && typeof data.latency === "object") setLatencyMap(data.latency);
                return true;
            }
            if (!silent) showError(t("tunnels.fetchFailed"));
            return false;
        } catch (e) {
            if (!silent) showError((e instanceof Error && e.message) || t("tunnels.fetchFailed"));
            return false;
        } finally {
            if (!silent) setLoading(false);
        }
    }, [showError, t]);
    const fetchData = useCallback(() => load(false), [load]);

    // 裝置連上 / 斷線後靜默重抓一次列表，讓公網 IP（endpoint）跟著換；連續的狀態變化合併成一次。
    // Refresh the list quietly after a device connects / drops so its public IP follows; bursts coalesce.
    const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const reloadSoon = useCallback(() => {
        if (reloadTimer.current) clearTimeout(reloadTimer.current);
        reloadTimer.current = setTimeout(() => {
            reloadTimer.current = null;
            load(true);
        }, 800);
    }, [load]);
    useEffect(() => () => {
        if (reloadTimer.current) clearTimeout(reloadTimer.current);
    }, []);

    useEffect(() => {
        fetchData();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_STATUS_DATA]: (msg) => {
            if (Array.isArray(msg.data)) {
                const map: Record<string, boolean> = {};
                for (const p of msg.data) {
                    map[String(p)] = true;
                }
                setPortsMap(map);
            }
        },
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_STATUS]: (msg) => {
            if (msg.port !== undefined) {
                setPortsMap(prev => ({ ...prev, [String(msg.port)]: msg.status === "connected" }));
                reloadSoon();
            }
        },
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_LATENCY]: (msg) => {
            // payload: { latency: { [port]: rtt_ms } } —— 每 ~5s 一次，含使用者可存取且量得到的 port。
            const latency = (msg as { latency?: Record<string, number> }).latency;
            if (latency && typeof latency === "object") {
                setLatencyMap(prev => ({ ...prev, ...latency }));
            }
        },
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_HEALTH]: (msg) => {
            // 降級 / 恢復：直接換這條的 health；變成降級時提醒一次。/ Degraded / recovered: patch it; warn once when it degrades.
            const id = msg.tunnel_id;
            const health = msg.health;
            if (id === undefined || (health !== "online" && health !== "degraded" && health !== "offline")) return;
            const tunnel = tunnelsRef.current.find(tn => tn.id === id);
            setTunnels(prev => prev.map(tn => (tn.id === id ? { ...tn, health } : tn)));
            if (health === "degraded" && tunnel && allowNotification(msg, "toast")) showToast(t("tunnels.degradedToast", { name: tunnel.host_friendly_name }), "warning");
        },
        [NOTIFICATION_ACTIONS.TUNNEL_IP_CHANGED]: (msg) => {
            // 可能是浮動 IP，也可能是金鑰外流：提醒一下，並刷新列表上的 IP。/ Dynamic IP or a leaked key: tell the owner.
            if (typeof msg.ip === "string" && typeof msg.previous_ip === "string" && allowNotification(msg, "toast")) {
                showToast(t("tunnels.ipChangedToast", { name: String(msg.tunnel_name ?? ""), ip: msg.ip, previous: msg.previous_ip }), "warning");
            }
            reloadSoon();
        },
        [NOTIFICATION_ACTIONS.DEVICE_WARNING]: (msg) => {
            // 裝置需要注意（磁碟快滿、記憶體不足…）：提醒一次並刷新列表上的標記。/ A device needs attention: tell, then refresh the chip.
            const kinds = Array.isArray(msg.warnings) ? (msg.warnings as string[]).filter((k) => (WARNING_KINDS as string[]).includes(k)) : [];
            if (kinds.length > 0 && allowNotification(msg, "toast")) {
                const what = kinds.map((k) => t(`deviceFacts.chip.${k as DeviceWarningKind}`)).join(", ");
                showToast(t("tunnels.deviceWarningToast", { name: String(msg.tunnel_name ?? ""), what }), "warning");
            }
            reloadSoon();
        },
        // 裝置的位址 / 基本狀況重新讀過：靜默重抓（列表上的警示標記）。/ Facts re-read: quietly refetch (warning chips).
        [NOTIFICATION_ACTIONS.DEVICE_FACTS_UPDATED]: () => reloadSoon(),
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_PRESENCE]: (msg) => {
            // 人數直接換；看得到細節（誰 / IP）的隧道再靜默重抓一次列表。/ Update the count; refetch when details are visible.
            const id = msg.tunnel_id;
            const count = typeof msg.count === "number" ? msg.count : null;
            if (id === undefined || count === null) return;
            const detailed = Array.isArray(tunnelsRef.current.find(tn => tn.id === id)?.presence?.sessions);
            setTunnels(prev => prev.map(tn => (tn.id === id ? { ...tn, presence: { count, sessions: tn.presence?.sessions ?? null } } : tn)));
            if (detailed) reloadSoon();
        },
        [NOTIFICATION_ACTIONS.TUNNEL_SHARED]: (msg) => {
            if (msg.details && allowNotification(msg, "toast")) showSuccess(msg.details);
            fetchData();
        },
        [NOTIFICATION_ACTIONS.TUNNEL_UNSHARED]: (msg) => {
            // 限時分享到期是提醒，不是成功。/ A timed share ending is a heads-up, not a success.
            if (msg.details && allowNotification(msg, "toast")) {
                if (msg.expired) showToast(msg.details, "warning");
                else showSuccess(msg.details);
            }
            fetchData();
        },
        [NOTIFICATION_ACTIONS.TUNNEL_PERMISSION_UPDATED]: (msg) => {
            // 暫時授權到期是提醒。/ A temporary grant ending is a heads-up.
            if (msg.details) {
                if (msg.temporary_ended) showToast(msg.details, "warning");
                else showSuccess(msg.details);
            }
            fetchData();
        },
        // 存取申請：新申請（給 owner / ADMIN）、決定（給申請人）、其他變動只刷新。
        // Access requests: new (owner / ADMIN), decided (requester), other changes just refresh.
        [NOTIFICATION_ACTIONS.ACCESS_REQUEST_CREATED]: (msg) => {
            if (msg.details && allowNotification(msg, "toast")) showToast(msg.details, "info");
            fetchData();
        },
        [NOTIFICATION_ACTIONS.ACCESS_REQUEST_DECIDED]: (msg) => {
            if (msg.details && allowNotification(msg, "toast")) {
                if (msg.status === "approved") showSuccess(msg.details);
                else showToast(msg.details, "warning");
            }
            fetchData();
        },
        [NOTIFICATION_ACTIONS.ACCESS_REQUEST_UPDATED]: () => {
            fetchData();
        },
        [NOTIFICATION_ACTIONS.TUNNEL_USERNAMES_UPDATED]: (msg) => {
            if (msg.details) showSuccess(msg.details);
            fetchData();
        },
        [NOTIFICATION_ACTIONS.UPDATED_TUNNELS]: () => {
            fetchData();
        },
        // 別人的 AI agent 連上／離開我的隧道時提示（自己的 agent 不吵）。/ Toast when someone else's agent uses my tunnel.
        [NOTIFICATION_ACTIONS.AI_SESSION_OPENED]: (msg) => {
            if (msg.details && msg.by && msg.by !== user?.username && allowNotification(msg, "toast")) showSuccess(msg.details);
        },
        [NOTIFICATION_ACTIONS.AI_SESSION_CLOSED]: (msg) => {
            if (msg.details && msg.by && msg.by !== user?.username && allowNotification(msg, "toast")) showSuccess(msg.details);
        },
        // 裝置的 host key 變了：連線已被擋，提示去詳細資訊核對。/ A device's host key changed: connections are blocked.
        [NOTIFICATION_ACTIONS.HOST_KEY_CHANGED]: (msg) => {
            const name = tunnels.find((tn) => tn.id === msg.tunnel_id)?.host_friendly_name ?? `#${msg.tunnel_id ?? "?"}`;
            if (allowNotification(msg, "toast")) showError(t("hostKey.notify", { name }));
            fetchData();
        },
        // 別的帳號把隧道指到了我的機器（已被拒）：提醒去看誰碰得到那台。/ Another account's tunnel reached my machine (refused).
        [NOTIFICATION_ACTIONS.DEVICE_CLAIM_ATTEMPT]: (msg) => {
            const name = (typeof msg.tunnel_name === "string" && msg.tunnel_name) || tunnels.find((tn) => tn.id === msg.tunnel_id)?.host_friendly_name || `#${msg.tunnel_id ?? "?"}`;
            if (allowNotification(msg, "toast")) showError(t("hostKey.claimNotify", { name, by: String(msg.by ?? "?") }));
        },
    });

    const handleLeaveTunnel = async (tunnelId: number, tunnelName: string) => {
        if (!user?.id) { showError(t("tunnels.getCurrentUserFailed")); return; }
        try {
            const res = await apiFetch(`/tunnels/unshare/${tunnelId}/${user.id}`, { method: "DELETE" });
            if (res.ok) {
                showSuccess(t("tunnels.left", { name: tunnelName }));
                fetchData();
            } else {
                showError(t("tunnels.leaveFailed"));
            }
        } catch (e) {
            showError((e instanceof Error && e.message) || t("tunnels.leaveFailed"));
        }
    };

    // 釘選：先改畫面再送出，失敗就改回來。/ Pin: update the list first, roll back on failure.
    const togglePin = async (tunnelId: number, pinned: boolean) => {
        setTunnels(prev => prev.map(tn => (tn.id === tunnelId ? { ...tn, pinned } : tn)));
        try {
            const res = await apiFetch(`/api/reverse/server/${tunnelId}/pin`, { method: pinned ? "PUT" : "DELETE" });
            if (!res.ok) throw new Error();
        } catch {
            setTunnels(prev => prev.map(tn => (tn.id === tunnelId ? { ...tn, pinned: !pinned } : tn)));
            showError(t("tunnels.pinFailed"));
        }
    };

    return {
        tunnels,
        portsMap,
        latencyMap,
        loading,
        fetchData,
        togglePin,
        handleLeaveTunnel,
        modals: {
            configModal, setConfigModal,
            scriptModal, setScriptModal,
            usersModal, setUsersModal,
            detailsModal, setDetailsModal,
            shareModal, setShareModal,
            requestModal, setRequestModal,
            deleteConfirm, setDeleteConfirm,
            leaveConfirm, setLeaveConfirm
        }
    };
}
