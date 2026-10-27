"use client";

/**
 * AI 活動頁：開著的 AI（MCP）SSH session 與工具呼叫紀錄。所有使用者都看得到（自己的＋自己隧道上的），管理員看全部。
 * 紀錄依日期分組、整頁捲動（篩選列黏在 Header 下方）；AI 下的指令常常很長，預設收合幾行、可展開與複製，不會撐爆版面。
 * AI activity: live AI SSH sessions and the tool-call audit log, grouped by day; the page scrolls as a whole with the
 * filter bar stuck under the header. Agents' commands are often long, so they start collapsed to a few lines and can
 * be expanded or copied without ever widening the layout.
 */
import React, { Suspense, useRef, useState } from "react";
import { Bot, RefreshCw, Search, X, Activity, Loader2, ChevronDown, ListTree } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TimelineDay } from "@/components/ui/timeline";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { TOOL_FILTERS, type ToolFilter } from "@/lib/aiActivity";
import { ALL, useAiActivityPage, type AiSession } from "@/hooks/useAiActivityPage";
import { useStickyBar } from "@/hooks/useStickyBar";
import { ConnectedAppDialog } from "@/components/layout/ConnectedAppDialog";
import { CallRow, linkButton } from "@/components/activity/CallRow";
import type { TranslationKey } from "@/locales/en";

const TOOL_FILTER_LABELS: Record<ToolFilter, TranslationKey> = {
    all: "activity.cat.all",
    exec: "activity.cat.exec",
    files: "activity.cat.files",
    browser: "activity.cat.browser",
    session: "activity.cat.session",
    read: "activity.cat.read",
};

export default function AiActivityPage() {
    // useSearchParams（`?user=`）需要 Suspense 邊界。/ useSearchParams (`?user=`) needs a Suspense boundary.
    return (
        <Suspense fallback={null}>
            <AiActivityContent />
        </Suspense>
    );
}

