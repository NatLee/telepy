/**
 * 刪除隧道對話框的邏輯:開啟時讀 `GET /api/reverse/server/{id}/delete-check`(誰失去存取、Telepy 在裝置上裝過
 * 哪些金鑰、哪些 MCP 授權 / AI session 受影響),讓使用者選要不要移除金鑰 / 服務金鑰,以及每個 app 的處理方式
 * (只拿掉這條隧道,或整個撤銷),再以 query 帶選項 DELETE。請求跑的時候(移除服務要幾十秒)後端每一步開始 / 結束都送
 * `TUNNEL-DELETE-PROGRESS`,收進 `events`;回來的報告(含 `steps`)顯示在同一個對話框。
 * Delete-tunnel dialog logic: load the delete check on open, let the user pick what to clean up, DELETE with those
 * options as query parameters. While the request runs (tens of seconds when the service goes) every step's start / end
 * arrives as `TUNNEL-DELETE-PROGRESS` and is kept in `events`; the returned report (with `steps`) is shown in place.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS, type NotificationPayload } from "@/types/notification";
import { DELETE_STEPS, type DeleteStepEvent } from "@/lib/deleteTunnel";
import type { RunPhase } from "@/lib/progressSteps";
import type { AiSession } from "@/hooks/useAiActivityPage";

export interface DeleteCheckKey {
    fingerprint: string;
    owner: string | null;
    /** null = 已經離開清單、等著被移除。/ null = already left the list, pending removal. */
    name: string | null;
    in_list: boolean;
    accounts: string[];
}

export interface DeleteCheckGrant {
    id: number;
    client_name: string;
    user: { id: number; username: string };
    mine: boolean;
    /** only = 只限這條;shared = 這條 + 其他;all = 不限隧道。/ only / shared / all tunnels. */
    coverage: "only" | "shared" | "all";
    other_tunnels: number;
    /** 能不能整個撤銷(自己的、管理員,或只限這條)。/ Whether the whole grant may be revoked here. */
    can_revoke: boolean;
}

/** 每個 app 怎麼處理:revoke = 整個撤銷;keep = 只拿掉這條隧道(其他照舊)。/ Per-app choice. */
export type GrantChoice = "revoke" | "keep";

/** 預設:只限這條的撤銷(留著也沒用),其他的只拿掉這條。/ Default: revoke single-tunnel grants, keep the rest. */
export function defaultGrantChoice(g: DeleteCheckGrant): GrantChoice {
    return g.coverage === "only" && g.can_revoke ? "revoke" : "keep";
}

export interface DeleteCheck {
    tunnel: { id: number; name: string; reverse_port: number };
    /** 一行指令安裝留下的移除腳本(舊後端沒有)。/ The one-command install's uninstall script (absent on older backends). */
    uninstall_script?: string;
    online: boolean;
    /** 這台機器上沒有別的通道了（沒有其他通道釘選同一把 host key）。/ No other tunnel pins this machine's host key. */
    last_on_machine: boolean;
    /** 同一台機器上我看得到的其他通道。/ My other tunnels on this machine. */
    same_machine: { id: number; name: string }[];
    accounts: string[];
    sharees: { id: number; username: string; permission: string }[];
    in_use: number;
    lan_hosts: number;
    device_keys: DeleteCheckKey[];
    grants: DeleteCheckGrant[];
    ai_sessions: AiSession[];
}

/** 裝置端移除腳本回報的一行。/ One line reported by the device-side removal script. */
export interface ServiceItem {
    kind: string;
    what: string;
    detail: string;
}

/** 把隧道服務從裝置移除的結果(每個登入帳號一份)。/ Removing the tunnel service from the device. */
export interface ServiceRemoval {
    accounts: { account: string; platform: "posix" | "windows" | null; os: string | null; items: ServiceItem[]; error: string | null }[];
    found: boolean;
    launched: boolean;
    /** 裝置自己斷線了(真的停了)。/ The device dropped the tunnel by itself. */
    stopped: boolean;
    /** 停了又連回來(還有東西在重啟它)。/ It came back: something still restarts it. */
    came_back: boolean;
}

export interface DeleteReport {
    deleted: boolean;
    online: boolean;
    accounts: { account: string; removed: number; service_key_removed: boolean; error: string | null }[];
    keys_left: number;
    grants_revoked: number;
    grants_detached: number;
    ai_sessions_closed: number;
    device_disconnected: boolean;
    /** null = 沒要求或裝置離線。/ null = not asked for, or the device was offline. */
    service: ServiceRemoval | null;
    /** 每一步怎麼結束(舊後端沒有)。/ How each step ended (absent on older backends). */
    steps?: DeleteStepEvent[];
}

export interface DeleteOptions {
    removeDeviceKeys: boolean;
    removeServiceKey: boolean;
    /** 把裝置上跑這條隧道的服務也移除。/ Also remove what runs the tunnel on the device. */
    removeService: boolean;
}

