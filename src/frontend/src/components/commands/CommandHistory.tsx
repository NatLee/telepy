"use client";

/**
 * 紀錄：被擋下與送核准的指令（誰、在哪、哪條規則、結果、誰決定的），可依結果篩選；自己還在等的可以撤回
 * （等你決定的在頁面最上面）。
 * History: blocked and held commands (who, where, which rule, the outcome and who decided), filtered by outcome;
 * your own pending ones can be withdrawn (the ones you decide sit at the top of the page).
 */
import React, { useMemo, useState } from "react";
import { History, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Chip } from "@/components/ui/section";
import { countByFilter, matchesFilter, STATUS_KEY, STATUS_TONE, type HistoryFilter } from "@/lib/commandRules";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import type { CommandRequest } from "@/types/commandRules";
import { CommandText, RequestOrigin } from "./CommandApprovals";

const FILTERS: { value: HistoryFilter; key: "commands.filter.all" | "commands.filter.pending" | "commands.filter.blocked" | "commands.filter.approved" | "commands.filter.notRun" }[] = [
    { value: "all", key: "commands.filter.all" },
    { value: "pending", key: "commands.filter.pending" },
    { value: "blocked", key: "commands.filter.blocked" },
    { value: "approved", key: "commands.filter.approved" },
    { value: "notRun", key: "commands.filter.notRun" },
];

function Outcome({ r }: { r: CommandRequest }) {
    const { t } = useI18n();
    const who = r.decided_by && (r.status === "approved" || r.status === "denied") ? t("commands.byWho", { by: r.decided_by }) : null;
    return (
        <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Chip tone={STATUS_TONE[r.status]}>{t(STATUS_KEY[r.status])}</Chip>
            {who}
            {/* 只有拒絕的原因是人寫的；撤回 / 逾時的是系統訊息。/ Only a denial's reason is written by a person. */}
            {r.status === "denied" && r.reason && <span className="text-foreground/80">“{r.reason}”</span>}
        </span>
    );
}

export function CommandHistory({ list, onWithdraw }: { list: CommandRequest[] | null; onWithdraw: (id: number) => Promise<void> }) {
    const { t, locale } = useI18n();
    const [filter, setFilter] = useState<HistoryFilter>("all");
    const counts = useMemo(() => countByFilter(list ?? []), [list]);
    const rows = (list ?? []).filter((r) => matchesFilter(r, filter));

    return (
        <div className="space-y-3">
            <div className="overflow-x-auto">
                <Segmented
                    value={filter}
                    onChange={setFilter}
                    options={FILTERS.map((f) => ({ value: f.value, label: `${t(f.key)} ${counts[f.value]}` }))}
                    aria-label={t("commands.filter.label")}
                />
            </div>
            {list !== null && rows.length === 0 ? (
                <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-10 text-center">
                    <span className="mb-3 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
                        <History size={20} />
                    </span>
                    <p className="text-sm text-foreground">{t("commands.historyEmpty")}</p>
                    <p className="mt-1 max-w-md text-xs text-muted-foreground">{t("commands.historyEmptyHint")}</p>
                </div>
            ) : (
                <ul className="space-y-2">
                    {rows.map((r) => (
                        <li key={r.id} className="rounded-xl border border-border bg-card px-4 py-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                                    <span className="text-foreground">{r.user.username}</span>
                                    <RequestOrigin req={r} />
                                </p>
                                <time className="text-xs text-muted-foreground tabular-nums" dateTime={r.created_at} title={new Date(r.created_at).toLocaleString(locale)}>
                                    {formatRelativeTime(r.created_at, locale)}
                                </time>
                            </div>
                            <CommandText command={r.command} className="mt-2" />
                            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                    <Outcome r={r} />
                                    <span className="text-xs text-muted-foreground">
                                        {t(r.rule.scope === "site" ? "commands.matchedSiteRule" : "commands.matchedTunnelRule")} <code className="font-mono text-foreground">{r.rule.pattern}</code>
                                    </span>
                                </span>
                                {r.can_cancel && (
                                    <Button size="xs" variant="outline" onClick={() => void onWithdraw(r.id)}>
                                        <Undo2 /> {t("commands.withdraw")}
                                    </Button>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
