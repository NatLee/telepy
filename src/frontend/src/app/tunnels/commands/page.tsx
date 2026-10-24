"use client";

/**
 * 指令規則頁：最上面是等你核准的指令；「規則」分頁管全站（管理員）或一條隧道（owner / ADMIN）的規則，附「試一個指令」；
 * 「紀錄」分頁列出被擋下與送核准的指令。`?tunnel=<id>` 選隧道、`?tab=history` 開紀錄。
 * The command rules page: commands waiting for your approval on top; the Rules tab edits the site-wide (admins) or a
 * tunnel's (owner / ADMIN) rules, with a command tester; the History tab lists blocked and held commands.
 * `?tunnel=<id>` picks a tunnel, `?tab=history` opens the history.
 */
import React, { Suspense, useState } from "react";
import { Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { ApprovalCard, useCommandApprovals } from "@/components/commands/CommandApprovals";
import { CommandHistory } from "@/components/commands/CommandHistory";
import { CommandTester } from "@/components/commands/CommandTester";
import { RuleDialog } from "@/components/commands/RuleDialog";
import { RuleList } from "@/components/commands/RuleList";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { NativeSelect } from "@/components/ui/native-select";
import { SectionHeading } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { useCommandRulesPage } from "@/hooks/useCommandRulesPage";
import { useI18n } from "@/lib/i18n";
import type { CommandRule } from "@/types/commandRules";

function CommandsInner() {
    const { t } = useI18n();
    const page = useCommandRulesPage();
    const { pending, decide } = useCommandApprovals();
    const [editing, setEditing] = useState<CommandRule | "new" | null>(null);
    const [deleting, setDeleting] = useState<CommandRule | null>(null);
    const scopeLabel = page.scopeName ? t("commands.scopeTunnel", { name: page.scopeName }) : t("commands.scopeSite");
    // 這一頁看的範圍內、等我決定的。/ Requests waiting for me within the scope on screen.
    const waiting = pending.filter((r) => !page.tunnelId || r.tunnel_id === page.tunnelId);

    return (
        <div className="flex flex-col animate-fade-in-up">
            <PageHeader
                className="mb-6"
                icon={<ShieldCheck />}
                title={t("commands.title")}
                description={t("commands.subtitle")}
                actions={
                    <Button onClick={() => void page.reload()} variant="outline">
                        <RefreshCw size={16} />
                        {t("common.refresh")}
                    </Button>
                }
            />

            {waiting.length > 0 && (
                <section className="mb-6">
                    <SectionHeading title={t("commands.waitingTitle", { count: waiting.length })} description={t("commands.waitingHint")} />
                    <div className="grid gap-3 lg:grid-cols-2">
                        {waiting.map((r) => (
                            <ApprovalCard key={r.id} req={r} onDecide={decide} className="shadow-none" />
                        ))}
                    </div>
                </section>
            )}

            <div className="mb-4 flex flex-wrap items-center gap-2">
                <Segmented
                    kind="tabs"
                    value={page.tab}
                    onChange={(tab) => page.go({ tab })}
                    options={[
                        { value: "rules", label: t("commands.tabRules") },
                        { value: "history", label: t("commands.tabHistory") },
                    ]}
                    aria-label={t("commands.title")}
                />
                <NativeSelect
                    value={page.tunnelId ?? ""}
                    onChange={(e) => page.go({ tunnel: e.target.value ? Number(e.target.value) : null })}
                    className="h-9 w-60"
                    aria-label={t("commands.scopeLabel")}
                >
                    <option value="">{page.tab === "rules" ? t("commands.scopeSiteOption") : t("commands.allTunnels")}</option>
                    {page.tunnels.map((x) => (
                        <option key={x.id} value={x.id}>
                            {x.name}
                        </option>
                    ))}
                </NativeSelect>
                {page.tab === "rules" && page.canEdit && (
                    <Button className="ml-auto" onClick={() => setEditing("new")}>
                        <Plus size={16} /> {t("commands.addRule")}
                    </Button>
                )}
            </div>

            {page.failed && <Callout tone="warning" className="mb-4">{t("commands.loadFailed")}</Callout>}

            {page.tab === "rules" ? (
                <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
                    <div className="min-w-0 space-y-6">
                        <section>
                            <SectionHeading
                                title={page.tunnelId ? t("commands.tunnelRulesTitle", { name: page.scopeName ?? "" }) : t("commands.siteRulesTitle")}
                                description={page.tunnelId ? t("commands.tunnelRulesHint") : t("commands.siteRulesHint")}
                            />
                            {page.rules !== null && page.rules.length === 0 ? (
                                <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-10 text-center">
                                    <span className="mb-3 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
                                        <ShieldCheck size={20} />
                                    </span>
                                    <p className="text-sm text-foreground">{t("commands.empty")}</p>
                                    <p className="mt-1 max-w-md text-xs text-muted-foreground">{page.canEdit ? t("commands.emptyHint") : t(page.tunnelId ? "commands.emptyHintTunnelReadOnly" : "commands.emptyHintSiteReadOnly")}</p>
                                    {page.canEdit && (
                                        <Button size="sm" className="mt-4" onClick={() => setEditing("new")}>
                                            <Plus /> {t("commands.addRule")}
                                        </Button>
                                    )}
                                </div>
                            ) : (
                                <RuleList rules={page.rules ?? []} canEdit={page.canEdit} onEdit={(r) => setEditing(r)} onToggle={(r) => void page.toggleRule(r)} onDelete={setDeleting} />
                            )}
                        </section>
                        {page.tunnelId !== null && page.siteRules.length > 0 && (
                            <section>
                                <SectionHeading title={t("commands.alsoSiteTitle", { count: page.siteRules.length })} description={t("commands.alsoSiteHint")} />
                                <RuleList rules={page.siteRules} canEdit={false} />
                            </section>
                        )}
                    </div>
                    <aside className="min-w-0 space-y-4">
                        <CommandTester check={page.check} scopeIsTunnel={page.tunnelId !== null} />
                        <Callout tone="info" title={t("commands.howTitle")}>
                            <ul className="list-disc space-y-1 pl-4">
                                <li>{t("commands.how1")}</li>
                                <li>{t("commands.how2")}</li>
                                <li>{t("commands.how3")}</li>
                            </ul>
                        </Callout>
                        <Callout tone="warning" title={t("commands.limitsTitle")}>
                            {t("commands.limits")}
                        </Callout>
                    </aside>
                </div>
            ) : (
                <CommandHistory list={page.history} onWithdraw={page.withdraw} />
            )}

            <RuleDialog isOpen={editing !== null} onClose={() => setEditing(null)} rule={editing === "new" ? null : editing} scopeLabel={scopeLabel} onSave={page.saveRule} check={page.check} />
            <ConfirmDialog
                isOpen={deleting !== null}
                onClose={() => setDeleting(null)}
                onConfirm={() => {
                    if (deleting) void page.deleteRule(deleting);
                    setDeleting(null);
                }}
                title={t("commands.deleteTitle")}
                message={t("commands.deleteMessage", { pattern: deleting?.pattern ?? "" })}
                confirmText={t("common.delete")}
                isDestructive
            />
        </div>
    );
}

export default function CommandsPage() {
    return (
        <Suspense fallback={null}>
            <CommandsInner />
        </Suspense>
    );
}
