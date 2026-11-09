/**
 * 管理區的功能權限、角色與（管理員維護的）群組三頁共用：載入整份政策（GET /api/access），寫入（角色、群組、成員、
 * 允許 / 拒絕）後用回傳的整份取代。角色只管功能（`/api/access/groups`）；群組只管分享（`/api/access/share-groups`），
 * 改群組成員或刪群組前可以先預覽誰會多 / 少哪些通道。
 * Shared by the admin Feature access, Roles and Groups pages: loads the policy and replaces it with what every write
 * answers. Roles only decide features (`/api/access/groups`); groups only decide sharing (`/api/access/share-groups`),
 * with a preview of who gains / loses which tunnels before their members change or they are deleted.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { parseImpact, type Impact } from "@/lib/peopleGroups";
import { grantBody, type AccessPolicy, type GrantValue, type Subject } from "@/lib/features";

/** 角色或群組的欄位（只送有變的）。/ A role's or group's fields (only what changed is sent). */
export interface GroupDraft {
    name?: string;
    description?: string;
    members?: number[];
}

/** 成員的增減（delta 路由的 body；只送有的）。/ A member delta (the delta routes' body). */
export interface MembersDelta {
    add?: number[];
    remove?: number[];
}

/** 預覽一個群組的改變（二選一）。/ One group change to preview (exactly one of these). */
export type GroupPreviewBody = { members: number[] } | { delete: true };

export function useAccessPage() {
    const { t } = useI18n();
    const { showError, showSuccess } = useToast();
    const { fetchUserProfile } = useAuth();
    const [policy, setPolicy] = useState<AccessPolicy | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await apiFetch("/api/access");
            const data = await readJson<AccessPolicy>(res);
            if (res.ok && data) setPolicy(data);
            else showError(responseError(res, data, t("access.loadFailed")));
        } catch (e) {
            showError(e instanceof Error ? e.message : t("access.loadFailed"));
        } finally {
            setLoading(false);
        }
    }, [showError, t]);

    useEffect(() => {
        void load();
    }, [load]);

    /** 送一個寫入；成功時用回傳的整份取代，回傳 body（建立群組時有 created_id）。/ One write; replaces the policy on success. */
    const write = useCallback(
        async (path: string, method: string, body?: unknown): Promise<(AccessPolicy & { created_id?: number }) | null> => {
            setSaving(true);
            try {
                const res = await apiFetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
                const data = await readJson<AccessPolicy & { created_id?: number }>(res);
                if (!res.ok || !data) {
                    showError(responseError(res, data, t("access.saveFailed")));
                    return null;
                }
                setPolicy(data);
                // 管理員自己永遠全部都有，但重抓 profile 讓其他分頁的導覽也跟上（便宜）。/ Keep this tab's profile fresh.
                void fetchUserProfile();
                return data;
            } catch (e) {
                showError(e instanceof Error ? e.message : t("access.saveFailed"));
                return null;
            } finally {
                setSaving(false);
            }
        },
        [fetchUserProfile, showError, t],
    );

    const setGrant = useCallback((subject: Subject, feature: string, value: GrantValue) => write("/api/access/grants", "PUT", grantBody(subject, feature, value)), [write]);

    /* ── 角色（功能）/ Roles (features) ── */
    const createRole = useCallback(
        async (draft: GroupDraft) => {
            const r = await write("/api/access/groups", "POST", draft);
            if (r) showSuccess(t("roles.created", { name: draft.name ?? "" }));
            return r?.created_id ?? null;
        },
        [write, showSuccess, t],
    );
    const updateRole = useCallback((id: number, draft: GroupDraft) => write(`/api/access/groups/${id}`, "PATCH", draft), [write]);
    const deleteRole = useCallback((id: number) => write(`/api/access/groups/${id}`, "DELETE"), [write]);
    /** 角色成員的增減（不會蓋掉別的管理員同時的修改）。/ Add / remove role members (never overwrites a concurrent edit). */
    const roleMembers = useCallback((id: number, delta: MembersDelta) => write(`/api/access/groups/${id}/members`, "POST", delta), [write]);

    /* ── 管理員維護的群組（分享）/ Admin-kept groups (sharing) ── */
    const createShareGroup = useCallback(
        async (draft: GroupDraft) => {
            const r = await write("/api/access/share-groups", "POST", draft);
            if (r) showSuccess(t("adminGroups.created", { name: draft.name ?? "" }));
            return r?.created_id ?? null;
        },
        [write, showSuccess, t],
    );
    const updateShareGroup = useCallback((id: number, draft: GroupDraft) => write(`/api/access/share-groups/${id}`, "PATCH", draft), [write]);
    const deleteShareGroup = useCallback((id: number) => write(`/api/access/share-groups/${id}`, "DELETE"), [write]);
    /** 群組成員的增減；通道分享立刻跟著走。/ Add / remove group members; group shares follow at once. */
    const shareGroupMembers = useCallback((id: number, delta: MembersDelta) => write(`/api/access/share-groups/${id}/members`, "POST", delta), [write]);

    /** 這個改變會讓誰多 / 少哪些通道（不寫入）；失敗 = null（已顯示錯誤）。/ Who would gain / lose which tunnels; null on failure. */
    const previewShareGroup = useCallback(
        async (id: number, body: GroupPreviewBody): Promise<Impact | null> => {
            try {
                const res = await apiFetch(`/api/access/share-groups/${id}/preview`, { method: "POST", body: JSON.stringify(body) });
                const data = await readJson(res);
                if (!res.ok) {
                    showError(responseError(res, data, t("impact.previewFailed")));
                    return null;
                }
                return parseImpact(data);
            } catch (e) {
                showError(e instanceof Error ? e.message : t("impact.previewFailed"));
                return null;
            }
        },
        [showError, t],
    );

    return {
        policy,
        loading,
        saving,
        reload: load,
        setGrant,
        createRole,
        updateRole,
        deleteRole,
        roleMembers,
        createShareGroup,
        updateShareGroup,
        deleteShareGroup,
        shareGroupMembers,
        previewShareGroup,
    };
}
