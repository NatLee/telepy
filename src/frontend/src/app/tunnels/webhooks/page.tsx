"use client";

/**
 * Webhooks 頁（`/tunnels/webhooks`）：每個人把自己會收到的 Telepy 通知送到 Slack、Discord、Teams、手機（ntfy）或自己的服務；
 * 管理員另有「全站」分頁（`?scope=site`），放整個站都該知道的重要事件。旁邊列出能送哪些事件、誰會收到、怎麼送。
 * The Webhooks page: everyone sends the Telepy notifications they get to Slack, Discord, Teams, their phone (ntfy)
 * or their own service; admins also get a Site-wide tab (`?scope=site`) for the events the whole site should
 * know about. The side panel lists what can be sent, who receives it and how delivery works.
 */
import React, { Suspense, useState } from "react";
import Link from "next/link";
import { Plus, RefreshCw, Webhook as WebhookIcon } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Segmented } from "@/components/ui/segmented";
import { DeliveriesDialog } from "@/components/webhooks/DeliveriesDialog";
import { EventCatalog } from "@/components/webhooks/EventCatalog";
import { SecretDialog } from "@/components/webhooks/SecretDialog";
import { WebhookCard } from "@/components/webhooks/WebhookCard";
import { WebhookDialog } from "@/components/webhooks/WebhookDialog";
import { useWebhooksPage } from "@/hooks/useWebhooksPage";
import { useI18n } from "@/lib/i18n";
import { languageFor } from "@/lib/webhooks";
import type { Webhook } from "@/types/webhooks";

const SERVICES = ["Slack", "Discord", "Google Chat", "Microsoft Teams", "Telegram", "ntfy", "Mattermost"];

