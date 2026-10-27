"use client";

/**
 * 一個人的 AI 活動紀錄（管理使用者對話框）：他的已連接應用程式與 API token 呼叫過的工具，依日期分組、可搜尋、
 * 只看失敗、載入更早的；app 名稱打開那個 app 的詳細資料，底下連到篩選好的 AI 活動頁。
 * 對話框本身是捲動區，所以日期標題不黏住（AI 活動頁的 TimelineDay 是黏在整頁的 Header 下）。
 * One person's AI activity (Manage-user dialog): the tool calls their connected apps and API tokens made, grouped by
 * day, with search, failed only and load older; an app name opens that app's details, and a link opens the AI
 * activity page filtered to them. The dialog body is the scroll area, so day headings don't stick (the page's
 * TimelineDay sticks under the page header).
 */
import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Activity, ArrowRight, Loader2, Search } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { toolLabel } from "@/lib/aiAccess";
import { filterCalls, withTimes } from "@/lib/aiActivity";
import { labelDays } from "@/lib/timeline";
import { SectionHeading } from "@/components/ui/section";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { ConnectedAppDialog } from "@/components/layout/ConnectedAppDialog";
import { CallRow } from "./CallRow";
import type { AiActivityRow } from "@/hooks/useAiActivityPage";

const PAGE = 100;
const MAX_LIMIT = 1000;

export function UserActivity({ userId, onNavigate }: { userId: number; onNavigate?: () => void }) {
    const { t, locale } = useI18n();
    const [limit, setLimit] = useState(PAGE);
    // 這組資料是用多大的 limit 抓的；比要的少 = 沒有更早的了。/ The limit the rows came with; fewer = nothing older.
    const [data, setData] = useState<{ rows: AiActivityRow[]; limit: number; at: Date } | null>(null);
    const [failed, setFailed] = useState(false);
    const [query, setQuery] = useState("");
    const [failedOnly, setFailedOnly] = useState(false);
    const [appId, setAppId] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await apiFetch(`/api/ai/activity?scope=all&user_id=${userId}&limit=${limit}`);
                if (cancelled) return;
                if (res.ok) {
                    setData({ rows: await res.json(), limit, at: new Date() });
                    setFailed(false);
                } else {
                    setFailed(true);
                }
            } catch {
                if (!cancelled) setFailed(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [userId, limit]);

    const label = useMemo(() => (tool: string) => toolLabel(tool, t), [t]);
    const groups = useMemo(() => {
        if (!data) return [];
        const entries = withTimes(data.rows, data.at, locale);
        return labelDays(filterCalls(entries, { query, tool: "all", failedOnly, label }), data.at, t);
    }, [data, locale, query, failedOnly, label, t]);

    const loadingMore = data !== null && data.limit < limit;
    const noOlder = data !== null && !loadingMore && data.rows.length < data.limit;
    const canLoadMore = data !== null && !noOlder && data.limit < MAX_LIMIT;

    return (
        <section className="space-y-3">
            <SectionHeading
                icon={<Activity />}
                title={t("activity.userTitle")}
                description={t("activity.userDescription")}
                action={
                    <Button asChild size="sm" variant="outline">
                        <Link href={`/tunnels/admin/activity?user=${userId}`} onClick={onNavigate}>
                            {t("activity.userOpenPage")}
                            <ArrowRight />
                        </Link>
                    </Button>
                }
            />

            {failed && <p className="text-sm text-destructive">{t("activity.fetchFailed")}</p>}

            {data === null ? (
                !failed && <p className="text-sm text-muted-foreground">{t("activity.loading")}</p>
            ) : data.rows.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">{t("activity.userEmpty")}</p>
            ) : (
                <>
                    <div className="flex flex-wrap items-center gap-3">
                        <div className="relative min-w-0 flex-1 basis-60">
                            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("activity.searchPlaceholder")} aria-label={t("activity.searchPlaceholder")} className="pl-9" />
                        </div>
                        <Switch size="sm" checked={failedOnly} onCheckedChange={setFailedOnly}>
                            {t("activity.failedOnly")}
                        </Switch>
                    </div>

                    {groups.length === 0 ? (
                        <p className="rounded-xl border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">{t("activity.noMatch")}</p>
                    ) : (
                        <div className="overflow-clip rounded-xl border border-border">
                            {groups.map((group, i) => (
                                <section key={`${group.day}:${i}`} aria-label={group.label} className="border-t border-border first:border-t-0">
                                    <h3 className="flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2 text-xs text-foreground">
                                        <span>{group.label}</span>
                                        <span className="tabular-nums text-muted-foreground">{t("activity.dayCount", { count: group.items.length })}</span>
                                    </h3>
                                    <ol className="divide-y divide-border">
                                        {group.items.map((r) => (
                                            <CallRow
                                                key={r.id}
                                                r={r}
                                                query={query}
                                                showTunnelChip={false}
                                                onTunnel={() => {}}
                                                onApp={r.grant_id !== null && r.grant_id !== undefined ? () => setAppId(r.grant_id as number) : null}
                                            />
                                        ))}
                                    </ol>
                                </section>
                            ))}
                        </div>
                    )}

                    <div className="flex justify-center">
                        {canLoadMore ? (
                            <Button type="button" variant="outline" size="sm" disabled={loadingMore} onClick={() => setLimit((l) => Math.min(l + PAGE, MAX_LIMIT))}>
                                {loadingMore && <Loader2 className="animate-spin" />}
                                {t("activity.loadMore")}
                            </Button>
                        ) : (
                            noOlder && <p className="text-xs text-muted-foreground">{t("activity.end")}</p>
                        )}
                    </div>
                </>
            )}

            <ConnectedAppDialog grantId={appId} onClose={() => setAppId(null)} onRevoked={() => setAppId(null)} />
        </section>
    );
}
