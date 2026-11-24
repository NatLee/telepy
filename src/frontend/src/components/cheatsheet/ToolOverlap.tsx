"use client";

/**
 * 「這些工具差在哪」的圖：功能重疊的一組 telepy 指令（`lib/toolOverlap.ts`）畫成兩張——
 * 1. 能力矩陣：每件事一列（由小到大）、每個工具一欄；做得到的格子上色，上下相連就成了一條，一眼看出誰涵蓋到哪裡，
 *    格子裡寫的是用哪個旗標做（`-L`、`--all`…）；欄頭的小圖示是它需要什麼（SSH 金鑰 / 登入 / 管理員權限）。
 * 2. 誰包含誰：每個工具一個框；被它完全涵蓋的工具畫成框裡的小框（子集合），再列出它多出來的事，
 *    以及這一組裡只有它做得到的事。關係是從矩陣算出來的（`containment`），不是另外寫的。
 * The picture behind "How these tools differ": one family of overlapping telepy commands drawn twice —
 * 1. an ability matrix: a row per ability (small to large), a column per tool; cells a tool can do are filled and
 *    join into a bar, each naming the flag that does it; the icons in the column head are what the tool needs.
 * 2. who contains whom: a box per tool, the tools it fully covers as boxes inside it (subsets), what it adds, and
 *    what only it can do. The relations are computed from the matrix (`containment`), never written separately.
 */
