"use client";

/**
 * 「telepy 還是 ssh？」：兩條路徑畫在一起——ssh 只走 SSH 那條；telepy 走同一條 SSH，另外還跟 Telepy 的 API 講話，
 * 多出來的能力就是從那裡來的——下面是一張對照表：速查頁的每個任務兩邊各做不做得到，以及 telepy CLI 各主題有幾項
 * ssh 也做得到。主題那一列可以點，直接列出那個主題的範例。
 * "telepy or ssh?": both paths drawn together — ssh travels only the SSH one; telepy travels the same SSH path and
 * also talks to Telepy's API, which is where its extra abilities come from — then a comparison: each task on the sheet
 * under both tools, and per telepy CLI topic how many things ssh can do too. A topic row opens that topic's examples.
 */
import React from "react";
import { Check, HardDrive, Minus, Scale, Terminal } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { CLI_EXAMPLE_TOPICS, type CliTopicId } from "@/lib/cliExamples.gen";
import { wayCounts, type CatalogueEntry } from "@/lib/sheetCatalogue";
import { TOPIC_ICON } from "@/components/cheatsheet/TopicBoard";
import type { RecipeId } from "@/lib/forwardRecipes";
import type { TranslationKey } from "@/locales/en";

function Lane({ name, hint, link, telepySub }: { name: string; hint: string; link: string; telepySub: string }) {
    const { t } = useI18n();
    return (
        <section aria-label={name} className="space-y-2 rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <code className="font-mono text-sm text-foreground">{name}</code>
                <span className="text-xs text-muted-foreground">{hint}</span>
            </div>
            <FlowPath>
                <FlowNode icon={Terminal} title={t("sheet.ways.you")} sub={name} state="ok" />
                <FlowLink label={link} state="ok" />
                <FlowNode brand title="Telepy" sub={telepySub} state="ok" />
                <FlowLink label={t("sheet.ways.tunnel")} state="ok" />
                <FlowNode icon={HardDrive} title={t("sheet.ways.device")} sub={t("sheet.ways.deviceSub")} state="ok" />
            </FlowPath>
        </section>
    );
}

const Mark = ({ on, label }: { on: boolean; label: string }) =>
    on ? <Check size={16} className="mx-auto text-success" aria-label={label} /> : <Minus size={16} className="mx-auto text-muted-foreground/50" aria-label={label} />;

export function WaysDialog({ isOpen, onClose, entries, onTask, onTopic }: { isOpen: boolean; onClose: () => void; entries: CatalogueEntry[]; onTask: (id: RecipeId) => void; onTopic: (id: CliTopicId) => void }) {
    const { t } = useI18n();
    const n = wayCounts(entries);
    const tasks = entries.filter((e) => e.kind === "task");
    const topics = CLI_EXAMPLE_TOPICS.map((tp) => {
        const list = entries.filter((e) => e.kind === "example" && e.topic === tp.id);
        return { id: tp.id, total: list.length, ssh: list.filter((e) => e.ways.includes("ssh")).length };
    }).filter((tp) => tp.total > 0);
    const yes = t("sheet.ways.yes");
    const no = t("sheet.ways.no");
    const th = "px-3 py-2 text-left text-xs font-normal text-muted-foreground";
    const rowButton = "w-full rounded px-3 py-2 text-left text-sm text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
    return (
        <Modal isOpen={isOpen} onClose={onClose} size="4xl" icon={<Scale />} title={t("sheet.ways.title")} description={t("sheet.ways.description")}>
            <div className="space-y-4">
                <Lane name="ssh" hint={t("sheet.ways.sshHint")} link={t("sheet.ways.linkSsh")} telepySub={t("sheet.ways.gateway")} />
                <Lane name="telepy" hint={t("sheet.ways.telepyHint")} link={t("sheet.ways.linkBoth")} telepySub={t("sheet.ways.gatewayApi")} />
                <p className="text-sm text-muted-foreground">{t("sheet.ways.summary", { both: n.both, telepyOnly: n.telepyOnly })}</p>
                <div className="overflow-x-auto rounded-xl border border-border">
                    <table className="w-full border-collapse text-sm">
                        <thead>
                            <tr className="border-b border-border bg-muted/40">
                                <th scope="col" className={th}>{t("sheet.ways.tasks")}</th>
                                <th scope="col" className={`${th} w-20 text-center font-mono`}>telepy</th>
                                <th scope="col" className={`${th} w-20 text-center font-mono`}>ssh</th>
                            </tr>
                        </thead>
                        <tbody>
                            {tasks.map((e) => (
                                <tr key={e.id} className="border-b border-border/70">
                                    <th scope="row" className="p-0 font-normal">
                                        <button type="button" className={rowButton} onClick={() => onTask(e.recipe!)}>{t(e.title)}</button>
                                    </th>
                                    <td className="text-center"><Mark on label={yes} /></td>
                                    <td className="text-center"><Mark on={e.ways.includes("ssh")} label={e.ways.includes("ssh") ? yes : no} /></td>
                                </tr>
                            ))}
                        </tbody>
                        <thead>
                            <tr className="border-b border-border bg-muted/40">
                                <th scope="col" className={th}>{t("sheet.ways.more")}</th>
                                <th scope="col" className={`${th} text-center font-mono`}>telepy</th>
                                <th scope="col" className={`${th} text-center font-mono`}>ssh</th>
                            </tr>
                        </thead>
                        <tbody>
                            {topics.map((tp) => {
                                const Icon = TOPIC_ICON[tp.id];
                                return (
                                <tr key={tp.id} className="border-b border-border/70 last:border-0">
                                    <th scope="row" className="p-0 font-normal">
                                        <button type="button" className={`${rowButton} flex items-center gap-2`} onClick={() => onTopic(tp.id)}>
                                            <Icon size={15} className="shrink-0 text-muted-foreground" aria-hidden />
                                            <span className="min-w-0">{t(`cli.topic.${tp.id}` as TranslationKey)}</span>
                                        </button>
                                    </th>
                                    <td className="text-center font-mono text-xs text-foreground">{tp.total}</td>
                                    <td className="text-center font-mono text-xs text-muted-foreground">{tp.ssh > 0 ? tp.ssh : <Mark on={false} label={no} />}</td>
                                </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                <p className="text-xs text-muted-foreground">{t("sheet.ways.tableHint")}</p>
            </div>
        </Modal>
    );
}