function WebhooksInner() {
    const { t, locale } = useI18n();
    const page = useWebhooksPage();
    const [editing, setEditing] = useState<Webhook | "new" | null>(null);
    const [deleting, setDeleting] = useState<Webhook | null>(null);
    const [history, setHistory] = useState<Webhook | null>(null);
    const [secretOf, setSecretOf] = useState<Webhook | null>(null);
    const [testing, setTesting] = useState<number | null>(null);
    const policy = page.data?.policy;
    const site = page.scope === "site";
    const personalOff = !site && policy && !policy.personal_enabled;
    const atLimit = !site && policy ? policy.used >= policy.max : false;
    const canAdd = Boolean(page.data) && (site || (!personalOff && !atLimit));

    const test = async (h: Webhook) => {
        setTesting(h.id);
        await page.sendTest(h);
        setTesting(null);
    };

    const addButton = (
        <Button onClick={() => setEditing("new")} disabled={!canAdd} title={atLimit ? t("webhooks.limitReached", { max: policy?.max ?? 0 }) : undefined}>
            <Plus size={16} /> {site ? t("webhooks.addSite") : t("webhooks.add")}
        </Button>
    );

    return (
        <div className="flex flex-col animate-fade-in-up">
            <PageHeader
                className="mb-6"
                icon={<WebhookIcon />}
                title={t("webhooks.title")}
                description={t("webhooks.subtitle")}
                actions={
                    <>
                        <Button variant="outline" onClick={() => void page.reload()}>
                            <RefreshCw size={16} />
                            {t("common.refresh")}
                        </Button>
                        {addButton}
                    </>
                }
            />

            {page.data?.can_manage_site && (
                <Segmented
                    kind="tabs"
                    fullWidth
                    className="mb-4 sm:inline-grid sm:self-start"
                    value={page.scope}
                    onChange={page.setScope}
                    options={[
                        { value: "user", label: t("webhooks.tabMine", { n: page.data.mine.length }) },
                        { value: "site", label: t("webhooks.tabSite", { n: page.data.site?.length ?? 0 }) },
                    ]}
                    aria-label={t("webhooks.title")}
                />
            )}

            {page.failed && <Callout tone="warning" className="mb-4">{t("webhooks.loadFailed")}</Callout>}
            {personalOff && <Callout tone="warning" className="mb-4" title={t("webhooks.personalOffTitle")}>{t("webhooks.personalOff")}</Callout>}
            {site && (
                <Callout tone="info" className="mb-4">
                    {t("webhooks.siteIntro")}{" "}
                    <Link href="/tunnels/settings?tab=notify" className="text-foreground underline underline-offset-2">
                        {t("webhooks.siteSettingsLink")}
                    </Link>
                </Callout>
            )}

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
                <div className="min-w-0 space-y-3">
                    {page.data && page.list.length === 0 ? (
                        <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-12 text-center">
                            <span className="mb-3 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
                                <WebhookIcon size={20} />
                            </span>
                            <p className="text-base text-foreground">{site ? t("webhooks.emptySite") : t("webhooks.empty")}</p>
                            <p className="mt-1 max-w-md text-sm text-muted-foreground">{site ? t("webhooks.emptySiteHint") : t("webhooks.emptyHint")}</p>
                            <p className="mt-3 flex max-w-md flex-wrap justify-center gap-1.5">
                                {SERVICES.map((s) => (
                                    <span key={s} className="rounded-sm bg-muted px-1.5 py-px text-xs text-muted-foreground">
                                        {s}
                                    </span>
                                ))}
                            </p>
                            {canAdd && <div className="mt-5">{addButton}</div>}
                        </div>
                    ) : (
                        <ul className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
                            {page.list.map((h) => (
                                <WebhookCard
                                    key={h.id}
                                    hook={h}
                                    catalog={page.catalog}
                                    pauseAfter={policy?.pause_after ?? 20}
                                    testing={testing === h.id}
                                    onToggle={(on) => void page.setEnabled(h, on)}
                                    onTest={() => void test(h)}
                                    onEdit={() => setEditing(h)}
                                    onDeliveries={() => setHistory(h)}
                                    onSecret={() => setSecretOf(h)}
                                    onDelete={() => setDeleting(h)}
                                />
                            ))}
                        </ul>
                    )}
                    {!site && policy && page.list.length > 0 && (
                        <p className="text-xs text-muted-foreground">{atLimit ? t("webhooks.limitReached", { max: policy.max }) : t("webhooks.usage", { used: policy.used, max: policy.max })}</p>
                    )}
                </div>
                <aside className="min-w-0 space-y-4">
                    {page.catalog.length > 0 && <EventCatalog catalog={page.catalog} scope={page.scope} />}
                    <Callout tone="info" title={t("webhooks.howTitle")}>
                        <ul className="list-disc space-y-1 pl-4">
                            <li>{t("webhooks.how1")}</li>
                            <li>{t("webhooks.how2", { n: policy?.pause_after ?? 20 })}</li>
                            <li>{t("webhooks.how3", { n: policy?.per_minute ?? 30 })}</li>
                            <li>{t("webhooks.how4")}</li>
                        </ul>
                    </Callout>
                </aside>
            </div>

            <WebhookDialog
                isOpen={editing !== null}
                onClose={() => setEditing(null)}
                hook={editing === "new" ? null : editing}
                scope={editing && editing !== "new" ? editing.scope : page.scope}
                catalog={(editing && editing !== "new" && editing.scope === "site" ? page.data?.catalog.site : editing && editing !== "new" ? page.data?.catalog.personal : page.catalog) ?? []}
                tunnels={(editing && editing !== "new" ? editing.scope : page.scope) === "site" ? page.siteTunnels : page.tunnels}
                language={languageFor(locale)}
                privateTargets={Boolean(policy?.private_targets)}
                onSave={page.save}
            />
            <DeliveriesDialog hook={history} onClose={() => setHistory(null)} load={page.deliveries} onTest={page.sendTest} onRedeliver={page.redeliver} />
            <SecretDialog hook={secretOf} onClose={() => setSecretOf(null)} load={page.secret} />
            <ConfirmDialog
                isOpen={deleting !== null}
                onClose={() => setDeleting(null)}
                onConfirm={() => {
                    if (deleting) void page.remove(deleting);
                    setDeleting(null);
                }}
                title={t("webhooks.deleteTitle")}
                message={t("webhooks.deleteMessage", { name: deleting?.name ?? "" })}
                confirmText={t("common.delete")}
                isDestructive
            />
        </div>
    );
}

export default function WebhooksPage() {
    return (
        <Suspense fallback={null}>
            <WebhooksInner />
        </Suspense>
    );
}