import React from "react";
import { Check, KeyRound, LogIn, ShieldCheck, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { capLabel, containment, sameNeeds, shared, type Containment, type Need, type OverlapFamily, type OverlapTool } from "@/lib/toolOverlap";
import type { TranslationKey } from "@/locales/en";
import { cn } from "@/lib/utils";

const NEED_ICON: Record<Need, LucideIcon> = { key: KeyRound, signin: LogIn, admin: ShieldCheck };
const needLabel = (n: Need) => `sheet.overlap.need.${n}` as TranslationKey;

/** `telepy forward` → 兩行：淡的 telepy、清楚的 forward（欄位才放得下）。/ Two lines, so the columns stay narrow. */
function ToolName({ tool, inline = false }: { tool: OverlapTool; inline?: boolean }) {
    const sub = tool.name.replace(/^telepy /, "");
    if (inline) return <code className="font-mono text-sm text-foreground">{tool.name}</code>;
    return (
        <span className="block font-mono leading-tight">
            <span className="block text-[0.6875rem] text-muted-foreground">telepy</span>
            <span className="block text-sm text-foreground">{sub}</span>
        </span>
    );
}

function Needs({ needs, text = false }: { needs: Need[]; text?: boolean }) {
    const { t } = useI18n();
    const label = needs.map((n) => t(needLabel(n))).join(" + ");
    return (
        <span className={cn("inline-flex items-center gap-1 text-muted-foreground", text && "flex-wrap gap-x-1.5 text-xs")} role="img" aria-label={`${t("sheet.overlap.needs")} ${label}`} title={`${t("sheet.overlap.needs")} ${label}`}>
            {needs.map((n) => {
                const Icon = NEED_ICON[n];
                return <Icon key={n} size={13} aria-hidden />;
            })}
            {text && <span>{label}</span>}
        </span>
    );
}

function Cell({ tool, cap }: { tool: OverlapTool; cap: string }) {
    const { t } = useI18n();
    const on = cap in tool.can;
    const flag = tool.can[cap];
    return (
        <>
            {on ? (
                flag ? <code className="whitespace-nowrap font-mono text-xs">{flag}</code> : <Check size={15} className="mx-auto text-success" aria-hidden />
            ) : (
                <span aria-hidden>·</span>
            )}
            <span className="sr-only">{t(on ? "sheet.overlap.can" : "sheet.overlap.cannot")}</span>
        </>
    );
}

/** 圖示的意思：這一組用到的那幾種「需要」。/ What the icons mean: the needs this family uses. */
function NeedLegend({ family, className }: { family: OverlapFamily; className?: string }) {
    const { t } = useI18n();
    const needs = [...new Set(family.tools.flatMap((tool) => tool.needs))];
    return (
        <ul className={cn("text-xs text-muted-foreground", className)} aria-label={t("sheet.overlap.needs")}>
            {needs.map((n) => {
                const Icon = NEED_ICON[n];
                return (
                    <li key={n} className="flex items-center gap-1.5">
                        <Icon size={13} className="shrink-0" aria-hidden /> {t(needLabel(n))}
                    </li>
                );
            })}
        </ul>
    );
}

const cellTone = (on: boolean) => (on ? "bg-foreground/[0.08] text-foreground" : "text-muted-foreground/40");

function Matrix({ family }: { family: OverlapFamily }) {
    const { t } = useI18n();
    const cols = { gridTemplateColumns: `repeat(${family.tools.length}, minmax(0, 1fr))` };
    return (
        <>
            {/* 寬：一張表，做得到的格子上下相連成一條。/ Wide: one table, filled cells join into bars. */}
            <div className="hidden rounded-xl border border-border @xl:block">
                <table className="w-full border-collapse text-sm">
                    <caption className="sr-only">{t("sheet.overlap.matrix")}</caption>
                    <thead>
                        <tr className="border-b border-border">
                            <td className="px-3 py-2 align-bottom"><NeedLegend family={family} className="space-y-0.5" /></td>
                            {family.tools.map((tool) => (
                                <th key={tool.id} scope="col" className="w-[5.5rem] min-w-[5.5rem] px-1.5 py-2 text-center align-bottom font-normal">
                                    <ToolName tool={tool} />
                                    <span className="mt-1 flex justify-center"><Needs needs={tool.needs} /></span>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {family.caps.map((cap) => (
                            <tr key={cap} className="group">
                                <th scope="row" className="px-3 py-2 text-left font-normal leading-snug text-foreground group-hover:bg-muted/50">{t(capLabel(family.id, cap))}</th>
                                {family.tools.map((tool) => (
                                    // 做得到的格子不留間隙：上下相連成一條。/ No gap between filled cells, so they join into a bar.
                                    <td key={tool.id} className={cn("h-10 border-x-[0.375rem] border-transparent bg-clip-padding px-1 text-center", cellTone(cap in tool.can))}>
                                        <Cell tool={tool} cap={cap} />
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {/* 窄：工具名一列在上，每件事一行字、底下一排格子（不必橫向捲才看得到最後一欄）。/ Narrow: the tool names on top, then each ability as a line with a strip of cells under it (no sideways scrolling to see the last tool). */}
            <div className="rounded-xl border border-border @xl:hidden" role="table" aria-label={t("sheet.overlap.matrix")}>
                <div role="row" className="grid gap-1.5 rounded-t-xl border-b border-border bg-card px-2 py-2" style={cols}>
                    {family.tools.map((tool) => (
                        <div key={tool.id} role="columnheader" className="min-w-0 text-center">
                            <ToolName tool={tool} />
                            <span className="mt-1 flex justify-center"><Needs needs={tool.needs} /></span>
                        </div>
                    ))}
                </div>
                {family.caps.map((cap) => (
                    <div key={cap} role="row" className="px-2 pb-2 pt-2.5">
                        <div role="rowheader" className="pb-1.5 text-sm leading-snug text-foreground">{t(capLabel(family.id, cap))}</div>
                        <div className="grid gap-1.5" style={cols}>
                            {family.tools.map((tool) => (
                                <div key={tool.id} role="cell" className={cn("flex h-8 min-w-0 items-center justify-center rounded-sm", cap in tool.can ? cellTone(true) : "border border-dashed border-border text-muted-foreground/40")}>
                                    <Cell tool={tool} cap={cap} />
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </>
    );
}

function CapList({ label, family, caps, strong = false }: { label: string; family: OverlapFamily; caps: string[]; strong?: boolean }) {
    const { t } = useI18n();
    if (caps.length === 0) return null;
    return (
        <div className="text-sm leading-relaxed">
            <span className="text-xs text-muted-foreground">{label}</span>
            <ul className="mt-0.5 space-y-0.5">
                {caps.map((c) => (
                    <li key={c} className="flex gap-2">
                        <span className={cn("mt-2 size-1.5 shrink-0 rounded-full", strong ? "bg-primary/70" : "bg-muted-foreground/50")} aria-hidden />
                        <span className="min-w-0 text-foreground">{t(capLabel(family.id, c))}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function ToolBox({ family, item, coveredBy }: { family: OverlapFamily; item: Containment; coveredBy: OverlapTool[] }) {
    const { t } = useI18n();
    const { tool, covers, same, adds, only } = item;
    // 「多出來的事」裡，只有它做得到的另外標出來，不重複列。/ Of what it adds, the things only it does are listed apart, not twice.
    const plainAdds = adds.filter((c) => !only.includes(c));
    return (
        <li className="min-w-0 space-y-2 rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <ToolName tool={tool} inline />
                <Needs needs={tool.needs} text />
            </div>
            {covers.length > 0 && (
                <div>
                    <span className="text-xs text-muted-foreground">{t("sheet.overlap.contains")}</span>
                    {/* 子集合：畫成框裡的框。/ Subsets, drawn as boxes inside the box. */}
                    <ul className="mt-1 flex flex-wrap gap-2">
                        {covers.map((c) => (
                            <li key={c.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5">
                                <code className="font-mono text-xs text-foreground">{c.name}</code>
                                <Needs needs={c.needs} />
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {same.length > 0 && <p className="text-sm text-foreground">{t("sheet.overlap.sameAs", { tools: same.map((s) => s.name).join(" · ") })}</p>}
            {covers.length > 0 && <CapList label={t("sheet.overlap.adds")} family={family} caps={plainAdds} />}
            <CapList label={t("sheet.overlap.onlyIt")} family={family} caps={only} strong />
            {coveredBy.length > 0 && (
                <p className="text-sm leading-relaxed text-muted-foreground">
                    {t("sheet.overlap.coveredBy", { tools: coveredBy.map((c) => c.name).join(" · ") })}{" "}
                    {/* 為什麼還要它：需要的比較少，或它自己的一句話。/ Why it still exists: it needs less, or its own note. */}
                    {coveredBy.every((c) => !sameNeeds(c, tool)) ? t("sheet.overlap.needsOnly", { needs: tool.needs.map((n) => t(needLabel(n))).join(" + ") }) : tool.note ? t(tool.note) : null}
                </p>
            )}
        </li>
    );
}

export function ToolOverlap({ family }: { family: OverlapFamily }) {
    const { t } = useI18n();
    const items = containment(family);
    const all = shared(family);
    return (
        <div className="@container space-y-4">
                        <Matrix family={family} />
            <NeedLegend family={family} className="flex flex-wrap gap-x-4 gap-y-1 @xl:hidden" />
            <div className="space-y-2">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h3 className="text-sm text-foreground">{t("sheet.overlap.nest")}</h3>
                    {all.length > 0 && <p className="min-w-0 text-sm leading-relaxed text-muted-foreground">{t("sheet.overlap.shared", { caps: all.map((c) => t(capLabel(family.id, c))).join(t("sheet.overlap.listJoin")) })}</p>}
                </div>
                <ul className={cn("grid gap-3 @2xl:grid-cols-2", items.length === 3 && "@3xl:grid-cols-3")}>
                    {items.map((item) => (
                        <ToolBox key={item.tool.id} family={family} item={item} coveredBy={items.filter((o) => o.covers.includes(item.tool)).map((o) => o.tool)} />
                    ))}
                </ul>
            </div>
        </div>
    );
}
