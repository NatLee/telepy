/**
 * 一條隧道的存取申請：讀清單（owner / ADMIN 看全部，被分享的人看自己的 + 可要的帳號）、提出、核准、拒絕、收回。
 * 收到 ACCESS-REQUEST-* 或權限變動通知就重抓。
 * Access requests on one tunnel: list (owner / ADMIN see all, sharees their own plus the accounts they could ask
 * for), create, approve, deny, withdraw. Refetches on ACCESS-REQUEST-* and permission notifications.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import { requestErrorKey } from "@/lib/accessRequests";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/ui/Toast";
import type { AccessRequestList, SharePermission } from "@/types/accessRequest";

export interface NewAccessRequest {
    account_ids: number[];
    permission: SharePermission | null;
    duration_secs: number;
    reason: string;
}

export function useAccessRequests(tunnelId: number | null, enabled: boolean) {
    const { t } = useI18n();
    const { showSuccess, showError } = useToast();
    const [data, setData] = useState<AccessRequestList | null>(null);
    const [busy, setBusy] = useState(false);

    const reload = useCallback(async () => {
        if (!tunnelId) return;
        try {
            const res = await apiFetch(`/api/reverse/server/${tunnelId}/access-requests`);
            if (res.ok) setData(await res.json());
        } catch {
            // 清單載不到就維持原狀（下一次通知會再試）。/ Keep what we have; the next notification retries.
        }
    }, [tunnelId]);

    useEffect(() => {
        if (enabled) reload();
    }, [enabled, reload]);

    const refetchIfMine = (msg: { tunnel_id?: number }) => {
        if (enabled && msg.tunnel_id === tunnelId) reload();
    };
    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.ACCESS_REQUEST_CREATED]: refetchIfMine,
        [NOTIFICATION_ACTIONS.ACCESS_REQUEST_DECIDED]: refetchIfMine,
        [NOTIFICATION_ACTIONS.ACCESS_REQUEST_UPDATED]: refetchIfMine,
        [NOTIFICATION_ACTIONS.TUNNEL_PERMISSION_UPDATED]: refetchIfMine,
        [NOTIFICATION_ACTIONS.TUNNEL_USERNAMES_UPDATED]: refetchIfMine,
    });

    /** 送出請求；成功回 true。錯誤碼有對應的就翻譯。/ Send a request; true on success. Known error codes are translated. */
    const send = async (path: string, init: RequestInit, ok: string, fallback: string): Promise<boolean> => {
        setBusy(true);
        try {
            const res = await apiFetch(path, init);
            if (res.ok) {
                showSuccess(ok);
                await reload();
                return true;
            }
            const body = await readJson(res);
            const key = requestErrorKey((body as { code?: unknown } | null)?.code);
            showError(key ? t(key) : responseError(res, body, fallback));
            if (res.status === 409) await reload();
        } catch (e) {
            showError(e instanceof Error && e.message ? e.message : fallback);
        } finally {
            setBusy(false);
        }
        return false;
    };

    const create = (req: NewAccessRequest) =>
        send(`/api/reverse/server/${tunnelId}/access-requests`, { method: "POST", body: JSON.stringify(req) }, t("share.request.sent"), t("share.request.sendFailed"));
    const approve = (id: number, durationSecs?: number) =>
        send(`/api/reverse/access-requests/${id}/approve`, { method: "POST", body: JSON.stringify(durationSecs ? { duration_secs: durationSecs } : {}) }, t("share.request.approved"), t("share.request.decideFailed"));
    const deny = (id: number) =>
        send(`/api/reverse/access-requests/${id}/deny`, { method: "POST", body: "{}" }, t("share.request.denied"), t("share.request.decideFailed"));
    const cancel = (id: number) =>
        send(`/api/reverse/access-requests/${id}`, { method: "DELETE" }, t("share.request.withdrawn"), t("share.request.decideFailed"));

    return { data, busy, reload, create, approve, deny, cancel };
}
