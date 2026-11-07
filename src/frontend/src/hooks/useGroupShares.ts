/**
 * 分享彈窗的「群組」分頁：通道分享給哪些使用者群組，新增、改、收回（`/api/reverse/server/{id}/group-shares`）。
 * The share dialog's Groups tab: the user groups a tunnel is shared with; add, change, remove.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { parseGroupShares, type GroupShareList, type SharePermission } from "@/lib/groupShares";

export interface GroupSharePatch {
    permission_type?: SharePermission;
    allowed_target_username_ids?: number[];
    /** null = 一直有效。/ null = no end. */
    expires_at?: string | null;
}

export function useGroupShares(tunnelId: number | null, isOpen: boolean, onChanged?: () => void) {
    const { t } = useI18n();
    const { showSuccess, showError } = useToast();
    const [list, setList] = useState<GroupShareList | null>(null);
    const [busy, setBusy] = useState(false);
    const base = tunnelId ? `/api/reverse/server/${tunnelId}/group-shares` : null;

    const load = useCallback(async () => {
        if (!base) return;
        try {
            const res = await apiFetch(base);
            if (res.ok) setList(parseGroupShares(await readJson(res)));
        } catch {
            /* 下次通知再抓。/ Fetched again on the next notification. */
        }
    }, [base]);

    useEffect(() => {
        if (!isOpen) return;
        let live = true;
        if (base) {
            apiFetch(base)
                .then((res) => (res.ok ? readJson(res) : null))
                .then((data) => {
                    if (live && data) setList(parseGroupShares(data));
                })
                .catch(() => undefined);
        }
        return () => {
            live = false;
        };
    }, [isOpen, base]);

    const refreshOn = (msg: { tunnel_id?: number }) => {
        if (isOpen && msg.tunnel_id === tunnelId) void load();
    };
    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.TUNNEL_SHARED]: refreshOn,
        [NOTIFICATION_ACTIONS.TUNNEL_UNSHARED]: refreshOn,
        [NOTIFICATION_ACTIONS.TUNNEL_PERMISSION_UPDATED]: refreshOn,
        [NOTIFICATION_ACTIONS.TUNNEL_USERNAMES_UPDATED]: refreshOn,
    });

    /** 寫入：成功時用回答更新清單，回 true。/ A write: on success the answer becomes the list; returns true. */
    const write = async (url: string, method: string, body: unknown, ok: string, failed: string): Promise<boolean> => {
        setBusy(true);
        try {
            const res = await apiFetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
            const data = await readJson(res);
            if (!res.ok) {
                showError(responseError(res, data, failed));
                return false;
            }
            setList(parseGroupShares(data));
            showSuccess(ok);
            onChanged?.();
            return true;
        } catch (e: unknown) {
            showError(e instanceof Error ? e.message : failed);
            return false;
        } finally {
            setBusy(false);
        }
    };

    const share = (groupId: number, permission: SharePermission, accounts: number[], expiresAt: string | null) =>
        base
            ? write(base, "POST", { group_id: groupId, permission_type: permission, allowed_target_username_ids: accounts, expires_at: expiresAt ?? undefined }, t("share.group.shared"), t("share.group.shareFailed"))
            : Promise.resolve(false);

    const update = (id: number, patch: GroupSharePatch) =>
        base ? write(`${base}/${id}`, "PATCH", patch, t("share.group.updated"), t("share.group.updateFailed")) : Promise.resolve(false);

    const remove = (id: number) => (base ? write(`${base}/${id}`, "DELETE", undefined, t("share.group.removed"), t("share.group.removeFailed")) : Promise.resolve(false));

    return { list, busy, share, update, remove, reload: load };
}
