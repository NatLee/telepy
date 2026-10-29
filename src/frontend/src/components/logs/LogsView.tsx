"use client";

/**
 * SSH gateway 日誌：結構化事件依日期分組、隧道篩選（?tunnel=<id>，可從隧道列表深連結）、事件類型篩選、關鍵字搜尋（命中處標示）。
 * 兩個頁面共用：`mine` = 日誌頁（自己擁有／被分享的隧道，管理員也一樣）；`all` = 管理區的稽核日誌（全站，含沒有隧道的
 * 站台事件、擁有者、完整性驗證）。整頁捲動：篩選列黏在 Header 下方（sm 以上），每天的標題再黏在篩選列下方。
 * SSH gateway logs: structured events grouped by day, tunnel filter (?tunnel=<id>, deep-linkable from the tunnel list),
 * event-type filter and keyword search (hits highlighted). Two pages share it: `mine` = the Logs page (tunnels you own
 * or that are shared with you, admins too); `all` = the admin section's audit log (the whole site, with tunnel-less
 * site events, owners and the integrity check). The page itself scrolls: the filter bar sticks under the header (sm
 * and up) and each day's heading under the filter bar.
 */
import React, { useRef } from "react";
import { Search, FileText, AlertCircle, Filter, X, ShieldCheck, ChevronDown, ScrollText } from "lucide-react";
import { AuditVerifyDialog } from "@/components/logs/AuditVerifyDialog";
import { Button } from "@/components/ui/button";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Callout } from "@/components/ui/callout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { ALL_TUNNELS, SITE_EVENTS, useLogsPage, type LogEntry, type TunnelOption } from "@/hooks/useLogsPage";
import { AdminChip, AdminViewLink, type ViewScope } from "@/components/layout/AdminViews";
import { CATEGORY_FILTERS, EVENT_KINDS, type CategoryFilter } from "@/lib/gatewayLogs";
import { Highlighted, TimelineDay } from "@/components/ui/timeline";
import { useStickyBar } from "@/hooks/useStickyBar";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";

const CATEGORY_LABELS: Record<CategoryFilter, TranslationKey> = {
    all: "logs.cat.all",
    problem: "logs.cat.problem",
    connection: "logs.cat.connection",
    session: "logs.cat.session",
    change: "logs.cat.change",
};

const chipClass =
    "mr-2 inline-flex max-w-full items-center rounded-sm border border-border bg-muted px-1.5 align-[1px] font-sans text-[0.6875rem] leading-4 text-foreground/80 transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

function LogRow({
    log,
    query,
    tunnel,
    onTunnel,
    onSite,
}: {
    log: LogEntry;
    query: string;
    /** 看全部隧道時才有：這一列的隧道（可點，只看那條）。/ Only in the all-tunnels view: the row's tunnel (click = only it). */
    tunnel: TunnelOption | null;
    onTunnel: (id: number) => void;
    /** 管理區：沒有隧道的站台事件標成「站台」，點了只看這些。/ Admin section: tunnel-less events get a "Site" chip that filters to them. */
    onSite: (() => void) | null;
}) {
    const { t } = useI18n();
    const known = EVENT_KINDS[log.event];
    return (
        // 寬螢幕三欄（時間 / 事件 / 訊息）；窄的時候時間 + 標籤一行、訊息在下一行，不會把訊息擠成幾個字寬。
        // Three columns on wide screens; narrower, time + badge share a line above the message, which is never squeezed.
        <li className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-muted/40 lg:grid-cols-[4.5rem_8.5rem_minmax(0,1fr)] lg:gap-x-4 lg:px-5 lg:py-2">
            <time dateTime={log.at} title={log.full} className="font-mono text-xs leading-5 text-muted-foreground tabular-nums">
                {log.time}
            </time>
            <span className="flex h-5 min-w-0 items-center">
                <Badge variant={known?.tone ?? "outline"} className="text-[0.6875rem] leading-none py-0.5">
                    {known ? t(known.key) : log.event}
                </Badge>
            </span>
            <p className="col-span-2 min-w-0 font-mono text-xs leading-5 text-foreground whitespace-pre-wrap wrap-anywhere lg:col-span-1">
                {tunnel && (
                    <button type="button" onClick={() => onTunnel(tunnel.id)} title={t("logs.onlyTunnel", { name: tunnel.host_friendly_name })} className={chipClass}>
                        <span className="truncate">{tunnel.host_friendly_name}</span>
                        <span className="ml-1 text-muted-foreground tabular-nums">· {tunnel.reverse_port}</span>
                        {tunnel.owner && <span className="ml-1 text-muted-foreground">· {tunnel.owner}</span>}
                    </button>
                )}
                {onSite && (
                    <button type="button" onClick={onSite} title={t("logs.onlySite")} className={chipClass}>
                        {t("logs.siteChip")}
                    </button>
                )}
                <Highlighted text={log.message} query={query} />
            </p>
        </li>
    );
}

