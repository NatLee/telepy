import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import { useToast } from "@/components/ui/Toast";
import { ReverseServerUsername } from "@/types/tunnel";

export function useShareModal(tunnelId: number | null, isOpen: boolean) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [sharedUsers, setSharedUsers] = useState<any[]>([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [availableUsers, setAvailableUsers] = useState<any[]>([]);
    const [selectedUser, setSelectedUser] = useState<string>("");
    const [loading, setLoading] = useState(false);
    const [unshareConfirm, setUnshareConfirm] = useState<{ isOpen: boolean, userId: number, username: string } | null>(null);
    const [tunnelUsernames, setTunnelUsernames] = useState<ReverseServerUsername[]>([]);
    const [selectedAllowedIds, setSelectedAllowedIds] = useState<number[]>([]);
    const [editTargetUsersModal, setEditTargetUsersModal] = useState<{ userId: number, username: string, allowedIds: number[] } | null>(null);
    const { showSuccess, showError } = useToast();

    const fetchUsers = useCallback(async () => {
        if (!tunnelId) return;
        setLoading(true);
        try {
            const [sharedRes, availableRes, usernamesRes] = await Promise.all([
                apiFetch(`/tunnels/shared-users/${tunnelId}`),
                apiFetch(`/tunnels/available-users/${tunnelId}`),
                apiFetch(`/api/reverse/server/${tunnelId}/usernames`),
            ]);

            if (sharedRes.ok && availableRes.ok) {
                setSharedUsers((await sharedRes.json()).users);
                setAvailableUsers((await availableRes.json()).users);
            } else {
                showError("Failed to fetch shared users");
            }
            if (usernamesRes.ok) {
                const data = await usernamesRes.json();
                setTunnelUsernames(data?.usernames ?? []);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || "Failed to fetch users");
        } finally {
            setLoading(false);
        }
    }, [tunnelId, showError]);

    useEffect(() => {
        if (isOpen) {
            fetchUsers();
            setSelectedUser("");
        }
    }, [isOpen, fetchUsers]);

    // Handle WebSocket updates for shares, permissions, and allowed usernames
    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.TUNNEL_SHARED]: (msg) => {
            if (isOpen && msg.tunnel_id === tunnelId) fetchUsers();
        },
        [NOTIFICATION_ACTIONS.TUNNEL_UNSHARED]: (msg) => {
            if (isOpen && msg.tunnel_id === tunnelId) fetchUsers();
        },
        [NOTIFICATION_ACTIONS.TUNNEL_PERMISSION_UPDATED]: (msg) => {
            if (isOpen && msg.tunnel_id === tunnelId) fetchUsers();
        },
        [NOTIFICATION_ACTIONS.TUNNEL_USERNAMES_UPDATED]: (msg) => {
            if (isOpen && msg.tunnel_id === tunnelId) fetchUsers();
        }
    });

    const handleShare = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedUser || !tunnelId) return;

        try {
            const res = await apiFetch(`/tunnels/share/${tunnelId}`, {
                method: "POST",
                body: JSON.stringify({
                    shared_with_user_id: selectedUser,
                    allowed_target_username_ids: selectedAllowedIds.length > 0 ? selectedAllowedIds : undefined
                }),
            });
            if (res.ok) {
                showSuccess("Tunnel shared successfully");
                setSelectedUser("");
                setSelectedAllowedIds([]);
                fetchUsers();
            } else {
                const data = await res.json();
                showError(data.error || "Failed to share tunnel");
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || "Failed to share tunnel");
        }
    };

    const handleUpdatePermission = async (userId: number, newPermission: string) => {
        if (!tunnelId) return;
        try {
            const res = await apiFetch(`/tunnels/update-permission/${tunnelId}/${userId}`, {
                method: "PATCH",
                body: JSON.stringify({ permission_type: newPermission }),
            });
            if (res.ok) {
                // Success toast is handled by WebSocket notification
                fetchUsers();
            } else {
                const data = await res.json();
                showError(data.error || "Failed to update permission");
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || "Failed to update permission");
        }
    };

    const handleUnshare = async () => {
        if (!unshareConfirm || !tunnelId) return;
        try {
            const res = await apiFetch(`/tunnels/unshare/${tunnelId}/${unshareConfirm.userId}`, {
                method: "DELETE",
            });
            if (res.ok) {
                // Success toast is handled by WebSocket notification
                setUnshareConfirm(null);
                fetchUsers();
            } else {
                showError("Failed to unshare tunnel");
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || "Failed to unshare tunnel");
        }
    };

    const handleSaveAllowed = async () => {
        if (!tunnelId || !editTargetUsersModal) return;
        try {
            const res = await apiFetch(`/tunnels/share/${tunnelId}/${editTargetUsersModal.userId}/allowed-usernames`, {
                method: "PATCH",
                body: JSON.stringify({ allowed_target_username_ids: editTargetUsersModal.allowedIds }),
            });
            if (res.ok) {
                // Success toast is handled by WebSocket notification
                setEditTargetUsersModal(null);
                fetchUsers();
            } else {
                showError("Failed to update allowed users");
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || "Failed to update allowed users");
        }
    };

    return {
        state: {
            sharedUsers, setSharedUsers,
            availableUsers, setAvailableUsers,
            selectedUser, setSelectedUser,
            loading, setLoading,
            unshareConfirm, setUnshareConfirm,
            tunnelUsernames, setTunnelUsernames,
            selectedAllowedIds, setSelectedAllowedIds,
            editTargetUsersModal, setEditTargetUsersModal
        },
        actions: {
            handleShare,
            handleUpdatePermission,
            handleUnshare,
            handleSaveAllowed
        }
    };
}
