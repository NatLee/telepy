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
import { Check, Files, HardDrive, Minus, Network, Play, Scale, Terminal } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { NavTabs } from "@/components/ui/nav-tabs";
import { ToolOverlap } from "@/components/cheatsheet/ToolOverlap";
import { FAMILIES, family, type FamilyId } from "@/lib/toolOverlap";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { CLI_EXAMPLE_TOPICS, type CliTopicId } from "@/lib/cliExamples.gen";
import { wayCounts, type CatalogueEntry } from "@/lib/sheetCatalogue";
import { TOPIC_ICON } from "@/components/cheatsheet/TopicBoard";
import type { RecipeId } from "@/lib/forwardRecipes";
import type { TranslationKey } from "@/locales/en";

/**
 * 一條路一列：矮的節點、不畫狀態行（這是說明，不是現況）。兩條路疊在一起才兩列高，底下的對照表不用捲就看得到。
 * One lane, one row: short nodes and no status line (this explains, it isn't live). Two lanes are two rows tall, so
 * the comparison below shows without scrolling.
 */
function Lane({ name, hint, link, telepySub }: { name: string; hint: string; link: string; telepySub: string }) {
    const { t } = useI18n();
    return (
        <section aria-label={name} className="space-y-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <code className="font-mono text-sm text-foreground">{name}</code>
                <span className="text-xs text-muted-foreground">{hint}</span>
            </div>
            <FlowPath>
                <FlowNode icon={Terminal} title={t("sheet.ways.you")} sub={name} compact plain />
                <FlowLink label={link} state="ok" compact />
                <FlowNode brand title="Telepy" sub={telepySub} compact plain />
                <FlowLink label={t("sheet.ways.tunnel")} state="ok" compact />
                <FlowNode icon={HardDrive} title={t("sheet.ways.device")} sub={t("sheet.ways.deviceSub")} compact plain />
            </FlowPath>
        </section>
    );
}

const Mark = ({ on, label }: { on: boolean; label: string }) =>
    on ? <Check size={16} className="mx-auto text-success" aria-label={label} /> : <Minus size={16} className="mx-auto text-muted-foreground/50" aria-label={label} />;

/** 對話框的分頁：telepy 或 ssh，以及功能重疊的三組工具。/ The dialog's tabs: telepy or ssh, then the three families of overlapping tools. */
export type WaysTab = "ways" | FamilyId;
const FAMILY_ICON: Record<FamilyId, React.ReactNode> = { reach: <Network />, files: <Files />, run: <Play /> };

export function WaysDialog({ isOpen, onClose, tab, onTab, entries, onTask, onTopic }: { isOpen: boolean; onClose: () => void; tab: WaysTab; onTab: (tab: WaysTab) => void; entries: CatalogueEntry[]; onTask: (id: RecipeId) => void; onTopic: (id: CliTopicId) => void }) {
    const { t } = useI18n();
    const tabs = [
        { value: "ways" as WaysTab, label: t("sheet.overlap.tabWays"), icon: <Scale /> },
        ...FAMILIES.map((f) => ({ value: f.id as WaysTab, label: t(`sheet.overlap.${f.id}.title` as TranslationKey), icon: FAMILY_ICON[f.id] })),
    ];
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
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            size="5xl"
            fixedHeight
            icon={<Scale />}
            title={tab === "ways" ? t("sheet.ways.title") : t(`sheet.overlap.${tab}.title` as TranslationKey)}
            description={tab === "ways" ? t("sheet.ways.description") : t(`sheet.overlap.${tab}.hint` as TranslationKey)}
            nav={<NavTabs aria-label={t("sheet.overlap.tabsAria")} tabs={tabs} value={tab} onChange={onTab} />}
        >
            {tab !== "ways" ? (
                <ToolOverlap family={family(tab)} />
            ) : (
            <div className="space-y-4">
                <Lane name="ssh" hint={t("sheet.ways.sshHint")} link={t("sheet.ways.linkSsh")} telepySub={t("sheet.ways.gateway")} />
                <Lane name="telepy" hint={t("sheet.ways.telepyHint")} link={t("sheet.topic.linkBoth")} telepySub={t("sheet.ways.gatewayApi")} />
                <p className="text-sm text-muted-foreground">{t("sheet.ways.summary", { both: n.both, telepyOnly: n.telepyOnly })}</p>
                {/* 任務與主題並排（寬的時候）：整頁短一半。/ Tasks and topics side by side when wide: half the height. */}
                <div className="@container">
                <div className="grid items-start gap-3 @3xl:grid-cols-2">
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
                                <tr key={e.id} className="border-b border-border/70 last:border-0">
                                    <th scope="row" className="p-0 font-normal">
                                        <button type="button" className={rowButton} onClick={() => onTask(e.recipe!)}>{t(e.title)}</button>
                                    </th>
                                    <td className="text-center"><Mark on label={yes} /></td>
                                    <td className="text-center"><Mark on={e.ways.includes("ssh")} label={e.ways.includes("ssh") ? yes : no} /></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                <div className="overflow-x-auto rounded-xl border border-border">
                    <table className="w-full border-collapse text-sm">
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
                </div>
                </div>
                <p className="text-xs text-muted-foreground">{t("sheet.ways.tableHint")}</p>
            </div>
            )}
        </Modal>
    );
}
