import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import { useToast } from "@/components/ui/Toast";
import type { TargetAccount } from "@/lib/targetUsers";
import { useI18n } from "@/lib/i18n";

export function useManageUsersModal(tunnelId: number | null, isOpen: boolean) {
    const { t } = useI18n();
    const [users, setUsers] = useState<TargetAccount[]>([]);
    // 隧道的預設帳號、ADMIN 人數、我能不能管（後端給）。/ The default account, ADMIN count and whether I may manage.
    const [defaultId, setDefaultId] = useState<number | null>(null);
    const [adminSharees, setAdminSharees] = useState<number | null>(null);
    const [canManage, setCanManage] = useState(false);
    const [savingDefault, setSavingDefault] = useState<number | null>(null);
    const [newUsername, setNewUsername] = useState("");
    const [loading, setLoading] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; user: TargetAccount | null }>({ isOpen: false, user: null });
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
                setDefaultId(data?.default_username_id ?? null);
                setAdminSharees(typeof data?.admin_sharees === "number" ? data.admin_sharees : null);
                setCanManage(data?.can_manage === true);
            } else {
                showError(t("manageUsers.fetchFailed"));
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || t("manageUsers.fetchFailed"));
        } finally {
            setLoading(false);
        }
    }, [tunnelId, showError, t]);

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
                let errorMsg = t("manageUsers.addFailed");
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
            showError(e.message || t("manageUsers.addFailed"));
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
                showError(t("manageUsers.removeFailed"));
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || t("manageUsers.removeFailed"));
        }
    };

    /** 設成預設帳號（再按一次 = 取消）。/ Make an account the default (again = clear it). */
    const setDefault = async (id: number | null) => {
        if (!tunnelId) return;
        setSavingDefault(id ?? -1);
        try {
            const res = await apiFetch(`/api/reverse/server/${tunnelId}/default-username`, { method: "PATCH", body: JSON.stringify({ default_username_id: id }) });
            if (res.ok) {
                setDefaultId(id);
                showSuccess(id === null ? t("manageUsers.defaultCleared") : t("manageUsers.defaultSet", { username: users.find((u) => u.id === id)?.username ?? "" }));
            } else {
                showError(t("manageUsers.defaultFailed"));
            }
        } catch {
            showError(t("manageUsers.defaultFailed"));
        } finally {
            setSavingDefault(null);
        }
    };

    return {
        state: {
            users,
            defaultId,
            adminSharees,
            canManage,
            savingDefault,
            newUsername, setNewUsername,
            loading,
            deleteConfirm, setDeleteConfirm
        },
        actions: {
            handleAddUser,
            handleDeleteUser,
            setDefault,
        }
    };
}