function AiActivityContent() {
    const { t } = useI18n();
    const { state, actions } = useAiActivityPage();
    const { sessions, rows, filtered, groups, counts, loading, initialLoading, hasMore, noOlder, loadingMore, isAdmin, me, meId, tunnelFilter, userFilter, tunnels, users, search, toolFilter, failedOnly } = state;
    const { refresh, closeSession, setTunnelFilter, setUserFilter, setSearch, setToolFilter, setFailedOnly, loadMore, formatTime } = actions;
    const [pending, setPending] = useState<AiSession | null>(null);
    const [appId, setAppId] = useState<number | null>(null);
    // 日期標題黏在篩選列下方，所以要知道篩選列多高。/ Day headings stick under the filter bar, so they need its height.
    const { ref: barRef, style: barStyle } = useStickyBar();
    const logRef = useRef<HTMLElement>(null);
    // app 的詳細資料只給授權的本人與管理員（隧道擁有者看得到 session，但不是他的授權）。
    // App details are for the person who authorized it and admins; tunnel owners see sessions, not the grant.
    const canOpenApp = (userId: number | null, grantId: number | null | undefined): grantId is number =>
        grantId !== null && grantId !== undefined && (isAdmin || (userId !== null && userId === meId));

    // 從某一列的隧道標籤切過去：換成那條隧道，捲回紀錄開頭。/ From a row's tunnel chip: filter to it, back to the log's top.
    const showTunnel = (id: number) => {
        setTunnelFilter(String(id));
        logRef.current?.scrollIntoView({ block: "start" });
    };

    const filtering = search.trim() !== "" || toolFilter !== "all" || failedOnly;

    return (
        <div className="flex flex-col animate-fade-in-up" style={barStyle}>
            <PageHeader
                className="mb-6"
                icon={<Bot />}
                title={t("activity.title")}
                description={t("activity.subtitle")}
                actions={
                    <Button onClick={refresh} variant="outline" disabled={loading}>
                        <RefreshCw size={16} className={loading ? "animate-spin" : undefined} />
                        {t("common.refresh")}
                    </Button>
                }
            />

            <Callout tone="info" className="mb-6">{isAdmin ? t("activity.bannerAdmin") : t("activity.banner")}</Callout>

            {/* 開著的 session / Live sessions */}
            <section className="mb-8">
                <h2 className="mb-2 flex items-center gap-2 text-sm text-foreground">
                    <Activity size={15} className="text-muted-foreground" aria-hidden />
                    {t("activity.sessionsTitle")}
                    <Badge variant="secondary" className="text-[0.6875rem] leading-none py-0.5">{sessions.length}</Badge>
                </h2>
                {sessions.length === 0 ? (
                    <p className="text-xs text-muted-foreground rounded-xl border border-dashed border-border px-4 py-3">{t("activity.sessionsEmpty")}</p>
                ) : (
                    <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        {sessions.map((s) => (
                            <li key={s.id} className="rounded-xl border border-border bg-card p-4 text-sm flex flex-col gap-2">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        {canOpenApp(s.user.id, s.grant_id) ? (
                                            <button type="button" onClick={() => setAppId(s.grant_id)} className={cn(linkButton, "block text-foreground decoration-foreground/40")} title={t("apps.openDetails", { name: s.client_name })}>
                                                {s.client_name}
                                            </button>
                                        ) : (
                                            <p className="truncate">{s.client_name}</p>
                                        )}
                                        <p className="text-xs text-muted-foreground truncate">
                                            {s.tunnel.name} · {s.username}
                                            {s.user.username !== me && ` · ${t("activity.sessionBy", { user: s.user.username })}`}
                                        </p>
                                    </div>
                                    {s.busy ? (
                                        <Badge variant="default" className="text-[0.6875rem] leading-none py-0.5 gap-1 whitespace-nowrap"><Loader2 size={10} className="animate-spin" /> {t("activity.sessionBusy")}</Badge>
                                    ) : (
                                        <Badge variant="outline" className="text-[0.6875rem] leading-none py-0.5 whitespace-nowrap">{t("activity.sessionIdle")}</Badge>
                                    )}
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    {t("activity.sessionCommands", { count: s.commands })} · {t("activity.sessionLastUsed", { time: formatTime(s.last_used_at) })}
                                </p>
                                <p className="text-xs text-muted-foreground">{t("activity.sessionExpires", { time: formatTime(s.expires_at) })}</p>
                                <div className="flex justify-end">
                                    <Button size="sm" variant="outline" className="h-7 gap-1 text-destructive hover:text-destructive" onClick={() => setPending(s)}>
                                        <X size={13} /> {t("activity.sessionClose")}
                                    </Button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {/* 紀錄 / Audit log */}
            <section ref={logRef} className="scroll-mt-20">
                <h2 className="flex items-center gap-2 text-sm text-foreground">
                    <ListTree size={15} className="text-muted-foreground" aria-hidden />
                    {t("activity.logTitle")}
                </h2>

                {/* 手機上篩選太占高度，所以 sm 以上才黏住。/ On phones the bar would eat the screen, so it only sticks from sm. */}
                <div ref={barRef} className="z-20 flex flex-col gap-2 bg-background py-3 sm:sticky sm:top-16">
                    <div className="flex flex-col gap-2 lg:flex-row">
                        <div className="flex gap-2">
                            <Select value={tunnelFilter} onValueChange={setTunnelFilter}>
                                <SelectTrigger className="h-10 min-w-0 flex-1 text-sm lg:w-52 lg:flex-none" aria-label={t("activity.filterTunnel")}>
                                    <SelectValue placeholder={t("activity.filterTunnel")} />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={ALL}>{t("activity.allTunnels")}</SelectItem>
                                    {tunnels.map((x) => (
                                        <SelectItem key={x.id} value={String(x.id)}>{x.label}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            {isAdmin && (
                                <Select value={userFilter} onValueChange={setUserFilter}>
                                    <SelectTrigger className="h-10 min-w-0 flex-1 text-sm lg:w-44 lg:flex-none" aria-label={t("activity.filterUser")}>
                                        <SelectValue placeholder={t("activity.filterUser")} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={ALL}>{t("activity.allUsers")}</SelectItem>
                                        {users.map((x) => (
                                            <SelectItem key={x.id} value={String(x.id)}>{x.label}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}
                        </div>
                        <div className="relative flex-1">
                            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                <Search size={18} className="text-muted-foreground" />
                            </div>
                            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("activity.searchPlaceholder")} className="pl-10" />
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <div className="max-w-full overflow-x-auto">
                            <Segmented
                                size="sm"
                                aria-label={t("activity.filterTool")}
                                value={toolFilter}
                                onChange={setToolFilter}
                                options={TOOL_FILTERS.map((c) => ({
                                    value: c,
                                    title: t(TOOL_FILTER_LABELS[c]),
                                    label: (
                                        <>
                                            {t(TOOL_FILTER_LABELS[c])}
                                            <span className="ml-1.5 tabular-nums text-muted-foreground">{counts.tools[c]}</span>
                                        </>
                                    ),
                                }))}
                            />
                        </div>
                        <Segmented
                            size="sm"
                            aria-label={t("activity.filterResult")}
                            value={failedOnly ? "failed" : "any"}
                            onChange={(v) => setFailedOnly(v === "failed")}
                            options={[
                                { value: "any", label: t("activity.anyResult") },
                                {
                                    value: "failed",
                                    title: t("activity.failedOnly"),
                                    label: (
                                        <>
                                            {t("activity.failedOnly")}
                                            <span className={cn("ml-1.5 tabular-nums", counts.failed > 0 ? "text-destructive" : "text-muted-foreground")}>{counts.failed}</span>
                                        </>
                                    ),
                                },
                            ]}
                        />
                        {!initialLoading && rows.length > 0 && (
                            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                                {filtering ? t("activity.count", { shown: filtered.length, total: rows.length }) : t("activity.countAll", { total: rows.length })}
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
                                <p className="text-muted-foreground">{t("activity.loading")}</p>
                            </div>
                        </div>
                    ) : rows.length === 0 ? (
                        <p className="px-6 py-16 text-center text-muted-foreground">{t("activity.empty")}</p>
                    ) : filtered.length === 0 ? (
                        <p className="px-6 py-10 text-center text-sm text-muted-foreground">{t("activity.noMatch")}</p>
                    ) : (
                        <div className={loading ? "opacity-60 transition-opacity" : undefined} aria-busy={loading || loadingMore}>
                            {groups.map((group, i) => (
                                <TimelineDay key={`${group.day}:${i}`} level={3} label={group.label} count={t("activity.dayCount", { count: group.items.length })}>
                                    {group.items.map((r) => (
                                        <CallRow
                                            key={r.id}
                                            r={r}
                                            query={search}
                                            showTunnelChip={tunnelFilter === ALL}
                                            onTunnel={showTunnel}
                                            onApp={canOpenApp(r.user.id, r.grant_id) ? () => setAppId(r.grant_id as number) : null}
                                        />
                                    ))}
                                </TimelineDay>
                            ))}
                            {(hasMore || noOlder) && (
                                <div className="flex justify-center border-t border-border px-4 py-3">
                                    {hasMore ? (
                                        <Button variant="ghost" size="sm" onClick={loadMore} disabled={loadingMore}>
                                            {loadingMore ? <Loader2 size={16} className="animate-spin" /> : <ChevronDown size={16} />}
                                            {t("activity.loadMore")}
                                        </Button>
                                    ) : (
                                        <span className="py-1 text-xs text-muted-foreground">{t("activity.end")}</span>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </section>

            <ConnectedAppDialog grantId={appId} onClose={() => setAppId(null)} onRevoked={refresh} />
            <ConfirmDialog
                isOpen={pending !== null}
                onClose={() => setPending(null)}
                onConfirm={() => {
                    if (pending) closeSession(pending);
                    setPending(null);
                }}
                title={t("activity.sessionClose")}
                message={t("activity.sessionCloseConfirm", { app: pending?.client_name ?? "", tunnel: pending?.tunnel.name ?? "" })}
                confirmText={t("activity.sessionClose")}
                isDestructive
            />
        </div>
    );
}