export function LogsView({ scope }: { scope: ViewScope }) {
    const { t } = useI18n();
    const { state, actions } = useLogsPage(scope);
    const site = scope === "all";
    const { logs, filteredLogs, groups, counts, category, hasMore, noOlder, loading, initialLoading, search, setSearch, tunnels, tunnelsById, tunnelFilter, selectedTunnel, isAdmin, verifyOpen, verifying, verifyReport } = state;
    const { fetchLogs, loadMore, setCategory, setTunnelFilter, runVerify, closeVerify } = actions;

    // 每天的標題黏在篩選列下方，所以要知道篩選列多高（會換行，選了隧道也會變）。
    // Day headings stick under the filter bar, so they need its height (it wraps, and grows with a tunnel selected).
    const { ref: barRef, style: barStyle } = useStickyBar();
    // 重新整理後畫面上的列依序淡入。/ After Refresh, the rows on screen fade back in.
    const pageRef = useRef<HTMLDivElement>(null);

    // 從某一列的隧道標籤切過去：換成那條隧道並回到頂端。/ From a row's tunnel chip: filter to it and go back to the top.
    const showTunnel = (id: number) => {
        setTunnelFilter(String(id));
        window.scrollTo({ top: 0 });
    };

    const showSite = () => {
        setTunnelFilter(SITE_EVENTS);
        window.scrollTo({ top: 0 });
    };
    // 清單裡沒有的隧道（剛建的、已刪的）用事件帶來的名稱。/ Tunnels missing from the list (new, deleted) use the event's name.
    const rowTunnel = (log: LogEntry): TunnelOption | null => {
        if (log.tunnelId === null) return null;
        const known = tunnelsById.get(log.tunnelId);
        if (known) return known;
        return log.tunnelName ? { id: log.tunnelId, host_friendly_name: log.tunnelName, reverse_port: log.port ?? 0 } : null;
    };

    const filtering = search.trim() !== "" || category !== "all";

    return (
        <div ref={pageRef} className="flex flex-col animate-fade-in-up" style={barStyle}>
            <PageHeader
                className="mb-6"
                icon={site ? <ScrollText /> : <FileText />}
                title={site ? t("logs.allTitle") : t("logs.title")}
                titleAddon={site ? <AdminChip /> : undefined}
                description={site ? t("logs.allSubtitle") : t("logs.subtitle")}
                actions={
                    <>
                        {isAdmin && (
                            <Button onClick={runVerify} variant="outline">
                                <ShieldCheck size={16} />
                                {t("logs.verify.button")}
                            </Button>
                        )}
                        <RefreshButton onRefresh={fetchLogs} busy={loading} ripple={pageRef} label={t("common.refresh")} />
                    </>
                }
            />
            {isAdmin && <AuditVerifyDialog isOpen={verifyOpen} onClose={closeVerify} onRerun={runVerify} loading={verifying} report={verifyReport} />}

            {site ? (
                <Callout tone="info" className="mb-1">{t("logs.bannerAll")}</Callout>
            ) : (
                <>
                    <Callout tone="info" className="mb-1">{t("logs.banner")}</Callout>
                    <AdminViewLink className="mt-2 mb-1" href="/tunnels/admin/logs" label={t("nav.adminLogs")} />
                </>
            )}

            {/* 手機上三列篩選太占高度，所以 sm 以上才黏住。/ On phones the three-row bar would eat the screen, so it only sticks from sm. */}
            <div ref={barRef} className="z-20 flex flex-col gap-2 bg-background py-3 sm:sticky sm:top-16">
                <div className="flex flex-col gap-2 sm:flex-row">
                    <div className="flex items-center gap-2 sm:w-64 xl:w-80">
                        <Filter size={16} className="text-muted-foreground shrink-0" aria-hidden />
                        <Select value={tunnelFilter} onValueChange={setTunnelFilter}>
                            <SelectTrigger className="h-10 flex-1 min-w-0 text-sm" aria-label={t("logs.tunnelFilter")}>
                                <SelectValue placeholder={t("logs.tunnelFilter")} />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ALL_TUNNELS}>{t("logs.allTunnels")}</SelectItem>
                                {site && <SelectItem value={SITE_EVENTS}>{t("logs.siteEvents")}</SelectItem>}
                                {tunnels.map((tunnel) => (
                                    <SelectItem key={tunnel.id} value={String(tunnel.id)}>
                                        {tunnel.host_friendly_name} · {tunnel.reverse_port}
                                        {tunnel.owner ? ` · ${tunnel.owner}` : ""}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {(selectedTunnel || tunnelFilter === SITE_EVENTS) && (
                            <Button variant="ghost" size="icon" className="size-10 shrink-0" onClick={() => setTunnelFilter(ALL_TUNNELS)} aria-label={t("logs.showAll")} title={t("logs.showAll")}>
                                <X size={16} />
                            </Button>
                        )}
                    </div>
                    <div className="relative flex-1">
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                            <Search size={18} className="text-muted-foreground" />
                        </div>
                        <Input
                            type="search"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder={t("logs.searchPlaceholder")}
                            className="pl-10"
                        />
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <div className="max-w-full overflow-x-auto">
                        <Segmented
                            size="sm"
                            aria-label={t("logs.filterCategory")}
                            value={category}
                            onChange={setCategory}
                            options={CATEGORY_FILTERS.map((c) => ({
                                value: c,
                                title: t(CATEGORY_LABELS[c]),
                                label: (
                                    <>
                                        {t(CATEGORY_LABELS[c])}
                                        <span className={`ml-1.5 tabular-nums ${c === "problem" && counts.problem > 0 ? "text-destructive" : "text-muted-foreground"}`}>{counts[c]}</span>
                                    </>
                                ),
                            }))}
                        />
                    </div>
                    {!initialLoading && logs.length > 0 && (
                        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                            {filtering ? t("logs.count", { shown: filteredLogs.length, total: logs.length }) : t("logs.countAll", { total: logs.length })}
                        </span>
                    )}
                </div>
            </div>

            {/* overflow-clip：見 components/ui/timeline.tsx。/ overflow-clip: see components/ui/timeline.tsx. */}
            <div className="bg-card text-card-foreground border border-border rounded-xl shadow-card overflow-clip">
                {initialLoading ? (
                    <div className="flex justify-center items-center py-24">
                        <div className="flex flex-col items-center">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mb-4"></div>
                            <p className="text-muted-foreground">{t("logs.loading")}</p>
                        </div>
                    </div>
                ) : logs.length === 0 ? (
                    <div className="flex justify-center items-center py-24">
                        <div className="text-center">
                            <AlertCircle size={48} className="mx-auto text-muted-foreground mb-4 opacity-50" />
                            <p className="text-muted-foreground text-lg">{t("logs.empty")}</p>
                        </div>
                    </div>
                ) : filteredLogs.length === 0 ? (
                    <p className="px-6 py-10 text-center text-sm text-muted-foreground">{t("logs.noMatch")}</p>
                ) : (
                    <div className={loading ? "opacity-60 transition-opacity" : undefined} aria-busy={loading}>
                        {groups.map((group, i) => (
                            <TimelineDay key={`${group.day}:${i}`} label={group.label} count={t("logs.dayCount", { count: group.items.length })}>
                                {group.items.map((log) => (
                                    <LogRow
                                        key={log.id}
                                        log={log}
                                        query={search}
                                        tunnel={tunnelFilter === ALL_TUNNELS ? rowTunnel(log) : null}
                                        onTunnel={showTunnel}
                                        onSite={site && tunnelFilter === ALL_TUNNELS && log.tunnelId === null ? showSite : null}
                                    />
                                ))}
                            </TimelineDay>
                        ))}
                        {(hasMore || noOlder) && (
                            <div className="flex justify-center border-t border-border px-4 py-3">
                                {hasMore ? (
                                    <Button variant="ghost" size="sm" onClick={loadMore} disabled={loading}>
                                        <ChevronDown size={16} />
                                        {t("logs.loadMore")}
                                    </Button>
                                ) : (
                                    <span className="py-1 text-xs text-muted-foreground">{t("logs.end")}</span>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
