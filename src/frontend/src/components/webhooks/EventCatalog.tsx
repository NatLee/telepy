"use client";

/**
 * 能送哪些事件：依分組列出，每個事件附「誰會收到」——個人 webhook 只收你在 Telepy 本來就會收到的通知。
 * What can be sent, by group, each event with who receives it: personal webhooks only carry notifications you
 * already get in Telepy.
 */
import React from "react";
import { ListChecks } from "lucide-react";
import { SectionHeading } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { AUDIENCE_KEY, EVENT_KEYS, GROUP_KEY, groupCatalog } from "@/lib/webhooks";
import type { CatalogEvent, WebhookScope } from "@/types/webhooks";

export function EventCatalog({ catalog, scope }: { catalog: CatalogEvent[]; scope: WebhookScope }) {
    const { t } = useI18n();
    return (
        <section className="rounded-xl border border-border bg-card p-4 shadow-card">
            <SectionHeading icon={<ListChecks />} title={t("webhooks.catalog.title")} description={scope === "site" ? t("webhooks.catalog.siteHint") : t("webhooks.catalog.hint")} />
            <div className="mt-4 space-y-4">
                {groupCatalog(catalog).map((g) => (
                    <div key={g.group}>
                        <p className="text-sm text-muted-foreground">{t(GROUP_KEY[g.group])}</p>
                        <ul className="mt-1.5 space-y-1.5">
                            {g.events.map((e) => (
                                <li key={e.event} className="text-sm leading-snug">
                                    <span className="text-foreground">{EVENT_KEYS[e.event] ? t(EVENT_KEYS[e.event].label) : e.event}</span>
                                    {scope === "user" && <span className="block text-xs text-muted-foreground">{t(AUDIENCE_KEY[e.audience])}</span>}
                                </li>
                            ))}
                        </ul>
                    </div>
                ))}
            </div>
        </section>
    );
}
