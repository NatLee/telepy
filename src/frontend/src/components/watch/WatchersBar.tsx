"use client";

/**
 * 被看的人那一邊（終端機頁、區網終端機）：「N 人在看」chip（點開看是誰、誰在打字、收回）、「共同操作」chip，以及
 * 「X 想打字：允許 / 拒絕」提示列。狀態來自 `/ws/terminal/` 的 `watchers` frame。
 * The watched user's side (terminal page, LAN terminals): an "N watching" chip (who, who types, take back), a
 * "shared control" chip, and the "X wants to type: Allow / Deny" banner. Driven by the socket's `watchers` frame.
 */
import React from "react";
import { Check, Eye, Hand, Keyboard, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Chip } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { controller, pendingRequests, watcherNames, type WatchersFrame } from "@/lib/terminalWatch";
import { formatRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";

export function WatchersChip({ frame, onRevoke, compact = false }: { frame: WatchersFrame | null; onRevoke: () => void; compact?: boolean }) {
    const { t, locale } = useI18n();
    const names = watcherNames(frame);
    if (!frame || names.length === 0) return null;
    const typing = controller(frame);
    return (
        <span className="inline-flex items-center gap-1.5">
            <Popover>
                <PopoverTrigger asChild>
                    <button type="button" className="rounded-sm focus-visible:outline-2 focus-visible:outline-primary" title={names.join(", ")}>
                        <Chip tone="warning">
                            <Eye /> {compact ? names.length : t("watch.owner.watching", { count: names.length })}
                        </Chip>
                    </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="p-3 text-sm">
                    <p className="mb-2 text-foreground">{t("watch.owner.popTitle")}</p>
                    <ul className="space-y-1.5">
                        {frame.watchers.map((w) => (
                            <li key={w.id} className="flex items-center justify-between gap-2">
                                <span className="min-w-0 truncate">{w.username}</span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {w.control ? t("watch.owner.typing") : w.requested ? t("watch.owner.asking") : w.since ? formatRelativeTime(w.since, locale) : ""}
                                </span>
                            </li>
                        ))}
                    </ul>
                    <p className="mt-3 text-xs text-muted-foreground">{t("watch.owner.popHint")}</p>
                    {typing && (
                        <Button size="sm" variant="outline" className="mt-2 w-full" onClick={onRevoke}>
                            <Undo2 size={14} /> {t("watch.owner.revoke", { user: typing.username })}
                        </Button>
                    )}
                </PopoverContent>
            </Popover>
            {typing && (
                <Chip tone="primary" title={t("watch.owner.sharedHint", { user: typing.username })}>
                    <Keyboard /> {compact ? typing.username : t("watch.owner.shared", { user: typing.username })}
                </Chip>
            )}
        </span>
    );
}

/** 「X 想打字」提示列（疊在終端機上，不改大小）。/ The "X wants to type" banner (overlays the terminal). */
export function WatchRequestBanner({ frame, onAnswer, onRevoke, className }: { frame: WatchersFrame | null; onAnswer: (id: number, allow: boolean) => void; onRevoke: () => void; className?: string }) {
    const { t } = useI18n();
    const asks = pendingRequests(frame);
    const typing = controller(frame);
    if (asks.length === 0 && !typing) return null;
    return (
        <div className={cn("space-y-2", className)}>
            {asks.map((w) => (
                <div key={w.id} role="status" aria-live="polite" className="rounded-lg border border-warning/40 bg-card/95 p-2.5 text-sm shadow-pop">
                    <div className="flex items-start gap-2">
                        <Hand size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                        <div className="min-w-0 flex-1">
                            <p className="text-foreground">{t("watch.owner.asks", { user: w.username })}</p>
                            <p className="hidden text-xs text-muted-foreground sm:block">{t("watch.owner.asksHint")}</p>
                        </div>
                    </div>
                    <div className="mt-2 flex justify-end gap-2">
                        <Button size="xs" variant="outline" onClick={() => onAnswer(w.id, false)}>
                            <X /> {t("watch.owner.deny")}
                        </Button>
                        <Button size="xs" onClick={() => onAnswer(w.id, true)}>
                            <Check /> {t("watch.owner.allow")}
                        </Button>
                    </div>
                </div>
            ))}
            {typing && asks.length === 0 && (
                <div role="status" className="flex items-center gap-2 rounded-lg border border-primary/40 bg-card/95 p-2 text-sm shadow-pop">
                    <Keyboard size={16} className="shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0 flex-1 text-foreground">{t("watch.owner.sharedBanner", { user: typing.username })}</span>
                    <Button size="xs" variant="outline" onClick={onRevoke}>
                        <Undo2 /> {t("watch.owner.revokeShort")}
                    </Button>
                </div>
            )}
        </div>
    );
}
