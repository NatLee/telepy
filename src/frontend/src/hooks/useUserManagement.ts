/**
 * 管理員使用者管理邏輯:載入使用者列表、更新單一使用者(帳號旗標 + 個人設定)。
 * Admin user-management logic: load the user list, update one user (flags + personal settings).
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import type { LanguagePreference } from "@/lib/locale";

export interface ManagedUser {
    id: number;
    username: string;
    email: string;
    is_active: boolean;
    is_superuser: boolean;
    date_joined: string | null;
    last_login: string | null;
    language: LanguagePreference | null;
}

export interface ManagedUserPatch {
    is_active?: boolean;
    is_superuser?: boolean;
    language?: LanguagePreference;
}

export function useUserManagement(enabled: boolean) {
    const [users, setUsers] = useState<ManagedUser[]>([]);
    const [loading, setLoading] = useState(false);
    const { showSuccess, showError } = useToast();
    const { t } = useI18n();

    const fetchUsers = useCallback(async () => {
        setLoading(true);
        try {
            const res = await apiFetch("/api/user/users");
            if (res.ok) {
                const data = await readJson(res);
                const list = (data && typeof data === "object" && Array.isArray((data as { users?: unknown }).users))
                    ? (data as { users: ManagedUser[] }).users
                    : [];
                setUsers(list);
            } else {
                showError(t("settings.fetchUsersFailed"));
            }
        } catch (e: unknown) {
            showError(e instanceof Error ? e.message : t("settings.fetchUsersFailed"));
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [t]);

    useEffect(() => {
        if (enabled) fetchUsers();
    }, [enabled, fetchUsers]);

    /** 更新單一使用者;成功時用後端回傳值同步列表。/ Update one user; sync the list from the response. */
    const updateUser = async (userId: number, patch: ManagedUserPatch): Promise<boolean> => {
        try {
            const res = await apiFetch(`/api/user/users/${userId}`, {
                method: "POST",
                body: JSON.stringify(patch),
            });
            if (res.ok) {
                const updated = await readJson(res) as ManagedUser | null;
                if (updated && typeof updated === "object") {
                    setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, ...updated } : u)));
                }
                showSuccess(t("settings.userUpdated"));
                return true;
            }
            const err = await readJson(res);
            showError(responseError(res, err, t("settings.userUpdateFailed")));
            return false;
        } catch (e: unknown) {
            showError(e instanceof Error ? e.message : t("settings.userUpdateFailed"));
            return false;
        }
    };

    return { users, loading, fetchUsers, updateUser };
}
