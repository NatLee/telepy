"use client";

/**
 * API 呼叫紀錄（個人 API token 與 OAuth app 的 token 打的 REST 請求，以及個人 token 的 MCP tool call）。兩頁共用：
 * `mine` = API 頁的「活動」（自己的，可依 token 篩選）；`all` = 管理區的全站 API 活動（可依使用者篩選，`?user=`）。
 * 依日期分組、整頁捲動（篩選列黏在 Header 下方），狀態 / 方法 / 搜尋在前端篩選，一次多載 300 筆。
 * The API call log (REST requests made with personal tokens and OAuth app tokens, plus personal tokens' MCP tool
 * calls). Shared by the API page's Activity (`mine`, filter by token) and the admin section's All API activity
 * (`all`, filter by user). Grouped by day, the page scrolls as a whole with the filter bar stuck under the header.
 */
import React from "react";
import { ChevronDown, Loader2, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Chip } from "@/components/ui/section";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Highlighted, TimelineDay } from "@/components/ui/timeline";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { formatDuration, METHOD_FILTERS, STATUS_FILTERS, statusClass, type StatusFilter } from "@/lib/apiCalls";
import type { ApiToken } from "@/lib/apiTokens";
import type { ViewScope } from "@/components/layout/AdminViews";
import { ALL, useApiCalls, type ApiCallEntry } from "@/hooks/useApiCalls";
import { useStickyBar } from "@/hooks/useStickyBar";
import type { TranslationKey } from "@/locales/en";

const STATUS_LABEL: Record<StatusFilter, TranslationKey> = { all: "apiPage.calls.statusAll", ok: "apiPage.calls.statusOk", "4xx": "apiPage.calls.status4xx", "5xx": "apiPage.calls.status5xx" };
const STATUS_TONE = { ok: "text-success", "4xx": "text-warning", "5xx": "text-destructive" } as const;
const DOT_TONE = { ok: "bg-success", "4xx": "bg-warning", "5xx": "bg-destructive" } as const;

function CallLine({ c, query, showUser }: { c: ApiCallEntry; query: string; showUser: boolean }) {
    const { t } = useI18n();
    const cls = statusClass(c.status);
    const who = c.token ? (c.token.name ?? `#${c.token.id}`) : c.client_name;
    return (
        <li className="px-4 py-2.5 lg:px-5">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs leading-5">
                <time dateTime={c.at} title={c.full} className="font-mono tabular-nums text-muted-foreground">
                    {c.time}
                </time>
                <Chip mono tone={c.method === "MCP" ? "primary" : "neutral"}>
                    {c.method}
                </Chip>
                <span className="min-w-0 font-mono text-[0.75rem] text-foreground wrap-anywhere">
                    <Highlighted text={c.route} query={query} />
                </span>
                {c.tunnel && <span className="rounded-sm border border-border bg-muted px-1.5 font-mono text-[0.6875rem] leading-4 text-foreground/80">{c.tunnel.name ?? `#${c.tunnel.id}`}</span>}
                <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
                    {showUser && (
                        <>
                            <span className="truncate">{c.user.username ?? `#${c.user.id}`}</span>
                            <span aria-hidden>·</span>
                        </>
                    )}
                    <span className="truncate" title={c.client_name}>
                        <Highlighted text={who} query={query} />
                    </span>
                    {c.ip && (
                        <>
                            <span aria-hidden>·</span>
                            <span className="font-mono">{c.ip}</span>
                        </>
                    )}
                </span>
                <span className="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums text-muted-foreground">
                    <span className={cn("size-1.5 rounded-full", DOT_TONE[cls])} aria-hidden />
                    <span className={STATUS_TONE[cls]} title={t("apiPage.calls.statusTitle")}>
                        {c.status}
                    </span>
                    <span>· {formatDuration(c.duration_ms)}</span>
                </span>
            </div>
            {c.error && (
                <p className="mt-1 text-xs leading-5 text-destructive wrap-anywhere">
                    <Highlighted text={c.error} query={query} />
                </p>
            )}
        </li>
    );
}

