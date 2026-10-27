import { useState, useEffect, useCallback } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import { useToast } from "@/components/ui/Toast";
import { ReverseServerUsername } from "@/types/tunnel";
import { useI18n } from "@/lib/i18n";
import { shareExpiryValue, type ShareExpiryPreset } from "@/lib/shareExpiry";

/** canAdd：能新增分享（「分享隧道」功能開著）；關著就不抓可分享的人（API 會 403）。/ canAdd: may add shares; skips the available-users fetch otherwise. */
export function useShareModal(tunnelId: number | null, isOpen: boolean, canAdd = true) {
    const { t } = useI18n();
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
    // 新分享的期限。/ How long a new share lasts.
    const [expiryPreset, setExpiryPreset] = useState<ShareExpiryPreset>("never");
    const [expiryDate, setExpiryDate] = useState("");
    const { showSuccess, showError } = useToast();

    const fetchUsers = useCallback(async () => {
        if (!tunnelId) return;
        setLoading(true);
        try {
            const [sharedRes, availableRes, usernamesRes] = await Promise.all([
                apiFetch(`/tunnels/shared-users/${tunnelId}`),
                canAdd ? apiFetch(`/tunnels/available-users/${tunnelId}`) : Promise.resolve(null),
                apiFetch(`/api/reverse/server/${tunnelId}/usernames`),
            ]);

            if (sharedRes.ok && (!availableRes || availableRes.ok)) {
                setSharedUsers((await sharedRes.json()).users);
                setAvailableUsers(availableRes ? (await availableRes.json()).users : []);
            } else {
                showError(t("share.fetchSharedFailed"));
            }
            if (usernamesRes.ok) {
                const data = await usernamesRes.json();
                setTunnelUsernames(data?.usernames ?? []);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || t("share.fetchUsersFailed"));
        } finally {
            setLoading(false);
        }
    }, [tunnelId, canAdd, showError, t]);

    useEffect(() => {
        if (isOpen) {
            fetchUsers();
            setSelectedUser("");
            setExpiryPreset("never");
            setExpiryDate("");
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
        const expiresAt = shareExpiryValue(expiryPreset, expiryDate);
        if (expiresAt === undefined) return;

        try {
            const res = await apiFetch(`/tunnels/share/${tunnelId}`, {
                method: "POST",
                body: JSON.stringify({
                    shared_with_user_id: selectedUser,
                    allowed_target_username_ids: selectedAllowedIds.length > 0 ? selectedAllowedIds : undefined,
                    expires_at: expiresAt ?? undefined,
                }),
            });
            if (res.ok) {
                showSuccess(t("share.shared"));
                setSelectedUser("");
                setSelectedAllowedIds([]);
                setExpiryPreset("never");
                setExpiryDate("");
                fetchUsers();
            } else {
                const data = await readJson(res);
                showError(responseError(res, data, t("share.shareFailed")));
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || t("share.shareFailed"));
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
                const data = await readJson(res);
                showError(responseError(res, data, t("share.updatePermissionFailed")));
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || t("share.updatePermissionFailed"));
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
                showError(t("share.unshareFailed"));
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || t("share.unshareFailed"));
        }
    };

    /** 改某人的期限；成功回 true（浮層才關）。/ Change when someone's access ends; true on success. */
    const handleUpdateExpiry = async (userId: number, expiresAt: string | null): Promise<boolean> => {
        if (!tunnelId) return false;
        try {
            const res = await apiFetch(`/tunnels/share/${tunnelId}/${userId}/expiry`, {
                method: "PATCH",
                body: JSON.stringify({ expires_at: expiresAt }),
            });
            if (res.ok) {
                showSuccess(t("share.expiry.updated"));
                fetchUsers();
                return true;
            }
            const data = await readJson(res);
            showError(responseError(res, data, t("share.expiry.updateFailed")));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || t("share.expiry.updateFailed"));
        }
        return false;
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
                showError(t("share.updateAllowedFailed"));
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || t("share.updateAllowedFailed"));
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
            editTargetUsersModal, setEditTargetUsersModal,
            expiryPreset, setExpiryPreset,
            expiryDate, setExpiryDate,
        },
        actions: {
            handleShare,
            handleUpdatePermission,
            handleUnshare,
            handleSaveAllowed,
            handleUpdateExpiry,
            refresh: fetchUsers,
        }
    };
}
