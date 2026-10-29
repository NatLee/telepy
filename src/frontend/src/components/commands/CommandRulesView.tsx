"use client";

/**
 * 指令規則的兩個頁面。`mine` = 指令規則頁：最上面是等你核准的指令；「規則」分頁有「我的規則」（自己寫的：管我是 owner /
 * Admin 的隧道上的人，或只管我自己；所有隧道或勾選的幾條）與唯讀的「全站規則」（管理員多一個「管理」），選一條隧道
 * （`?tunnel=`）就改看那裡生效的規則（別人寫的也列出是誰）；「紀錄」分頁列出被擋下與送核准的指令。`site` = 管理區的全站
 * 指令規則頁：管理員新增 / 修改全站規則（所有隧道或勾選的幾條）。兩邊旁邊都有「試一個指令」與「指令是怎麼決定的」。
 * The two command rules pages. `mine` = Command rules: commands waiting for your approval on top; the Rules tab has
 * "My rules" (your own: for people on tunnels you own or administer, or just yourself; every tunnel or picked ones)
 * and the read-only site-wide rules (admins get "Manage"); picking a tunnel (`?tunnel=`) shows the rules in force
 * there (other people's say who wrote them); the History tab lists blocked and held commands. `site` = the admin
 * section's Site command rules: admins add and change site-wide rules (every tunnel or picked ones). Both have the
 * command tester and the "how a command is decided" diagram beside them.
 */
import React, { useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Info, Plus, ShieldCheck } from "lucide-react";
import { AdminChip } from "@/components/layout/AdminViews";
import { PageHeader } from "@/components/layout/PageHeader";
import { ApprovalCard, useCommandApprovals } from "@/components/commands/CommandApprovals";
import { CommandHistory } from "@/components/commands/CommandHistory";
import { CommandTester } from "@/components/commands/CommandTester";
import { DecisionFlowDialog } from "@/components/commands/DecisionFlowDialog";
import { RuleDialog } from "@/components/commands/RuleDialog";
import { OffDialog } from "@/components/commands/OffDialog";
import { RuleLayersDialog } from "@/components/commands/RuleLayers";
import { RuleList, type RuleOverrides } from "@/components/commands/RuleList";
import { Button } from "@/components/ui/button";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { NativeSelect } from "@/components/ui/native-select";
import { SectionHeading } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { useCommandRulesPage, type RulesView } from "@/hooks/useCommandRulesPage";
import { flipOffHere, verdictToDraw } from "@/lib/commandRules";
import { useI18n } from "@/lib/i18n";
import type { CheckResult, CommandRule } from "@/types/commandRules";

/** 還沒有規則：一句話、說明、新增按鈕。/ No rules yet: a line, a hint and the add button. */
function Empty({ title, hint, onAdd, addLabel }: { title: string; hint: string; onAdd?: () => void; addLabel: string }) {
    return (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-10 text-center">
            <span className="mb-3 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
                <ShieldCheck size={20} />
            </span>
            <p className="text-sm text-foreground">{title}</p>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">{hint}</p>
            {onAdd && (
                <Button size="sm" className="mt-4" onClick={onAdd}>
                    <Plus /> {addLabel}
                </Button>
            )}
        </div>
    );
}

