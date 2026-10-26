"use client";

/**
 * 能送哪些事件：依分組列成小標籤（一組一兩行就好，不會比 webhook 清單還長）；點一個事件，就在那一組下面
 * 展開它的說明、誰會收到（個人 webhook 只收你在 Telepy 本來就會收到的通知）與事件名稱。
 * What can be sent: compact chips per group (a line or two each, so the panel never outgrows the webhook list).
 * Clicking an event opens its explanation, who receives it and its event name under its group.
 */
import React, { useState } from "react";
import { ListChecks, UserRound } from "lucide-react";
import { SectionHeading } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { AUDIENCE_KEY, EVENT_KEYS, GROUP_KEY, groupCatalog } from "@/lib/webhooks";
import type { CatalogEvent, WebhookScope } from "@/types/webhooks";

export function EventCatalog({ catalog, scope }: { catalog: CatalogEvent[]; scope: WebhookScope }) {
    const { t } = useI18n();
    const [open, setOpen] = useState<string | null>(null);
    const label = (e: CatalogEvent) => (EVENT_KEYS[e.event] ? t(EVENT_KEYS[e.event].label) : e.event);
    return (
        <section className="rounded-xl border border-border bg-card p-4 shadow-card">
            <SectionHeading icon={<ListChecks />} title={t("webhooks.catalog.title")} description={scope === "site" ? t("webhooks.catalog.siteHint") : t("webhooks.catalog.hint")} />
            <div className="mt-3 space-y-3">
                {groupCatalog(catalog).map((g) => {
                    const selected = g.events.find((e) => e.event === open);
                    const detailId = `webhook-event-${g.group}`;
                    return (
                        <div key={g.group}>
                            <p className="text-xs text-muted-foreground">{t(GROUP_KEY[g.group])}</p>
                            <div className="mt-1 flex flex-wrap gap-1">
                                {g.events.map((e) => {
                                    const active = open === e.event;
                                    return (
                                        <button
                                            key={e.event}
                                            type="button"
                                            aria-expanded={active}
                                            aria-controls={detailId}
                                            onClick={() => setOpen(active ? null : e.event)}
                                            className={cn(
                                                "rounded-sm border px-1.5 py-0.5 text-left text-xs leading-5 transition-colors",
                                                active ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-surface text-foreground hover:border-foreground/30 hover:bg-muted",
                                            )}
                                        >
                                            {label(e)}
                                        </button>
                                    );
                                })}
                            </div>
                            {selected && (
                                <div id={detailId} className="mt-1.5 space-y-1 rounded-md border border-border bg-surface px-2.5 py-2 text-xs leading-relaxed">
                                    {EVENT_KEYS[selected.event] && <p className="text-foreground">{t(EVENT_KEYS[selected.event].hint)}</p>}
                                    {scope === "user" && (
                                        <p className="flex items-start gap-1 text-muted-foreground">
                                            <UserRound size={12} className="mt-0.5 shrink-0" aria-hidden />
                                            {t(AUDIENCE_KEY[selected.audience])}
                                        </p>
                                    )}
                                    <p className="font-mono text-muted-foreground">{selected.event}</p>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
