/**
 * AI 活動頁邏輯：開著的 AI（MCP）SSH session（可關閉）與工具呼叫稽核紀錄；隧道（管理員另有使用者）在後端篩選，
 * 工具類型 / 只看失敗 / 搜尋在前端篩選，列表依日期分組，「載入更早的」一次多 300 筆（後端最多 1000）。
 * 後端已依權限過濾：管理員全看，其他人看自己的與自己擁有的隧道上的。
 * AI activity page: live AI (MCP) SSH sessions with close, and the tool-call audit log. Tunnel (and, for admins,
 * user) filters run on the backend; tool type / failed only / search run here; rows are grouped by day and "load
 * older" adds 300 at a time (the backend caps at 1000). The backend scopes both (admins: all; others: own rows +
 * tunnels they own).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/ui/Toast";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS, type NotificationPayload } from "@/types/notification";
import { toolLabel } from "@/lib/aiAccess";
import { countCalls, filterCalls, withTimes, type CallTimes, type ToolFilter } from "@/lib/aiActivity";
import { labelDays, type LabeledDayGroup } from "@/lib/timeline";

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
    /** 開著的互動 shell。/ Open interactive shells. */
    shells?: number;
    busy: boolean;
}

export interface AiActivityRow {
    id: number;
    at: string;
    user: { id: number | null; username: string | null };
    client_name: string | null;
    /** 哪個已連接的應用程式(OAuth grant)。/ The connected app (OAuth grant) behind the call. */
    grant_id?: number | null;
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
    /** MCP 請求的來源 IP（AI app 的出口）。/ The MCP client's address. */
    ip?: string | null;
}

/** 加上頁面要顯示的時間欄位。/ A row plus the formatted time fields the page shows. */
export type AiActivityEntry = AiActivityRow & CallTimes;

export interface FilterOption {
    id: number;
    label: string;
}

export const ALL = "all";
const PAGE = 300;
const MAX_LIMIT = 1000;

export function useAiActivityPage() {
    const { t, locale } = useI18n();
    const { user } = useAuth();
    const { showError, showSuccess } = useToast();
    const isAdmin = !!user?.is_superuser;

    const [sessions, setSessions] = useState<AiSession[]>([]);
    const [rows, setRows] = useState<AiActivityRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [tunnelFilter, setTunnelFilter] = useState<string>(ALL);
    // `?user=<id>`（管理使用者對話框的連結）當起始篩選（只有管理員看得到使用者選單；後端本來就只回看得到的列）。/ `?user=<id>` (from Manage user) seeds the filter (the user select only shows for admins; the backend scopes rows anyway).
    const userParam = useSearchParams().get("user");
    const [userFilter, setUserFilter] = useState<string>(() => (userParam && /^\d+$/.test(userParam) ? userParam : ALL));
    const [search, setSearch] = useState("");
    const [toolFilter, setToolFilter] = useState<ToolFilter>("all");
    const [failedOnly, setFailedOnly] = useState(false);
    // 後端篩選的鍵：rows 屬於哪一組篩選（換了就不顯示舊的），「載入更早的」也跟著重來。
    // The backend filter key: which filters `rows` belong to (stale rows are never shown), and "load older" restarts.
    const filterKey = `${tunnelFilter}|${userFilter}`;
    const [rowsFor, setRowsFor] = useState<string | null>(null);
    // rows 是用多大的 limit 抓的（載入更早的還在路上時，不能拿新的 limit 判斷「沒有更早的」）。
    // The limit `rows` were fetched with (while "load older" is in flight, the new limit says nothing yet).
    const [rowsLimit, setRowsLimit] = useState(PAGE);
    const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
    const [paging, setPaging] = useState({ key: filterKey, limit: PAGE });
    const limit = paging.key === filterKey ? paging.limit : PAGE;
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
            const qs = new URLSearchParams({ limit: String(limit) });
            if (tunnelFilter !== ALL) qs.set("tunnel_id", tunnelFilter);
            if (userFilter !== ALL) qs.set("user_id", userFilter);
            const res = await apiFetch(`/api/ai/activity?${qs.toString()}`);
            if (res.ok) {
                setRows(await res.json());
                setRowsLimit(limit);
                setFetchedAt(new Date());
            } else {
                showError(t("activity.fetchFailed"));
            }
        } catch (e) {
            showError(e instanceof Error ? e.message : t("activity.fetchFailed"));
        } finally {
            setRowsFor(`${tunnelFilter}|${userFilter}`);
        }
    }, [tunnelFilter, userFilter, limit, showError, t]);

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

    // 每列的時間欄位（時:分:秒、日期、完整時間戳）。/ Per-row time fields (time of day, date, full timestamp).
    const entries = useMemo<AiActivityEntry[]>(() => withTimes(rows, fetchedAt ?? new Date(0), locale), [rows, fetchedAt, locale]);

    const label = useCallback((tool: string) => toolLabel(tool, t), [t]);
    const counts = useMemo(() => countCalls(entries, search, toolFilter, label), [entries, search, toolFilter, label]);
    const filtered = useMemo(() => filterCalls(entries, { query: search, tool: toolFilter, failedOnly, label }), [entries, search, toolFilter, failedOnly, label]);
    const groups = useMemo<LabeledDayGroup<AiActivityEntry>[]>(() => labelDays(filtered, fetchedAt ?? new Date(0), t), [filtered, fetchedAt, t]);

    // 第一次載入或換了後端篩選才整個換成轉圈；重新整理 / 載入更早的保留列表，捲動位置不跳。
    // Spinner only for the first load or a backend filter change; refresh / load older keep the list in place.
    const initialLoading = rowsFor !== filterKey;
    // 回來的比要的少 = 沒有更早的了；到了後端上限就兩者都不說。/ Fewer than asked = nothing older; at the cap, neither.
    const loadingMore = rowsLimit < limit;
    const noOlder = !loadingMore && rows.length < rowsLimit;
    const hasMore = !noOlder && rowsLimit < MAX_LIMIT;
    const loadMore = useCallback(() => setPaging({ key: filterKey, limit: Math.min(limit + PAGE, MAX_LIMIT) }), [filterKey, limit]);

    return {
        state: {
            sessions,
            rows: entries,
            filtered,
            groups,
            counts,
            loading,
            initialLoading,
            hasMore,
            noOlder,
            loadingMore,
            isAdmin,
            me: user?.username ?? null,
            meId: user?.id ?? null,
            tunnelFilter,
            userFilter,
            tunnels,
            users,
            search,
            toolFilter,
            failedOnly,
        },
        actions: { refresh, closeSession, setTunnelFilter, setUserFilter, setSearch, setToolFilter, setFailedOnly, loadMore, formatTime },
    };
}