export function CommandRulesView({ view }: { view: RulesView }) {
    const { t } = useI18n();
    const page = useCommandRulesPage(view);
    // 重新整理後畫面上的列依序淡入。/ After Refresh, the rows on screen fade back in.
    const pageRef = useRef<HTMLDivElement>(null);
    const { pending, decide } = useCommandApprovals();
    const [editing, setEditing] = useState<CommandRule | "new" | null>(null);
    const [deleting, setDeleting] = useState<CommandRule | null>(null);
    // 覆寫：「在我的隧道上關掉」與「誰說了算？」。/ Overrides: "turn off on my tunnels" and "Who decides?".
    const [offing, setOffing] = useState<CommandRule | null>(null);
    const [why, setWhy] = useState<CommandRule | null>(null);
    // 「指令是怎麼決定的」：上一個試跑結果點亮路徑圖。/ "How a command is decided": the last test lights the path.
    const [flowOpen, setFlowOpen] = useState(false);
    const [tested, setTested] = useState<{ command: string; result: CheckResult | null }>({ command: "", result: null });
    const site = view === "site";
    const atLimit = !site && page.used >= page.limit;
    const canAdd = page.loaded && (site ? page.canEditSite : !atLimit);
    const add = canAdd ? () => setEditing("new") : undefined;
    const addLabel = site ? t("commands.admin.add") : t("commands.addRule");
    // 這一頁看的範圍內、等我決定的。/ Requests waiting for me within the scope on screen.
    const waiting = site ? [] : pending.filter((r) => !page.tunnelId || r.tunnel_id === page.tunnelId);
    const testerHint = site ? t("commands.tester.hintSite") : page.tunnelId ? t("commands.tester.hintTunnel") : t("commands.tester.hintMine");

    // 個人頁才有覆寫（全站頁是管理員改規則本身）。/ Overrides live on the personal page (the site page edits the rules).
    const overrides: RuleOverrides = {
        tunnelId: page.tunnelId,
        managed: page.managed,
        onWhy: setWhy,
        onOffMine: setOffing,
        onOffHere: (r, off) => {
            if (page.tunnelId === null) return;
            void page.setOff(r, flipOffHere(r.my_override?.off ?? null, page.tunnelId, page.managed, off));
        },
        onMute: (r, muted) => void page.setMute(r, muted),
        controls: true,
    };
    const whyOnly: RuleOverrides = { ...overrides, managed: [], controls: false };

    const manageSite = !site && page.canEditSite && (
        <Button asChild size="sm" variant="outline">
            <Link href={page.tunnelId ? `/tunnels/admin/commands?tunnel=${page.tunnelId}` : "/tunnels/admin/commands"}>
                {t("commands.siteManage")} <ArrowRight />
            </Link>
        </Button>
    );

    const siteSection = (
        <section>
            <SectionHeading
                title={page.tunnelId && !site ? t("commands.siteOnTunnelTitle", { name: page.scopeName ?? "", count: page.siteRules?.length ?? 0 }) : t("commands.siteRulesTitle")}
                description={site ? undefined : t("commands.siteRulesHint")}
                action={manageSite || undefined}
            />
            {page.siteRules === null ? null : page.siteRules.length === 0 ? (
                site ? (
                    <Empty title={t("commands.admin.empty")} hint={t("commands.admin.emptyHint")} onAdd={add} addLabel={addLabel} />
                ) : (
                    <p className="rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">{t("commands.siteNone")}</p>
                )
            ) : (
                <RuleList
                    rules={page.siteRules}
                    canEdit={site && page.canEditSite}
                    onEdit={(r) => setEditing(r)}
                    onToggle={(r) => void page.toggleRule(r)}
                    onDelete={setDeleting}
                    overrides={site ? whyOnly : overrides}
                />
            )}
        </section>
    );

    const personalSection = !site && (
        <section>
            <SectionHeading
                title={page.tunnelId ? t("commands.tunnelRulesTitle", { name: page.scopeName ?? "" }) : t("commands.mineTitle")}
                description={page.tunnelId ? t("commands.tunnelRulesHint") : t("commands.mineHint")}
            />
            {page.personalRules === null ? null : page.personalRules.length === 0 ? (
                page.tunnelId ? (
                    <Empty title={t("commands.emptyTunnel")} hint={t("commands.emptyTunnelHint")} onAdd={add} addLabel={addLabel} />
                ) : (
                    <Empty title={t("commands.empty")} hint={t("commands.emptyHint")} onAdd={add} addLabel={addLabel} />
                )
            ) : (
                <RuleList rules={page.personalRules} canEdit={(r) => r.mine} showOwner onEdit={(r) => setEditing(r)} onToggle={(r) => void page.toggleRule(r)} onDelete={setDeleting} overrides={overrides} />
            )}
            {page.loaded && page.used > 0 && !page.tunnelId && <p className="mt-2 text-xs text-muted-foreground">{t("commands.mineUsage", { used: page.used, max: page.limit })}</p>}
        </section>
    );

    return (
        <div ref={pageRef} className="flex flex-col animate-fade-in-up">
            <PageHeader
                className="mb-6"
                icon={<ShieldCheck />}
                title={site ? t("commands.admin.title") : t("commands.title")}
                titleAddon={site ? <AdminChip /> : undefined}
                description={site ? t("commands.admin.subtitle") : t("commands.subtitle")}
                actions={
                    <>
                        <Button onClick={() => setFlowOpen(true)} variant="outline">
                            <Info size={16} />
                            {t("commands.flow.button")}
                        </Button>
                        <RefreshButton onRefresh={page.reload} ripple={pageRef} label={t("common.refresh")} />
                        {page.tab === "rules" && (
                            <Button onClick={() => setEditing("new")} disabled={!canAdd}>
                                <Plus size={16} /> {addLabel}
                            </Button>
                        )}
                    </>
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
                {!site && (
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
                )}
                <NativeSelect
                    value={page.tunnelId ?? ""}
                    onChange={(e) => page.go({ tunnel: e.target.value ? Number(e.target.value) : null })}
                    className="h-9 w-60 max-w-full"
                    aria-label={t("commands.scopeLabel")}
                >
                    <option value="">{t("commands.allTunnels")}</option>
                    {page.tunnels.map((x) => (
                        <option key={x.id} value={x.id}>
                            {x.name}
                        </option>
                    ))}
                </NativeSelect>
                {site && (
                    <Link href="/tunnels/settings?tab=commands" className="ml-auto text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                        {t("commands.admin.settingsLink")}
                    </Link>
                )}
            </div>

            {page.failed && <Callout tone="warning" className="mb-4">{t("commands.loadFailed")}</Callout>}

            {page.tab === "rules" ? (
                <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
                    <div className="min-w-0 space-y-6">
                        {personalSection}
                        {siteSection}
                    </div>
                    <aside className="min-w-0 space-y-4">
                        <CommandTester check={page.check} hint={testerHint} markYou={!site} onResult={(command, result) => setTested({ command, result })} />
                        <button type="button" onClick={() => setFlowOpen(true)} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                            <Info size={14} aria-hidden /> {t("commands.flow.button")}
                        </button>
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

            <RuleDialog
                isOpen={editing !== null}
                onClose={() => setEditing(null)}
                rule={editing === "new" ? null : editing}
                scope={site ? "site" : "personal"}
                startTunnel={page.tunnelId}
                tunnels={page.formTunnels}
                approverCandidates={page.approverCandidates}
                approvalTimeoutMax={page.approvalTimeoutMax}
                onSave={page.saveRule}
                check={page.check}
            />
            <DecisionFlowDialog
                isOpen={flowOpen}
                onClose={() => setFlowOpen(false)}
                command={tested.command}
                verdict={tested.result ? verdictToDraw(tested.result) : null}
                who={tested.result?.you_approve ? "approvers" : "sharees"}
                personalCounts={!site}
            />
            <OffDialog rule={offing} onClose={() => setOffing(null)} tunnels={page.tunnels.filter((x) => page.managed.includes(x.id))} onSave={page.setOff} />
            <RuleLayersDialog rule={why} onClose={() => setWhy(null)} tunnelId={page.tunnelId} tunnelName={page.scopeName} managesSome={page.managed.length > 0} />
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
