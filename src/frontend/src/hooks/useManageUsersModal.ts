import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import { useToast } from "@/components/ui/Toast";
import { ReverseServerUsername } from "@/types/tunnel";

export function useManageUsersModal(tunnelId: number | null, isOpen: boolean) {
    const [users, setUsers] = useState<ReverseServerUsername[]>([]);
    const [newUsername, setNewUsername] = useState("");
    const [loading, setLoading] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; user: ReverseServerUsername | null }>({ isOpen: false, user: null });
    const { showSuccess, showError } = useToast();

    const fetchUsers = useCallback(async () => {
        if (!tunnelId) return;
        setLoading(true);
        try {
            const res = await apiFetch(`/api/reverse/server/${tunnelId}/usernames`);
            if (res.ok) {
                const data = await res.json();
                const list = data?.usernames ?? (Array.isArray(data) ? data : (data.results ?? []));
                setUsers(list);
            } else {
                showError("Failed to fetch users");
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
            setNewUsername("");
        }
    }, [isOpen, tunnelId, fetchUsers]);

    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.TUNNEL_USERNAMES_UPDATED]: (msg) => {
            if (isOpen && msg.tunnel_id === tunnelId) {
                fetchUsers();
            }
        }
    });

    const handleAddUser = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newUsername.trim() || !tunnelId) return;

        try {
            const res = await apiFetch(`/api/reverse/server/usernames`, {
                method: "POST",
                body: JSON.stringify({ reverse_server: tunnelId, username: newUsername.trim() }),
            });
            if (res.ok) {
                setNewUsername("");
                fetchUsers();
            } else {
                let errorMsg = "Failed to add user";
                try {
                    const data = await res.json();
                    if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'string') {
                        errorMsg = data[0];
                    } else if (data.detail) {
                        errorMsg = data.detail;
                    } else if (data.error) {
                        errorMsg = data.error;
                    } else if (data.non_field_errors && data.non_field_errors.length > 0) {
                        errorMsg = data.non_field_errors[0];
                    } else if (typeof data === 'string') {
                        errorMsg = data;
                    } else if (data.message) {
                        errorMsg = data.message;
                    }
                } catch (jsonError) {
                    // Ignored
                }
                showError(errorMsg);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || "Failed to add user");
        }
    };

    const handleDeleteUser = async () => {
        const user = deleteConfirm.user;
        if (!user || !tunnelId) return;

        try {
            const res = await apiFetch(`/api/reverse/server/usernames/${user.id}`, {
                method: "DELETE",
            });
            if (res.ok) {
                fetchUsers();
                setDeleteConfirm({ isOpen: false, user: null });
            } else {
                showError("Failed to remove user");
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || "Failed to remove user");
        }
    };

    return {
        state: {
            users,
            newUsername, setNewUsername,
            loading,
            deleteConfirm, setDeleteConfirm
        },
        actions: {
            handleAddUser,
            handleDeleteUser
        }
    };
}
