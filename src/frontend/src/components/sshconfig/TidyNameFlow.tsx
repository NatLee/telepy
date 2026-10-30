"use client";

/**
 * 一個名稱在設定裡怎麼被讀：「ssh <名稱>」往下一條直線，經過每個套用到它的區塊（照檔案順序），每行標出用了、累加或
 * 已經有值所以略過，最後是 ssh 實際用的值。簡化前後並排，結果一樣就在中間標出來。
 * How one name is read: a straight line down from "ssh <name>" through every block that applies (in file order),
 * each line marked used, stacked or skipped because a value was already set, ending in what ssh uses. Before and
 * after side by side, marked when the results agree.
 */
import React from "react";
import { Check, CornerDownRight, Layers, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { Chip } from "@/components/ui/section";
import { explainHost, sameResult, traceHost, type TraceBlock } from "@/lib/sshConfigTidy";

function BlockCard({ block, name }: { block: TraceBlock; name: string }) {
    const { t } = useI18n();
    return (
        <li className="relative pl-6">
            {/* 直線上的節點 / The node on the line */}
            <span className={cn("absolute left-[0.3125rem] top-3 size-2.5 rounded-full ring-2 ring-card", block.made ? "bg-primary" : "bg-foreground/40")} aria-hidden />
            <div className={cn("rounded-lg bg-surface ring-1 ring-inset", block.made ? "ring-primary/40" : "ring-border/70")}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 px-3 py-1.5">
                    <code className="min-w-0 font-mono text-[0.8125rem] text-foreground [overflow-wrap:anywhere]">{block.header || t("tidy.info.global")}</code>
                    {block.n > 0 && <span className="text-xs tabular-nums text-muted-foreground">{t("tidy.info.line", { n: block.n })}</span>}
                    {block.made && (
                        <Chip tone="primary">
                            <Layers />
                            {t("tidy.info.sharedBlock")}
                        </Chip>
                    )}
                </div>
                <ul className="space-y-0.5 px-3 py-2">
                    {block.lines.map((l) => (
                        <li key={l.n} className="flex min-w-0 items-baseline gap-2 text-[0.8125rem]">
                            <code
                                className={cn(
                                    "min-w-0 font-mono [overflow-wrap:anywhere]",
                                    l.state === "skipped" ? "text-muted-foreground line-through decoration-muted-foreground/60" : "text-foreground",
                                )}
                            >
                                <span className={l.state === "skipped" ? "" : "text-info"}>{l.key}</span> {l.value}
                                {l.slot === "hostname" && l.value.includes("%h") && <span className="text-muted-foreground"> → {l.value.replace(/%h/g, name)}</span>}
                            </code>
                            <span className={cn("ml-auto shrink-0 text-xs", l.state === "skipped" ? "text-muted-foreground" : l.state === "stacked" ? "text-info" : "text-success")}>
                                {t(l.state === "skipped" ? "tidy.info.skipped" : l.state === "stacked" ? "tidy.info.stacked" : "tidy.info.used")}
                            </span>
                        </li>
                    ))}
                    {block.lines.length === 0 && <li className="text-xs text-muted-foreground">{t("tidy.info.emptyBlock")}</li>}
                </ul>
            </div>
        </li>
    );
}

function Column({ title, text, name, lines }: { title: string; text: string; name: string; lines: number }) {
    const { t } = useI18n();
    const trace = traceHost(text, name);
    // 照選項名稱排（累加的保持順序）：前後兩欄一行對一行。/ Sorted by option (stacks keep their order): both columns line up.
    const used = [...explainHost(text, name).rows].sort((a, b) => a.slot.localeCompare(b.slot));
    return (
        <section aria-label={title} className="min-w-0 space-y-2">
            <div className="flex items-baseline justify-between gap-2">
                <h4 className="text-sm text-foreground">{title}</h4>
                <span className="text-xs tabular-nums text-muted-foreground">{t("tidy.info.fileLines", { count: lines })}</span>
            </div>
            <div className="relative">
                {/* 一條直線從「ssh 名稱」到結果。/ One straight line from "ssh name" to the result. */}
                <span className="absolute bottom-6 left-2.5 top-4 w-px bg-border" aria-hidden />
                <ol className="space-y-2.5">
                    <li className="relative pl-6">
                        <span className="absolute left-[0.3125rem] top-1.5 size-2.5 rounded-full bg-foreground ring-2 ring-card" aria-hidden />
                        <code className="font-mono text-[0.8125rem] text-foreground">ssh {name}</code>
                    </li>
                    {trace.blocks.length === 0 && <li className="relative pl-6 text-sm text-muted-foreground">{t("tidy.info.noBlocks")}</li>}
                    {trace.blocks.map((b) => (
                        <BlockCard key={`${b.n}-${b.header}`} block={b} name={name} />
                    ))}
                    <li className="relative pl-6">
                        <span className="absolute left-[0.3125rem] top-3 size-2.5 rounded-full bg-success ring-2 ring-card" aria-hidden />
                        <div className="rounded-lg bg-card px-3 py-2 ring-1 ring-inset ring-border">
                            <p className="mb-1 text-xs text-muted-foreground">{t("tidy.info.result")}</p>
                            {used.length === 0 ? (
                                <p className="text-sm text-muted-foreground">{t("tidy.info.defaults")}</p>
                            ) : (
                                <ul className="space-y-0.5">
                                    {used.map((r) => (
                                        <li key={`${r.slot}-${r.n}`} className="flex min-w-0 items-baseline gap-1.5 font-mono text-[0.8125rem] [overflow-wrap:anywhere]">
                                            <CornerDownRight size={12} className="shrink-0 translate-y-0.5 text-muted-foreground" aria-hidden />
                                            <span className="text-info">{r.key}</span>
                                            <span className="text-foreground">{r.slot === "hostname" ? r.value.replace(/%h/g, name) : r.value}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </li>
                </ol>
            </div>
            {trace.matches.length > 0 && <p className="text-xs text-muted-foreground">{t("tidy.info.matchNote", { lines: trace.matches.join(", ") })}</p>}
        </section>
    );
}

interface Props {
    before: string;
    after: string;
    name: string;
}

export function TidyNameFlow({ before, after, name }: Props) {
    const { t } = useI18n();
    const same = sameResult(before, after, name);
    const count = (s: string) => (s ? s.replace(/\n$/, "").split("\n").length : 0);
    return (
        <div className="@container space-y-3">
            <p className={cn("flex items-center gap-2 text-sm", same ? "text-success" : "text-destructive")}>
                {same ? <Check size={16} aria-hidden /> : <X size={16} aria-hidden />}
                <span className="text-foreground">{t(same ? "tidy.info.same" : "tidy.info.diff", { name })}</span>
            </p>
            <div className="grid gap-5 @3xl:grid-cols-2">
                <Column title={t("tidy.before")} text={before} name={name} lines={count(before)} />
                <Column title={t("tidy.after")} text={after} name={name} lines={count(after)} />
            </div>
        </div>
    );
}
