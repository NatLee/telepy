/**
 * AI 活動頁邏輯：開著的 AI（MCP）SSH session（可關閉）與工具呼叫稽核紀錄；管理員可依隧道／使用者篩選。
 * 後端已依權限過濾：管理員全看，其他人看自己的與自己擁有的隧道上的。
 * AI activity page: live AI (MCP) SSH sessions with close, and the tool-call audit log; admins can filter.
 * The backend scopes both (admins: all; others: own rows + tunnels they own).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/ui/Toast";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS, type NotificationPayload } from "@/types/notification";

export interface AiSession {
    id: string;
    user: { id: number; username: string };
    client_name: string;
    grant_id: number;
    tunnel: { id: number; name: string };
    username: string;
    created_at: string;
    last_used_at: string;
    expires_at: string;
    idle_timeout_s: number;
    commands: number;
    busy: boolean;
}

export interface AiActivityRow {
    id: number;
    at: string;
    user: { id: number | null; username: string | null };
    client_name: string | null;
    tool: string;
    tunnel: { id: number; name: string | null } | null;
    session_id: string | null;
    target_username: string | null;
    detail: string | null;
    ok: boolean;
    exit_code: number | null;
    duration_ms: number | null;
    bytes_out: number | null;
    error: string | null;
}

export interface FilterOption {
    id: number;
    label: string;
}

export const ALL = "all";
const LIMIT = 300;

export function useAiActivityPage() {
    const { t, locale } = useI18n();
    const { user } = useAuth();
    const { showError, showSuccess } = useToast();
    const isAdmin = !!user?.is_superuser;

    const [sessions, setSessions] = useState<AiSession[]>([]);
    const [rows, setRows] = useState<AiActivityRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [tunnelFilter, setTunnelFilter] = useState<string>(ALL);
    const [userFilter, setUserFilter] = useState<string>(ALL);
    const [tunnels, setTunnels] = useState<FilterOption[]>([]);
    const [users, setUsers] = useState<FilterOption[]>([]);

    const fetchSessions = useCallback(async () => {
        try {
            const res = await apiFetch("/api/ai/sessions");
            if (res.ok) setSessions(await res.json());
        } catch {
            /* keep the previous list */
        }
    }, []);

    const fetchActivity = useCallback(async () => {
        try {
            const qs = new URLSearchParams({ limit: String(LIMIT) });
            if (tunnelFilter !== ALL) qs.set("tunnel_id", tunnelFilter);
            if (userFilter !== ALL) qs.set("user_id", userFilter);
            const res = await apiFetch(`/api/ai/activity?${qs.toString()}`);
            if (res.ok) setRows(await res.json());
            else showError(t("activity.fetchFailed"));
        } catch (e) {
            showError(e instanceof Error ? e.message : t("activity.fetchFailed"));
        }
    }, [tunnelFilter, userFilter, showError, t]);

    const refresh = useCallback(async () => {
        setLoading(true);
        await Promise.all([fetchSessions(), fetchActivity()]);
        setLoading(false);
    }, [fetchSessions, fetchActivity]);

    // 首次載入與篩選變更：setState 只在 await 之後（不在 effect 本體同步呼叫）。
    // Initial load and filter changes; state is only set after awaiting, never synchronously in the effect.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            await Promise.all([fetchSessions(), fetchActivity()]);
            if (!cancelled) setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [fetchSessions, fetchActivity]);

    // 篩選選項（隧道：看得到的；使用者：管理員才有）。/ Filter options (tunnels I can see; users for admins).
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await apiFetch("/api/reverse/server/keys");
                if (res.ok && !cancelled) {
                    const list: { id: number; host_friendly_name: string }[] = await res.json();
                    setTunnels(list.map((x) => ({ id: x.id, label: x.host_friendly_name })));
                }
            } catch {
                /* filter stays empty */
            }
            if (!isAdmin) return;
            try {
                const res = await apiFetch("/api/user/users");
                if (res.ok && !cancelled) {
                    const data: { users?: { id: number; username: string }[] } = await res.json();
                    setUsers((data.users ?? []).map((u) => ({ id: u.id, label: u.username })));
                }
            } catch {
                /* filter stays empty */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [isAdmin]);

    // 即時更新：開/關 session 的通知 → 重抓；別人的 agent 連上我的隧道時提示。
    // Live updates: session notifications refresh the lists; toast when someone else's agent used my tunnel.
    const onSessionEvent = useCallback(
        (msg: NotificationPayload) => {
            if (msg.by && msg.by !== user?.username && msg.details) showSuccess(msg.details);
            fetchSessions();
            fetchActivity();
        },
        [user?.username, showSuccess, fetchSessions, fetchActivity]
    );
    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.AI_SESSION_OPENED]: onSessionEvent,
        [NOTIFICATION_ACTIONS.AI_SESSION_CLOSED]: onSessionEvent,
    });

    const closeSession = useCallback(
        async (s: AiSession) => {
            try {
                const res = await apiFetch(`/api/ai/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" });
                if (res.ok || res.status === 404) {
                    showSuccess(t("activity.sessionClosed", { app: s.client_name, tunnel: s.tunnel.name }));
                    setSessions((prev) => prev.filter((x) => x.id !== s.id));
                } else {
                    showError(t("activity.sessionCloseFailed"));
                }
            } catch {
                showError(t("activity.sessionCloseFailed"));
            }
        },
        [showError, showSuccess, t]
    );

    const fmt = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }), [locale]);
    const formatTime = useCallback(
        (iso: string | null) => {
            if (!iso) return "—";
            const d = new Date(iso);
            return isNaN(d.getTime()) ? iso : fmt.format(d);
        },
        [fmt]
    );

    return {
        state: { sessions, rows, loading, isAdmin, me: user?.username ?? null, tunnelFilter, userFilter, tunnels, users },
        actions: { refresh, closeSession, setTunnelFilter, setUserFilter, formatTime },
    };
}