export function useDeleteTunnel(tunnelId: number | null, isOpen: boolean, onDeleted: () => void) {
    const { t } = useI18n();
    const [check, setCheck] = useState<{ id: number; data: DeleteCheck | null; error: string | null } | null>(null);
    const [options, setOptions] = useState<DeleteOptions>({ removeDeviceKeys: true, removeServiceKey: false, removeService: true });
    // 使用者改過的 app 選擇;沒改過的用預設。/ Per-app choices the user changed; the rest use the default.
    const [grantChoices, setGrantChoices] = useState<Record<number, GrantChoice>>({});
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [report, setReport] = useState<DeleteReport | null>(null);
    // 這次刪除收到的進度(收到的時間記在 `at`,倒數用)與開始的時間。/ Progress received for this delete, and when it started.
    const [events, setEvents] = useState<DeleteStepEvent[]>([]);
    const [startedAt, setStartedAt] = useState<number | null>(null);

    useEffect(() => {
        if (!isOpen || tunnelId === null) return;
        let cancelled = false;
        (async () => {
            let next: { id: number; data: DeleteCheck | null; error: string | null };
            try {
                const res = await apiFetch(`/api/reverse/server/${tunnelId}/delete-check`);
                const body = await readJson<DeleteCheck>(res);
                next = res.ok && body ? { id: tunnelId, data: body, error: null } : { id: tunnelId, data: null, error: responseError(res, body, t("deleteTunnel.checkFailed")) };
            } catch (e) {
                next = { id: tunnelId, data: null, error: e instanceof Error ? e.message : t("deleteTunnel.checkFailed") };
            }
            if (cancelled) return;
            setCheck(next);
            // 機器上最後一條通道：預設把服務金鑰一起移除，不然機器留在 Telepy 裡卻沒有主人。
            // The last tunnel on the machine: remove the service key by default, or the machine stays reachable with it and has no owner.
            if (next.data) setOptions((o) => ({ ...o, removeServiceKey: next.data?.last_on_machine ?? false }));
        })();
        return () => {
            cancelled = true;
        };
    }, [isOpen, tunnelId, t]);

    const current = check && check.id === tunnelId ? check : null;
    const data = current?.data ?? null;

    const choiceFor = useCallback((g: DeleteCheckGrant): GrantChoice => (g.can_revoke ? (grantChoices[g.id] ?? defaultGrantChoice(g)) : "keep"), [grantChoices]);
    const setGrantChoice = useCallback((id: number, choice: GrantChoice) => setGrantChoices((c) => ({ ...c, [id]: choice })), []);

    const handlers = useMemo(
        () => ({
            [NOTIFICATION_ACTIONS.TUNNEL_DELETE_PROGRESS]: (msg: NotificationPayload) => {
                if (!deleting || msg.tunnel_id !== tunnelId) return;
                const step = msg.step as DeleteStepEvent["step"] | undefined;
                if (!step || !(DELETE_STEPS as readonly string[]).includes(step)) return;
                setEvents((prev) => [...prev, { ...(msg as unknown as DeleteStepEvent), step, at: Date.now() }]);
            },
        }),
        [deleting, tunnelId],
    );
    useNotificationHandlers(handlers);

    const submit = useCallback(async () => {
        if (tunnelId === null || !data) return;
        setDeleting(true);
        setError(null);
        setEvents([]);
        setStartedAt(Date.now());
        // 裝置離線時金鑰動不了,不要送出做不到的選項。/ Offline: don't ask for what cannot be done.
        const qs = new URLSearchParams({
            remove_device_keys: String(data.online && options.removeDeviceKeys),
            remove_service_key: String(data.online && options.removeServiceKey),
            remove_service: String(data.online && options.removeService),
            revoke_grants: "false",
            revoke_grant_ids: data.grants.filter((g) => choiceFor(g) === "revoke").map((g) => g.id).join(","),
        });
        try {
            const res = await apiFetch(`/api/reverse/server/keys/${tunnelId}?${qs.toString()}`, { method: "DELETE" });
            const body = await readJson<DeleteReport>(res);
            if (res.ok && body) {
                setReport(body);
                onDeleted();
            } else {
                setError(responseError(res, body, t("tunnels.deleteFailed")));
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : t("tunnels.deleteFailed"));
        } finally {
            setDeleting(false);
        }
    }, [tunnelId, data, options, choiceFor, onDeleted, t]);

    const setOption = useCallback(<K extends keyof DeleteOptions>(key: K, value: DeleteOptions[K]) => setOptions((o) => ({ ...o, [key]: value })), []);

    return {
        check: data,
        checkError: current?.error ?? null,
        loading: isOpen && tunnelId !== null && current === null,
        options,
        setOption,
        choiceFor,
        setGrantChoice,
        deleting,
        error,
        report,
        submit,
        events,
        startedAt,
        /** 整件事在哪:沒開始 / 跑著 / 做完 / 請求失敗。/ Where the run is. */
        phase: (report ? "done" : deleting ? "running" : error && startedAt ? "failed" : "idle") as RunPhase,
    };
}
