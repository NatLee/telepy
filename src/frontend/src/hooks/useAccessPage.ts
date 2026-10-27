/**
 * 設定頁「存取」分頁：載入整份功能權限（GET /api/access），寫入（群組、成員、允許 / 拒絕）後用回傳的整份取代。
 * The Settings page's Access tab: loads the feature-permission policy and replaces it with what every write answers.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { grantBody, type AccessPolicy, type GrantValue, type Subject } from "@/lib/features";

export interface GroupDraft {
    name?: string;
    description?: string;
    members?: number[];
}

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

    const createGroup = useCallback(
        async (draft: GroupDraft) => {
            const r = await write("/api/access/groups", "POST", draft);
            if (r) showSuccess(t("access.groupCreated", { name: draft.name ?? "" }));
            return r?.created_id ?? null;
        },
        [write, showSuccess, t],
    );

    const updateGroup = useCallback((id: number, draft: GroupDraft) => write(`/api/access/groups/${id}`, "PATCH", draft), [write]);
    const deleteGroup = useCallback((id: number) => write(`/api/access/groups/${id}`, "DELETE"), [write]);

    return { policy, loading, saving, reload: load, setGrant, createGroup, updateGroup, deleteGroup };
}
