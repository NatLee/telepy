import { useState, useEffect, useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { EVENT_KINDS, countByCategory, filterLogs, type CategoryFilter } from "@/lib/gatewayLogs";
import { dayKey, labelDays, type LabeledDayGroup } from "@/lib/timeline";
import type { ViewScope } from "@/components/layout/AdminViews";

/**
 * SSH gateway 事件（/api/log/ssh/events 的一筆）。`mine`（個人的日誌頁，管理員也一樣）= 自己擁有／被分享的隧道；
 * `all`（管理區的稽核日誌，只有管理員）= 全部，含沒有隧道的站台事件。
 * One gateway event from /api/log/ssh/events. `mine` (the personal Logs page, admins too) = tunnels you own or that
 * are shared with you; `all` (the admin section's audit log, admins only) = everything, tunnel-less site events too.
 */
export interface GatewayEvent {
    id: number;
    at: string;
    event: string;
    peer: string | null;
    port: number | null;
    tunnel_id: number | null;
    /** 隧道還在時的名稱。/ The tunnel's name while it exists. */
    tunnel_name?: string | null;
    message: string;
}

export interface LogEntry {
    id: number;
    /** 依 locale 格式化的時:分:秒（日期在分組標題）。/ Locale-formatted time of day (the date is in the group heading). */
    time: string;
    /** 依 locale 格式化的日期，例如「10月24日 週五」。/ Locale-formatted date, e.g. "Fri, Oct 24". */
    date: string;
    /** 本地日期鍵 YYYY-MM-DD。/ Local day key. */
    day: string;
    /** 完整時間戳（含時區），滑過時間時顯示。/ Full timestamp with time zone, shown on hover. */
    full: string;
    at: string;
    event: string;
    message: string;
    tunnelId: number | null;
    tunnelName: string | null;
    port: number | null;
}

export interface TunnelOption {
    id: number;
    host_friendly_name: string;
    reverse_port: number;
    /** 擁有者（只有管理區的清單有）。/ The owner (only in the admin section's list). */
    owner?: string | null;
}

/**
 * 稽核表雜湊鏈的驗證結果（/api/log/audit/verify，只有管理員）。`reason` 是機器可讀代碼，對應 `logs.verify.reason.*`。
 * Hash-chain verification of one audit table (admins only); `reason` maps to `logs.verify.reason.*`.
 */
export interface AuditTableReport {
    table: string;
    ok: boolean;
    checked: number;
    first_id: number | null;
    last_id: number | null;
    unhashed_before: number;
    broken_at: number | null;
    reason: string | null;
    checkpoints_checked: number;
    checkpoints_mismatched: number;
}

export interface AuditVerifyReport {
    ok: boolean;
    tables: AuditTableReport[];
}

/** 隧道篩選的「全部」值（URL 上不帶 ?tunnel=）。/ The "all tunnels" filter value (no ?tunnel= in the URL). */
export const ALL_TUNNELS = "all";
/** 只看沒有隧道的站台事件（管理區）。/ Only the tunnel-less site events (admin section). */
export const SITE_EVENTS = "none";

/** 一次多載幾筆；後端最多 5000。/ Events per page; the backend caps `limit` at 5000. */
export const PAGE_LIMIT = 500;
const MAX_LIMIT = 5000;

export type LogDayGroup = LabeledDayGroup<LogEntry>;

export function useLogsPage(scope: ViewScope = "mine") {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    // 篩選狀態放在 URL（?tunnel=<id>），隧道列表的「日誌」動作可以直接深連結過來。
    // The filter lives in the URL (?tunnel=<id>) so the tunnel actions menu can deep-link here.
    const tunnelFilter = searchParams.get("tunnel") ?? ALL_TUNNELS;

    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
    // 目前的 logs 屬於哪個隧道篩選；換隧道時舊資料不留在畫面上。/ Which tunnel filter `logs` belongs to, so a switch never shows the old tunnel's events.
    const [logsFor, setLogsFor] = useState<string | null>(null);
    const [tunnels, setTunnels] = useState<TunnelOption[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [category, setCategory] = useState<CategoryFilter>("all");
    // 「載入更早的」會加大 limit；換隧道就回到第一頁。/ "Load older" raises the limit; switching tunnels starts over.
    const [paging, setPaging] = useState({ tunnel: tunnelFilter, limit: PAGE_LIMIT });
    const limit = paging.tunnel === tunnelFilter ? paging.limit : PAGE_LIMIT;
    // logs 是用多大的 limit 抓的（載入更早的還在路上時，不能拿新的 limit 判斷「沒有更早的」）。
    // The limit `logs` were fetched with (while "load older" is in flight, the new limit says nothing yet).
    const [logsLimit, setLogsLimit] = useState(PAGE_LIMIT);
    const { showError } = useToast();
    const { t, locale } = useI18n();
    const { user } = useAuth();
    // 完整性驗證只在管理區（它驗的是整張表）。/ The integrity check lives in the admin section (it checks whole tables).
    const isAdmin = scope === "all" && !!user?.is_superuser;

    // 完整性驗證（管理員）：對話框開著時顯示結果。/ Integrity check (admins); the dialog shows the result.
    const [verifyOpen, setVerifyOpen] = useState(false);
    const [verifying, setVerifying] = useState(false);
    const [verifyReport, setVerifyReport] = useState<AuditVerifyReport | null>(null);

    const runVerify = useCallback(async () => {
        setVerifyOpen(true);
        setVerifying(true);
        setVerifyReport(null);
        try {
            const res = await apiFetch("/api/log/audit/verify");
            if (!res.ok) {
                showError(t("logs.verify.failed"));
                setVerifyOpen(false);
                return;
            }
            setVerifyReport(await res.json());
        } catch (e) {
            showError(e instanceof Error ? e.message : t("logs.verify.failed"));
            setVerifyOpen(false);
        } finally {
            setVerifying(false);
        }
    }, [showError, t]);

    const closeVerify = useCallback(() => setVerifyOpen(false), []);

    const setTunnelFilter = useCallback(
        (value: string) => {
            const params = new URLSearchParams(searchParams.toString());
            if (value === ALL_TUNNELS) params.delete("tunnel");
            else params.set("tunnel", value);
            const qs = params.toString();
            router.replace(qs ? `${pathname}?${qs}` : pathname);
        },
        [router, pathname, searchParams]
    );

    // 篩選用的隧道清單：自己的（看得到的）或管理區的全站清單（附擁有者）。
    // Tunnels for the filter: the ones I can see, or every tunnel with its owner in the admin section.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                if (scope === "all") {
                    const res = await apiFetch("/api/log/tunnels");
                    if (!res.ok || cancelled) return;
                    const data: { id: number; name: string; reverse_port: number; owner: { username: string | null } }[] = await res.json();
                    setTunnels(data.map((x) => ({ id: x.id, host_friendly_name: x.name, reverse_port: x.reverse_port, owner: x.owner.username })));
                    return;
                }
                const res = await apiFetch("/api/reverse/server/keys");
                if (!res.ok || cancelled) return;
                const data: TunnelOption[] = await res.json();
                setTunnels(data.map((x) => ({ id: x.id, host_friendly_name: x.host_friendly_name, reverse_port: x.reverse_port })));
            } catch {
                /* the filter simply stays empty */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [scope]);

    // 回傳有沒有拿到（重新整理鈕的勾勾）。/ Answers whether it arrived (the Refresh button's check).
    const fetchLogs = useCallback(async (): Promise<boolean> => {
        setLoading(true);
        try {
            const qs = new URLSearchParams({ limit: String(limit) });
            if (scope === "all") qs.set("scope", "all");
            if (tunnelFilter !== ALL_TUNNELS) qs.set("tunnel_id", tunnelFilter);
            const res = await apiFetch(`/api/log/ssh/events?${qs.toString()}`);
            if (!res.ok) {
                setLogs([]);
                setLogsFor(tunnelFilter);
                showError(t("logs.fetchFailed"));
                return false;
            }
            const events: GatewayEvent[] = await res.json();
            const now = new Date();
            const timeFmt = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
            const dateFmt = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", weekday: "short" });
            const dateYearFmt = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", weekday: "short" });
            const fullFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "long" });
            // 後端回舊→新，頁面要新的在上。/ The API is oldest-first; the page shows newest first.
            setLogs(
                events
                    .map((e) => {
                        const d = new Date(e.at);
                        const valid = !isNaN(d.getTime());
                        return {
                            id: e.id,
                            at: e.at,
                            time: valid ? timeFmt.format(d) : e.at,
                            date: valid ? (d.getFullYear() === now.getFullYear() ? dateFmt : dateYearFmt).format(d) : "",
                            day: valid ? dayKey(d) : "",
                            full: valid ? fullFmt.format(d) : e.at,
                            event: e.event,
                            message: e.message,
                            tunnelId: e.tunnel_id,
                            tunnelName: e.tunnel_name ?? null,
                            port: e.port,
                        };
                    })
                    .reverse()
            );
            setFetchedAt(now);
            setLogsFor(tunnelFilter);
            setLogsLimit(limit);
            return true;
        } catch (e) {
            showError(e instanceof Error ? e.message : t("logs.fetchFailed"));
            return false;
        } finally {
            setLoading(false);
        }
    }, [scope, tunnelFilter, limit, showError, t, locale]);

    useEffect(() => {
        fetchLogs();
    }, [fetchLogs]);

    // 搜尋也比對翻譯後的事件標籤。/ The search also matches the translated badge text.
    const label = useCallback((event: string) => (EVENT_KINDS[event] ? t(EVENT_KINDS[event].key) : event), [t]);
    const counts = useMemo(() => countByCategory(logs, search, label), [logs, search, label]);
    const filteredLogs = useMemo(() => filterLogs(logs, { query: search, category, label }), [logs, search, category, label]);

    const groups = useMemo<LogDayGroup[]>(() => labelDays(filteredLogs, fetchedAt ?? new Date(0), t), [filteredLogs, fetchedAt, t]);

    // 第一次載入或換了隧道才整個換成轉圈；重新整理 / 載入更早的保留列表，頁面高度與捲動位置不跳。
    // Spinner only for the first load or a tunnel switch; refresh / load older keep the list so nothing jumps.
    const initialLoading = loading && (logs.length === 0 || logsFor !== tunnelFilter);
    // 回來的比要的少 = 沒有更早的了；到了後端上限就兩者都不說。/ Fewer than asked = nothing older; at the backend cap, neither.
    const loadingMore = logsLimit < limit;
    const noOlder = !loadingMore && logs.length < logsLimit;
    const hasMore = !noOlder && logsLimit < MAX_LIMIT;
    const loadMore = useCallback(() => setPaging({ tunnel: tunnelFilter, limit: Math.min(limit + PAGE_LIMIT, MAX_LIMIT) }), [tunnelFilter, limit]);

    const tunnelsById = useMemo(() => new Map(tunnels.map((x) => [x.id, x])), [tunnels]);

    const selectedTunnel = useMemo(
        () => tunnels.find((x) => String(x.id) === tunnelFilter) ?? null,
        [tunnels, tunnelFilter]
    );

    return {
        state: {
            logs,
            filteredLogs,
            groups,
            counts,
            category,
            hasMore,
            noOlder,
            loading,
            initialLoading,
            search,
            setSearch,
            tunnels,
            tunnelsById,
            tunnelFilter,
            selectedTunnel,
            isAdmin,
            verifyOpen,
            verifying,
            verifyReport,
        },
        actions: {
            fetchLogs,
            loadMore,
            setCategory,
            setTunnelFilter,
            runVerify,
            closeVerify,
        },
    };
}
