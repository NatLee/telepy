import { useState, useCallback, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/lib/auth";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/types/notification";
import { Tunnel } from "@/types/tunnel";

export function useTunnelsPage() {
    const [tunnels, setTunnels] = useState<Tunnel[]>([]);
    const [portsMap, setPortsMap] = useState<Record<string, boolean>>({});
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
            const [keysRes, portsRes] = await Promise.all([
                apiFetch("/api/reverse/server/keys"),
                apiFetch("/api/reverse/server/status/ports")
            ]);

            if (keysRes.ok && portsRes.ok) {
                const keys = await keysRes.json();
                const ports = await portsRes.json();

                setTunnels(Array.isArray(keys) ? keys : []);
                setPortsMap(typeof ports === 'object' && ports !== null ? ports : {});
            } else {
                showError("Failed to fetch tunnel data");
            }
        } catch (e: any) {
            showError(e.message || "Failed to fetch tunnel data");
        } finally {
            setLoading(false);
        }
    }, [showError]);

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
                showSuccess(`Tunnel '${deleteConfirm.name}' deleted`);
                fetchData();
            } else {
                showError("Failed to delete tunnel");
            }
        } catch (e: any) {
            showError(e.message || "Failed to delete tunnel");
        } finally {
            setDeleteConfirm({ isOpen: false, tunnelId: null, name: "" });
        }
    };

    const handleLeaveTunnel = async (tunnelId: number, tunnelName: string) => {
        if (!user?.id) { showError("Failed to get current user"); return; }
        try {
            const res = await apiFetch(`/tunnels/unshare/${tunnelId}/${user.id}`, { method: "DELETE" });
            if (res.ok) {
                showSuccess(`You left tunnel '${tunnelName}'`);
                fetchData();
            } else {
                showError("Failed to leave tunnel");
            }
        } catch (e: any) {
            showError(e.message || "Failed to leave tunnel");
        }
    };

    return {
        tunnels,
        portsMap,
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
