/**
 * 個人群組（`/api/user/groups`）：自己做、只有自己看得到、只用來分享通道。每個寫入都回整份清單。
 * Personal groups: made by you, seen only by you, used only for sharing tunnels. Every write answers the whole list.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { parseImpact, parsePersonalGroups, type Impact, type PersonalGroupList } from "@/lib/peopleGroups";

export interface PersonalGroupDraft {
    name?: string;
    description?: string;
    members?: number[];
}

export type PersonalPreviewBody = { members: number[] } | { delete: true };

/** `enabled` = 有「分享通道」功能（沒有就不抓：後端會 403）。/ Only with the share feature (the backend answers 403 otherwise). */
export function usePersonalGroups(enabled: boolean, onChanged?: () => void) {
    const { t } = useI18n();
    const { showSuccess, showError } = useToast();
    const [list, setList] = useState<PersonalGroupList | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await apiFetch("/api/user/groups");
            if (res.ok) setList(parsePersonalGroups(await readJson(res)));
        } catch {
            /* 下次打開再抓。/ Fetched again next time. */
        }
    }, []);

    useEffect(() => {
        if (!enabled) return;
        let live = true;
        apiFetch("/api/user/groups")
            .then((res) => (res.ok ? readJson(res) : null))
            .then((data) => {
                if (live && data) setList(parsePersonalGroups(data));
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [enabled]);

    /** 寫入：成功時用回答取代清單，回傳新建的 id（或 true）；失敗 = null。/ A write; returns the created id (or true), null on failure. */
    const write = async (url: string, method: string, body: unknown, ok: string, failed: string): Promise<number | true | null> => {
        setBusy(true);
        try {
            const res = await apiFetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
            const data = await readJson(res);
            if (!res.ok) {
                showError(responseError(res, data, failed));
                return null;
            }
            const parsed = parsePersonalGroups(data);
            setList({ groups: parsed.groups, users: parsed.users, limit: parsed.limit, max_members: parsed.max_members });
            showSuccess(ok);
            onChanged?.();
            return parsed.created_id ?? true;
        } catch (e) {
            showError(e instanceof Error ? e.message : failed);
            return null;
        } finally {
            setBusy(false);
        }
    };

    const create = (draft: PersonalGroupDraft) => write("/api/user/groups", "POST", draft, t("personalGroups.created", { name: draft.name ?? "" }), t("personalGroups.saveFailed"));
    const update = (id: number, draft: PersonalGroupDraft) => write(`/api/user/groups/${id}`, "PATCH", draft, t("personalGroups.saved"), t("personalGroups.saveFailed"));
    const remove = (id: number) => write(`/api/user/groups/${id}`, "DELETE", undefined, t("personalGroups.deleted"), t("personalGroups.deleteFailed"));

    const preview = async (id: number, body: PersonalPreviewBody): Promise<Impact | null> => {
        try {
            const res = await apiFetch(`/api/user/groups/${id}/preview`, { method: "POST", body: JSON.stringify(body) });
            const data = await readJson(res);
            if (!res.ok) {
                showError(responseError(res, data, t("orgGroups.previewFailed")));
                return null;
            }
            return parseImpact(data);
        } catch (e) {
            showError(e instanceof Error ? e.message : t("orgGroups.previewFailed"));
            return null;
        }
    };

    return { list, busy, reload: load, create, update, remove, preview };
}
