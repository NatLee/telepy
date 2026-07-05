import { useState, useCallback, useEffect } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/lib/auth";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/types/notification";
import { Tunnel } from "@/types/tunnel";
import { useI18n } from "@/lib/i18n";

export function useTunnelsPage() {
    const { t } = useI18n();
    const [tunnels, setTunnels] = useState<Tunnel[]>([]);
    const [portsMap, setPortsMap] = useState<Record<string, boolean>>({});
    // 每個 reverse_port 的「裝置↔伺服器」延遲（毫秒）；量不到的 port 缺席，前端一律視為 null。
    const [latencyMap, setLatencyMap] = useState<Record<string, number>>({});
    const [loading, setLoading] = useState(true);

    const [configModal, setConfigModal] = useState<{ isOpen: boolean, tunnelId: number | null }>({ isOpen: false, tunnelId: null });
    const [scriptModal, setScriptModal] = useState<{ isOpen: boolean, tunnelId: number | null, sshPort: number | null }>({ isOpen: false, tunnelId: null, sshPort: null });
    const [usersModal, setUsersModal] = useState<{ isOpen: boolean, tunnelId: number | null, readOnly: boolean }>({ isOpen: false, tunnelId: null, readOnly: false });
    const [detailsModal, setDetailsModal] = useState<{ isOpen: boolean, tunnelId: number | null }>({ isOpen: false, tunnelId: null });
    const [shareModal, setShareModal] = useState<{ isOpen: boolean, tunnelId: number | null }>({ isOpen: false, tunnelId: null });
    const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean, tunnelId: number | null, name: string }>({ isOpen: false, tunnelId: null, name: "" });
    const [leaveConfirm, setLeaveConfirm] = useState<{ isOpen: boolean, tunnelId: number | null, name: string }>({ isOpen: false, tunnelId: null, name: "" });

    const { showSuccess, showError } = useToast();
    const { user } = useAuth();

    const fetchData = useCallback(async () => {
        try {
            setLoading(true);
            const [keysRes, portsRes, latencyRes] = await Promise.all([
                apiFetch("/api/reverse/server/keys"),
                apiFetch("/api/reverse/server/status/ports"),
                // 延遲僅供首屏；獨立容錯（不併入下方 keys/ports 的成敗判斷），此端點掛掉不能讓整個列表空白。
                apiFetch("/api/reverse/server/status/latency").catch(() => null),
            ]);

            if (keysRes.ok && portsRes.ok) {
                const keys = await keysRes.json();
                const ports = await portsRes.json();

                setTunnels(Array.isArray(keys) ? keys : []);
                setPortsMap(typeof ports === 'object' && ports !== null ? ports : {});
            } else {
                showError(t("tunnels.fetchFailed"));
            }

            // 延遲首屏：成功才套用，失敗靜默略過（後續由 WebSocket UPDATE-TUNNEL-LATENCY 持續更新）。
            if (latencyRes && latencyRes.ok) {
                const latency = await readJson<Record<string, number>>(latencyRes);
                if (latency && typeof latency === "object") setLatencyMap(latency);
            }
        } catch (e: any) {
            showError(e.message || t("tunnels.fetchFailed"));
        } finally {
            setLoading(false);
        }
    }, [showError, t]);

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
            }
        },
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_LATENCY]: (msg) => {
            // payload: { latency: { [port]: rtt_ms } } —— 每 ~5s 一次，含使用者可存取且量得到的 port。
            const latency = (msg as { latency?: Record<string, number> }).latency;
            if (latency && typeof latency === "object") {
                setLatencyMap(prev => ({ ...prev, ...latency }));
            }
        },
        [NOTIFICATION_ACTIONS.TUNNEL_SHARED]: (msg) => {
            if (msg.details) showSuccess(msg.details);
            fetchData();
        },
        [NOTIFICATION_ACTIONS.TUNNEL_UNSHARED]: (msg) => {
            if (msg.details) showSuccess(msg.details);
            fetchData();
        },
        [NOTIFICATION_ACTIONS.TUNNEL_PERMISSION_UPDATED]: (msg) => {
            if (msg.details) showSuccess(msg.details);
            fetchData();
        },
        [NOTIFICATION_ACTIONS.TUNNEL_USERNAMES_UPDATED]: (msg) => {
            if (msg.details) showSuccess(msg.details);
            fetchData();
        },
        [NOTIFICATION_ACTIONS.UPDATED_TUNNELS]: () => {
            fetchData();
        }
    });

    const handleDelete = async () => {
        if (!deleteConfirm.tunnelId) return;
        try {
            const res = await apiFetch(`/api/reverse/server/keys/${deleteConfirm.tunnelId}`, {
                method: "DELETE"
            });
            if (res.ok) {
                showSuccess(t("tunnels.deleted", { name: deleteConfirm.name }));
                fetchData();
            } else {
                showError(t("tunnels.deleteFailed"));
            }
        } catch (e: any) {
            showError(e.message || t("tunnels.deleteFailed"));
        } finally {
            setDeleteConfirm({ isOpen: false, tunnelId: null, name: "" });
        }
    };

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
        } catch (e: any) {
            showError(e.message || t("tunnels.leaveFailed"));
        }
    };

    return {
        tunnels,
        portsMap,
        latencyMap,
        loading,
        fetchData,
        handleDelete,
        handleLeaveTunnel,
        modals: {
            configModal, setConfigModal,
            scriptModal, setScriptModal,
            usersModal, setUsersModal,
            detailsModal, setDetailsModal,
            shareModal, setShareModal,
            deleteConfirm, setDeleteConfirm,
            leaveConfirm, setLeaveConfirm
        }
    };
}
