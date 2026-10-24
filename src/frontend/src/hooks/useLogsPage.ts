import { useState, useEffect, useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";

/**
 * SSH gateway 事件（/api/log/ssh/events 的一筆）。後端已依權限過濾：管理員全看，其他人只看自己擁有／被分享的隧道。
 * One gateway event from /api/log/ssh/events; the backend scopes them (admins: all, others: own + shared tunnels).
 */
export interface GatewayEvent {
    id: number;
    at: string;
    event: string;
    peer: string | null;
    port: number | null;
    tunnel_id: number | null;
    message: string;
}

export interface LogEntry {
    id: number;
    /** 依 locale 格式化的時間。/ Locale-formatted time. */
    time: string;
    at: string;
    event: string;
    message: string;
    tunnelId: number | null;
    port: number | null;
}

export interface TunnelOption {
    id: number;
    host_friendly_name: string;
    reverse_port: number;
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

const PAGE_LIMIT = 500;

export function useLogsPage() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    // 篩選狀態放在 URL（?tunnel=<id>），隧道列表的「日誌」動作可以直接深連結過來。
    // The filter lives in the URL (?tunnel=<id>) so the tunnel actions menu can deep-link here.
    const tunnelFilter = searchParams.get("tunnel") ?? ALL_TUNNELS;

    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [tunnels, setTunnels] = useState<TunnelOption[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const { showError } = useToast();
    const { t, locale } = useI18n();
    const { user } = useAuth();
    const isAdmin = !!user?.is_superuser;

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

    // 篩選用的隧道清單（後端只回看得到的）。/ Tunnels for the filter (the backend returns only visible ones).
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
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
    }, []);

    const fetchLogs = useCallback(async () => {
        setLoading(true);
        try {
            const qs = new URLSearchParams({ limit: String(PAGE_LIMIT) });
            if (tunnelFilter !== ALL_TUNNELS) qs.set("tunnel_id", tunnelFilter);
            const res = await apiFetch(`/api/log/ssh/events?${qs.toString()}`);
            if (!res.ok) {
                setLogs([]);
                showError(t("logs.fetchFailed"));
                return;
            }
            const events: GatewayEvent[] = await res.json();
            const fmt = new Intl.DateTimeFormat(locale, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false,
            });
            // 後端回舊→新，頁面要新的在上。/ The API is oldest-first; the page shows newest first.
            setLogs(
                events
                    .map((e) => {
                        const d = new Date(e.at);
                        return {
                            id: e.id,
                            at: e.at,
                            time: isNaN(d.getTime()) ? e.at : fmt.format(d),
                            event: e.event,
                            message: e.message,
                            tunnelId: e.tunnel_id,
                            port: e.port,
                        };
                    })
                    .reverse()
            );
        } catch (e) {
            showError(e instanceof Error ? e.message : t("logs.fetchFailed"));
        } finally {
            setLoading(false);
        }
    }, [tunnelFilter, showError, t, locale]);

    useEffect(() => {
        fetchLogs();
    }, [fetchLogs]);

    const filteredLogs = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return logs;
        return logs.filter(
            (log) =>
                log.message.toLowerCase().includes(q) ||
                log.event.includes(q) ||
                log.time.toLowerCase().includes(q) ||
                log.at.toLowerCase().includes(q)
        );
    }, [logs, search]);

    const selectedTunnel = useMemo(
        () => tunnels.find((x) => String(x.id) === tunnelFilter) ?? null,
        [tunnels, tunnelFilter]
    );

    return {
        state: {
            logs,
            filteredLogs,
            loading,
            search,
            setSearch,
            tunnels,
            tunnelFilter,
            selectedTunnel,
            isAdmin,
            verifyOpen,
            verifying,
            verifyReport,
        },
        actions: {
            fetchLogs,
            setTunnelFilter,
            runVerify,
            closeVerify,
        },
    };
}