export function ApiCallsView({ scope, tokens }: { scope: ViewScope; tokens?: ApiToken[] | null }) {
    const { t, tn } = useI18n();
    const { state, actions } = useApiCalls(scope);
    const { all, rows, filtered, groups, counts, loading, initialLoading, failed, hasMore, noOlder, loadingMore, tokenFilter, userFilter, users, status, method, search, filtering, dropped } = state;
    const { refresh, setTokenFilter, setUserFilter, setStatus, setMethod, setSearch, loadMore } = actions;
    const { ref: barRef, style: barStyle } = useStickyBar();
    // 篩選中的 token 不在清單上（被刪了、或是管理區看別人的）→ 從紀錄裡找名字。/ A filtered token missing from the list: name from the rows.
    const tokenName = tokenFilter === ALL ? null : (tokens?.find((x) => String(x.id) === tokenFilter)?.name ?? rows.find((r) => String(r.token?.id) === tokenFilter)?.token?.name ?? `#${tokenFilter}`);
    const tokenInList = !!tokens?.some((x) => String(x.id) === tokenFilter);

    return (
        <div className="flex flex-col" style={barStyle}>
            <div ref={barRef} className="z-20 flex flex-col gap-2 bg-background py-3 sm:sticky sm:top-16">
                <div className="flex flex-col gap-2 lg:flex-row">
                    <div className="flex gap-2">
                        {!all && tokens && tokens.length > 0 && (
                            <Select value={tokenInList || tokenFilter === ALL ? tokenFilter : ALL} onValueChange={setTokenFilter}>
                                <SelectTrigger className="h-10 min-w-0 flex-1 text-sm lg:w-52 lg:flex-none" aria-label={t("apiPage.calls.filterToken")}>
                                    <SelectValue placeholder={t("apiPage.calls.filterToken")} />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={ALL}>{t("apiPage.calls.allTokens")}</SelectItem>
                                    {tokens.map((x) => (
                                        <SelectItem key={x.id} value={String(x.id)}>
                                            {x.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        )}
                        {all && (
                            <Select value={userFilter} onValueChange={setUserFilter}>
                                <SelectTrigger className="h-10 min-w-0 flex-1 text-sm lg:w-48 lg:flex-none" aria-label={t("apiPage.calls.filterUser")}>
                                    <SelectValue placeholder={t("apiPage.calls.filterUser")} />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={ALL}>{t("apiPage.calls.allUsers")}</SelectItem>
                                    {users.map((u) => (
                                        <SelectItem key={u.id} value={String(u.id)}>
                                            {u.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        )}
                        <Button variant="outline" size="icon" className="size-10 shrink-0" onClick={refresh} disabled={loading} aria-label={t("common.refresh")} title={t("common.refresh")}>
                            <RefreshCw size={16} className={loading ? "animate-spin" : undefined} />
                        </Button>
                    </div>
                    <div className="relative flex-1">
                        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                            <Search size={18} className="text-muted-foreground" />
                        </div>
                        <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("apiPage.calls.search")} className="pl-10" aria-label={t("apiPage.calls.search")} />
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    {tokenName && (!tokenInList || all) && (
                        <span className="inline-flex items-center gap-1 rounded-sm border border-border bg-muted px-1.5 py-0.5 text-xs">
                            {t("apiPage.calls.onlyToken", { name: tokenName })}
                            <button type="button" onClick={() => setTokenFilter(ALL)} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
                                {t("apiPage.calls.allTokens")}
                            </button>
                        </span>
                    )}
                    <Segmented
                        size="sm"
                        aria-label={t("apiPage.calls.filterStatus")}
                        value={status}
                        onChange={setStatus}
                        options={STATUS_FILTERS.map((s) => ({
                            value: s,
                            title: t(STATUS_LABEL[s]),
                            label: (
                                <>
                                    {t(STATUS_LABEL[s])}
                                    <span className={cn("ml-1.5 tabular-nums", s !== "all" && s !== "ok" && counts.status[s] > 0 ? STATUS_TONE[s] : "text-muted-foreground")}>{counts.status[s]}</span>
                                </>
                            ),
                        }))}
                    />
                    <div className="max-w-full overflow-x-auto">
                        <Segmented
                            size="sm"
                            aria-label={t("apiPage.calls.filterMethod")}
                            value={method}
                            onChange={setMethod}
                            options={METHOD_FILTERS.map((m) => ({
                                value: m,
                                title: m === "all" ? t("apiPage.calls.methodAll") : m,
                                label: (
                                    <>
                                        {m === "all" ? t("apiPage.calls.methodAll") : m}
                                        <span className="ml-1.5 tabular-nums text-muted-foreground">{counts.method[m]}</span>
                                    </>
                                ),
                            }))}
                        />
                    </div>
                    {!initialLoading && rows.length > 0 && (
                        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{filtering ? t("apiPage.calls.count", { shown: filtered.length, total: rows.length }) : t("apiPage.calls.countAll", { total: rows.length })}</span>
                    )}
                </div>
                {all && dropped !== null && dropped > 0 && <p className="text-xs text-warning">{t("apiPage.calls.dropped", { count: dropped })}</p>}
            </div>

            <div className="overflow-clip rounded-xl border border-border bg-card text-card-foreground shadow-card">
                {initialLoading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="animate-spin text-muted-foreground" aria-label={t("common.loading")} />
                    </div>
                ) : failed && rows.length === 0 ? (
                    <p className="px-6 py-12 text-center text-sm text-destructive">{t("apiPage.calls.loadFailed")}</p>
                ) : rows.length === 0 ? (
                    <p className="px-6 py-14 text-center text-sm text-muted-foreground">{all ? t("apiPage.calls.emptyAll") : t("apiPage.calls.empty")}</p>
                ) : filtered.length === 0 ? (
                    <p className="px-6 py-10 text-center text-sm text-muted-foreground">{t("apiPage.calls.noMatch")}</p>
                ) : (
                    <div className={loading ? "opacity-60 transition-opacity" : undefined} aria-busy={loading || loadingMore}>
                        {groups.map((group, i) => (
                            <TimelineDay key={`${group.day}:${i}`} level={3} label={group.label} count={t("apiPage.calls.dayCount", { count: group.items.length })}>
                                {group.items.map((c) => (
                                    <CallLine key={c.id} c={c} query={search} showUser={all} />
                                ))}
                            </TimelineDay>
                        ))}
                        {(hasMore || noOlder) && (
                            <div className="flex justify-center border-t border-border px-4 py-3">
                                {hasMore ? (
                                    <Button variant="ghost" size="sm" onClick={loadMore} disabled={loadingMore}>
                                        {loadingMore ? <Loader2 size={16} className="animate-spin" /> : <ChevronDown size={16} />}
                                        {t("apiPage.calls.loadMore")}
                                    </Button>
                                ) : (
                                    <span className="py-1 text-xs text-muted-foreground">{t("apiPage.calls.end")}</span>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t("apiPage.calls.footnote")}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {tn("apiPage.calls.cliHint", { cmd: <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-foreground">{all ? "telepy api activity --all" : "telepy api activity"}</code> })}
            </p>
        </div>
    );
}
