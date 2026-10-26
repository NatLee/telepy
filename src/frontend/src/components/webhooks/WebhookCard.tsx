"use client";

/**
 * 一個 webhook 的卡片：服務 + 網址（遮掉 token）、訂的事件、哪些隧道、延遲與語言、最近一次送出的結果，
 * 開關與動作（送測試、送出紀錄、簽章密鑰、編輯、刪除）。
 * One webhook: service + URL (tokens masked), its events, tunnels, delay and language, the latest delivery,
 * the on / off switch and actions (test, deliveries, signing secret, edit, delete).
 */
import React from "react";
import { History, KeyRound, MoreHorizontal, Pencil, Play, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/section";
import { Switch } from "@/components/ui/switch";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import { FORMAT_SHORT, LANGUAGES, effectiveFormat, hasStatusEvent, hasTunnelEvent, hookState, maskUrl, orderEvents } from "@/lib/webhooks";
import type { CatalogEvent, Webhook } from "@/types/webhooks";
import { ServiceTile, StateDot, useDelayLabel, useEventLabel } from "./parts";

/** 卡片上最多列幾個事件名稱。/ Event names shown on a card before "+N". */
const SHOWN_EVENTS = 4;

interface Props {
    hook: Webhook;
    catalog: CatalogEvent[];
    pauseAfter: number;
    testing: boolean;
    onToggle: (enabled: boolean) => void;
    onTest: () => void;
    onEdit: () => void;
    onDeliveries: () => void;
    onSecret: () => void;
    onDelete: () => void;
}

export function WebhookCard({ hook, catalog, pauseAfter, testing, onToggle, onTest, onEdit, onDeliveries, onSecret, onDelete }: Props) {
    const { t, locale } = useI18n();
    const eventLabel = useEventLabel();
    const delayLabel = useDelayLabel();
    const format = effectiveFormat(hook.format, hook.url);
    const state = hookState(hook);
    const events = orderEvents(hook.events, catalog);
    const extra = events.length - SHOWN_EVENTS;
    const when = hook.last?.at ? formatRelativeTime(hook.last.at, locale) : "";
    const absolute = hook.last?.at ? new Date(hook.last.at).toLocaleString(locale) : undefined;

    const facts: string[] = [];
    if (hasTunnelEvent(hook.events, catalog)) {
        facts.push(hook.all_tunnels ? t(hook.scope === "site" ? "webhooks.card.everyTunnel" : "webhooks.card.allTunnels") : t("webhooks.card.someTunnels", { names: hook.tunnels.map((x) => x.name ?? `#${x.id}`).join(", ") }));
    }
    if (hasStatusEvent(hook.events, catalog)) facts.push(hook.delay > 0 ? t("webhooks.card.delay", { delay: delayLabel(hook.delay) }) : t("webhooks.card.noDelay"));
    facts.push(LANGUAGES.find((l) => l.value === hook.language)?.label ?? hook.language);

    return (
        <li className={cn("flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-card", !hook.enabled && "bg-surface")}>
            <div className="flex items-start gap-3">
                <ServiceTile format={format} />
                <div className="min-w-0 flex-1 self-center">
                    <p className="text-base text-foreground [overflow-wrap:anywhere]">{hook.name}</p>
                    <p className="hidden text-sm text-muted-foreground [overflow-wrap:anywhere] sm:block" title={t("webhooks.card.urlHidden")}>
                        {FORMAT_SHORT[format]} · <span className="font-mono text-xs">{maskUrl(hook.url)}</span>
                    </p>
                </div>
                <Switch size="sm" checked={hook.enabled} onCheckedChange={onToggle} aria-label={t("webhooks.card.toggle", { name: hook.name })} className="mt-1" />
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button size="icon" variant="ghost" className="size-8 shrink-0" aria-label={t("webhooks.card.actions", { name: hook.name })}>
                            <MoreHorizontal size={16} />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={onEdit}><Pencil size={14} /> {t("common.edit")}</DropdownMenuItem>
                        <DropdownMenuItem onSelect={onTest}><Send size={14} /> {t("webhooks.card.test")}</DropdownMenuItem>
                        <DropdownMenuItem onSelect={onDeliveries}><History size={14} /> {t("webhooks.card.deliveries")}</DropdownMenuItem>
                        <DropdownMenuItem onSelect={onSecret}><KeyRound size={14} /> {t("webhooks.card.secret")}</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive"><Trash2 size={14} /> {t("common.delete")}</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            {/* 手機上網址放到整列寬，不跟開關擠在一起。/ On phones the URL gets the full width instead of squeezing beside the switch. */}
            <p className="-mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere] sm:hidden" title={t("webhooks.card.urlHidden")}>
                {FORMAT_SHORT[format]} · <span className="font-mono text-xs">{maskUrl(hook.url)}</span>
            </p>
            <div className="flex flex-wrap gap-1.5" aria-label={t("webhooks.card.events")}>
                {events.slice(0, SHOWN_EVENTS).map((e) => (
                    <Chip key={e}>{eventLabel(e)}</Chip>
                ))}
                {extra > 0 && (
                    <button type="button" onClick={onEdit} className="rounded-sm text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                        {t("webhooks.card.moreEvents", { n: extra })}
                    </button>
                )}
            </div>
            <p className="text-xs text-muted-foreground">
                {facts.map((f, i) => (
                    // 每一項整段換行，不在字中間斷開。/ Each fact wraps as a unit, never mid-word.
                    <span key={i} className="inline-block [overflow-wrap:anywhere]">
                        {f}
                        {i < facts.length - 1 && <span className="px-1" aria-hidden>·</span>}
                    </span>
                ))}
            </p>

            <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-3">
                <p className="flex min-w-0 flex-1 basis-56 items-start gap-2 text-sm">
                    <StateDot state={state} className="mt-1.5" />
                    <span className="min-w-0 [overflow-wrap:anywhere]" title={absolute}>
                        {state === "ok" && (
                            <span className="text-foreground">
                                {t("webhooks.card.delivered", { time: when })}
                                {hook.last?.http_status ? <span className="text-muted-foreground"> · HTTP {hook.last.http_status}</span> : null}
                            </span>
                        )}
                        {state === "failing" && (
                            <>
                                <span className="text-destructive">{t("webhooks.card.failed", { time: when })}</span>
                                <span className="block text-xs text-muted-foreground">
                                    {hook.last?.error}
                                    {hook.failures > 1 ? ` · ${t("webhooks.card.inARow", { n: hook.failures, max: pauseAfter })}` : ""}
                                </span>
                            </>
                        )}
                        {state === "never" && <span className="text-muted-foreground">{t("webhooks.card.never")}</span>}
                        {state === "off" && <span className="text-muted-foreground">{t("webhooks.card.off")}</span>}
                        {state === "paused" && (
                            <>
                                <span className="text-warning">{t("webhooks.card.paused", { n: pauseAfter })}</span>
                                {hook.last?.error && <span className="block text-xs text-muted-foreground">{hook.last.error}</span>}
                            </>
                        )}
                    </span>
                </p>
                <div className="flex flex-wrap items-center gap-2">
                    {state === "paused" ? (
                        <Button size="sm" onClick={() => onToggle(true)}>
                            <Play size={15} /> {t("webhooks.card.resume")}
                        </Button>
                    ) : (
                        <Button size="sm" variant={state === "never" || state === "failing" ? "default" : "outline"} onClick={onTest} disabled={testing}>
                            <Send size={15} /> {testing ? t("webhooks.card.testing") : t("webhooks.card.test")}
                        </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={onDeliveries}>
                        <History size={15} /> {t("webhooks.card.deliveries")}
                    </Button>
                </div>
            </div>
        </li>
    );
}
