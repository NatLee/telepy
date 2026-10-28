"use client";

/**
 * 個人 Webhooks 頁上的「全站 webhook」區塊：管理員設的全站 webhook 有哪些、送哪些事件、報到我的哪些隧道。唯讀；
 * 管理員多一個「管理」連到管理區。
 * The "Site-wide webhooks" section on the personal Webhooks page: which site-wide webhooks the admins set up, what
 * they send and which of my tunnels they report on. Read-only; admins get a "Manage" link to the admin section.
 */
import React, { useState } from "react";
import Link from "next/link";
import { Info, Lock, Settings2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Section } from "@/components/ui/section";
import { EnforcedChip, ServiceTile, useEventLabel } from "@/components/webhooks/parts";
import { OptOutDialog, OptOutInfoDialog, siteHookName } from "@/components/webhooks/OptOut";
import { useI18n } from "@/lib/i18n";
import { FORMAT_SHORT, hookMode, knownEventOrder, optOutChoices, siteCoverage, siteHookState, sortSiteSummary } from "@/lib/webhooks";
import type { SiteWebhookSummary } from "@/types/webhooks";

/** 每列最多列幾個事件，其餘「+N」。/ Events shown per row before "+N more". */
const EVENTS_SHOWN = 5;

export function SiteWebhooksSection({ hooks, canManage, onOptOut }: { hooks: SiteWebhookSummary[]; canManage: boolean; onOptOut: (hookId: number, tunnelIds: number[]) => Promise<boolean> }) {
    const { t } = useI18n();
    const eventLabel = useEventLabel();
    const [optingOut, setOptingOut] = useState<SiteWebhookSummary | null>(null);
    const [info, setInfo] = useState(false);

    const coverageText = (h: SiteWebhookSummary) => {
        const c = siteCoverage(h);
        if (c.kind === "all") return t("webhooks.siteSection.allTunnels");
        const hidden = c.hidden > 0 ? ` ${t("webhooks.siteSection.hiddenMore", { n: c.hidden })}` : "";
        if (c.kind === "none") return t("webhooks.siteSection.noneOfYours") + hidden;
        return t(canManage ? "webhooks.siteSection.someTunnels" : "webhooks.siteSection.yourTunnels", { names: c.names.join(", ") }) + hidden;
    };

    return (
        <Section
            as="h2"
            className="pt-4"
            title={t("webhooks.siteSection.title")}
            description={t("webhooks.siteSection.description")}
            action={
                <div className="flex flex-wrap justify-end gap-2">
                    {hooks.length > 0 && (
                        // 手機上只留圖示，說明文字才有空間。/ Icon only on phones, so the description keeps its width.
                        <Button variant="ghost" size="sm" onClick={() => setInfo(true)} aria-label={t("webhooks.optout.info")} title={t("webhooks.optout.info")}>
                            <Info size={14} />
                            <span className="hidden sm:inline">{t("webhooks.optout.info")}</span>
                        </Button>
                    )}
                    {canManage && (
                        <Button asChild variant="outline" size="sm">
                            <Link href="/tunnels/admin/webhooks">
                                <Settings2 size={14} />
                                {t("webhooks.siteSection.manage")}
                            </Link>
                        </Button>
                    )}
                </div>
            }
        >
            {hooks.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("webhooks.siteSection.empty")}</p>
            ) : (
                <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                    {sortSiteSummary(hooks).map((h) => {
                        const state = siteHookState(h);
                        const events = knownEventOrder(h.events);
                        const enforced = hookMode(h) === "enforced";
                        const choices = optOutChoices(h);
                        const mineCount = (h.managed ?? []).length;
                        const outCount = choices.filter((c) => c.opted_out).length;
                        return (
                            <li key={h.id} className="flex min-w-0 gap-3 px-4 py-3">
                                <ServiceTile format={h.service ?? "json"} className="hidden size-9 sm:grid" />
                                <div className="min-w-0 flex-1 space-y-1.5">
                                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                        <span className="min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">{siteHookName(h)}</span>
                                        {/* 沒名字時名字就是服務名稱，不再重複一個籤。/ Unnamed = the service is the name; no second chip. */}
                                        {h.service && h.name && <Chip>{FORMAT_SHORT[h.service]}</Chip>}
                                        {state === "paused" && <Chip tone="warning">{t("webhooks.siteSection.paused")}</Chip>}
                                        {state === "off" && <Chip>{t("webhooks.siteSection.off")}</Chip>}
                                        {enforced && <EnforcedChip />}
                                    </div>
                                    {events.length > 0 && (
                                        <div className="flex flex-wrap gap-1">
                                            {events.slice(0, EVENTS_SHOWN).map((e) => (
                                                <Chip key={e} className="whitespace-normal">
                                                    {eventLabel(e)}
                                                </Chip>
                                            ))}
                                            {events.length > EVENTS_SHOWN && (
                                                <Chip title={events.slice(EVENTS_SHOWN).map(eventLabel).join(", ")}>{t("webhooks.card.moreEvents", { n: events.length - EVENTS_SHOWN })}</Chip>
                                            )}
                                        </div>
                                    )}
                                    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{coverageText(h)}</p>
                                    {/* 只在我能做什麼的地方說：我管、它涵蓋的隧道。/ Only where I can act: tunnels I manage that it covers. */}
                                    {enforced && mineCount > 0 && (
                                        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                                            <Lock size={12} className="mt-0.5 shrink-0" aria-hidden />
                                            {t("webhooks.optout.enforcedNote")}
                                        </p>
                                    )}
                                    {choices.length > 0 && (
                                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-0.5">
                                            <span className="text-xs text-muted-foreground">
                                                {outCount > 0 ? t("webhooks.optout.status", { n: outCount, total: choices.length }) : t("webhooks.optout.allowed")}
                                            </span>
                                            <Button size="sm" variant="outline" onClick={() => setOptingOut(h)}>
                                                <Undo2 size={14} />
                                                {t("webhooks.optout.button")}
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
            <OptOutDialog hook={optingOut} onClose={() => setOptingOut(null)} onSave={onOptOut} />
            {info && <OptOutInfoDialog isOpen onClose={() => setInfo(false)} hooks={sortSiteSummary(hooks)} />}
        </Section>
    );
}
