"use client";

/**
 * 簡化結果：一行摘要（行數、區塊數、逐一驗證過幾個名稱）＋複製 / 下載，簡化前後兩欄（拿掉或搬走的行劃掉、新寫的行標綠），
 * 「改了什麼」與「值得看一下」兩張清單。窄的時候兩欄改成切換。
 * The result: a summary line (lines, blocks, how many names were checked one by one) with copy / download, before
 * and after panes (removed or moved lines struck through, new lines marked), and the "what changed" and "worth a
 * look" lists. Narrow screens switch between the panes instead.
 */
import React, { useState } from "react";
import { Check, CircleAlert, Copy, Download, Eye, Layers, Scissors, Sparkles, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Section } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { Change, Note, TidyResult } from "@/lib/sshConfigTidy";

const NAMES_SHOWN = 6;

function names(list: string[], t: ReturnType<typeof useI18n>["t"]): string {
    return list.length > NAMES_SHOWN ? t("tidy.moreHosts", { names: list.slice(0, NAMES_SHOWN).join(" "), count: list.length - NAMES_SHOWN }) : list.join(" ");
}

function Pane({ title, lines, mark }: { title: string; lines: { text: string; n: number; marked: boolean }[]; mark: "removed" | "added" }) {
    const width = String(Math.max(...lines.map((l) => l.n), lines.length, 1)).length;
    return (
        <section aria-label={title} className="min-w-0">
            <h3 className="mb-1.5 text-sm text-muted-foreground">{title}</h3>
            <div className="overflow-x-auto rounded-lg bg-surface py-2 ring-1 ring-inset ring-border/70">
                <pre className="min-w-max font-mono text-[0.8125rem] leading-relaxed">
                    {lines.map((l, i) => (
                        <div
                            key={i}
                            className={cn(
                                "flex gap-3 pr-3",
                                l.marked && mark === "removed" && "bg-destructive/8 text-muted-foreground line-through decoration-destructive/50",
                                l.marked && mark === "added" && "bg-success/10 text-foreground",
                                !l.marked && "text-foreground",
                            )}
                        >
                            <span className="w-[calc(var(--w)*1ch+0.75rem)] shrink-0 select-none pl-3 text-right text-muted-foreground/70 no-underline" style={{ "--w": width } as React.CSSProperties} aria-hidden>
                                {mark === "added" ? (l.marked ? "+" : "") : l.n}
                            </span>
                            <span className="whitespace-pre">{l.text || " "}</span>
                        </div>
                    ))}
                </pre>
            </div>
        </section>
    );
}

function ChangeLine({ c }: { c: Change }) {
    const { t } = useI18n();
    switch (c.kind) {
        case "duplicate":
            return <>{t("tidy.change.duplicate", { n: c.n, key: c.key, host: c.host })}</>;
        case "repeat":
            return <>{t("tidy.change.repeat", { n: c.n, key: c.key, host: c.host, by: c.by })}</>;
        case "shared":
            return (
                <>
                    {t("tidy.change.shared", { keys: c.keys.join(", "), hosts: names(c.hosts, t) })}
                    <span className="block text-xs text-muted-foreground">{t(c.telepy ? "tidy.change.sharedTelepy" : "tidy.change.sharedLines", { count: c.removed })}</span>
                </>
            );
        case "wildcard":
            return (
                <>
                    {t("tidy.change.wildcard", { pattern: c.pattern, hosts: names(c.hosts, t) })}
                    <span className="block text-xs text-warning">{t("tidy.change.wildcardNote", { pattern: c.pattern })}</span>
                </>
            );
    }
}

function NoteLine({ n }: { n: Note }) {
    const { t } = useI18n();
    switch (n.kind) {
        case "shadowed":
            return <>{t("tidy.note.shadowed", { n: n.n, key: n.key, value: n.value, host: n.host || "*", by: n.by, winner: n.winner })}</>;
        case "unknown":
            return <>{t("tidy.note.unknown", { n: n.n, key: n.key })}</>;
        case "ignored":
            return <>{t("tidy.note.ignored", { n: n.n, key: n.key })}</>;
        case "invalid":
            return <>{t("tidy.note.invalid", { n: n.n })}</>;
        case "wall":
            return null;
    }
}

const CHANGE_ICON: Record<Change["kind"], React.ReactNode> = {
    duplicate: <Scissors size={15} />,
    repeat: <Scissors size={15} />,
    shared: <Layers size={15} />,
    wildcard: <Sparkles size={15} />,
};

interface Props {
    input: string;
    result: TidyResult;
    /** 打字中、結果還沒跟上。/ Still typing; the result lags behind. */
    stale?: boolean;
    onExplain: () => void;
}

export function TidyResultView({ input, result, stale, onExplain }: Props) {
    const { t } = useI18n();
    const [copied, setCopied] = useState(false);
    const [pane, setPane] = useState<"after" | "before">("after");
    const changed = result.text !== input;
    // 空行不標（分隔用的空行搬來搬去不算改了什麼）。/ Blank lines are never marked (moving spacing changes nothing).
    const before = input.replace(/\r?\n$/, "").split(/\r?\n/).map((text, i) => ({ text, n: i + 1, marked: result.removed.has(i + 1) && text.trim() !== "" }));
    const after = result.lines.map((l) => ({ ...l, marked: l.n === 0 && l.text.trim() !== "" }));
    const walls = result.notes.filter((n) => n.kind === "wall").map((n) => n.n);
    const notes = result.notes.filter((n) => n.kind !== "wall");
    const copy = () =>
        navigator.clipboard.writeText(result.text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    const download = () => {
        const url = URL.createObjectURL(new Blob([result.text], { type: "text/plain" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = "config";
        a.click();
        URL.revokeObjectURL(url);
    };

    return (
        <div className={cn("@container space-y-6 transition-opacity", stale && "opacity-60")}>
            {result.failed.length > 0 ? (
                <Callout tone="danger">{t("tidy.failed", { names: result.failed.join(", ") })}</Callout>
            ) : !changed ? (
                <Callout tone="info">{t("tidy.nothing")}</Callout>
            ) : (
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-xl bg-card px-4 py-3 ring-1 ring-inset ring-border">
                    <div className="min-w-0 space-y-1">
                        <p className="text-foreground">
                            {t("tidy.stats", { before: result.before.lines, after: result.after.lines })}
                            <span className="text-muted-foreground"> · {t("tidy.statsSettings", { before: result.before.settings, after: result.after.settings })}</span>
                        </p>
                        <p className="flex items-center gap-1.5 text-sm text-success">
                            <Check size={15} aria-hidden />
                            <span className="text-muted-foreground">{t("tidy.checked", { count: result.checked.length })}</span>
                            <button type="button" onClick={onExplain} className="text-primary underline-offset-4 hover:underline">{t("tidy.seeName")}</button>
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button variant="outline" size="sm" onClick={download}>
                            <Download size={15} /> {t("tidy.download")}
                        </Button>
                        <Button size="sm" onClick={copy}>
                            {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? t("common.copied") : t("tidy.copy")}
                        </Button>
                    </div>
                </div>
            )}

            {changed && result.failed.length === 0 && (
                <>
                    {/* 寬的時候並排，窄的時候切換。/ Side by side when wide, a switch when narrow. */}
                    <div className="@4xl:hidden">
                        <Segmented size="sm" aria-label={t("tidy.result")} value={pane} onChange={setPane} options={[{ value: "after", label: t("tidy.after") }, { value: "before", label: t("tidy.before") }]} />
                    </div>
                    <div className="grid gap-4 @4xl:grid-cols-2">
                        <div className={cn(pane !== "before" && "@max-4xl:hidden")}>
                            <Pane title={t("tidy.before")} lines={before} mark="removed" />
                        </div>
                        <div className={cn(pane !== "after" && "@max-4xl:hidden")}>
                            <Pane title={t("tidy.after")} lines={after} mark="added" />
                        </div>
                    </div>
                    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span><span className="mr-1.5 inline-block size-2.5 rounded-sm bg-destructive/25 align-middle" aria-hidden />{t("tidy.legendRemoved")}</span>
                        <span><span className="mr-1.5 inline-block size-2.5 rounded-sm bg-success/30 align-middle" aria-hidden />{t("tidy.legendAdded")}</span>
                    </p>
                    <Section title={t("tidy.changes")} icon={<Eye size={16} />}>
                        <ul className="divide-y divide-border/70 rounded-lg bg-surface ring-1 ring-inset ring-border/70">
                            {result.changes.map((c, i) => (
                                <li key={i} className="flex items-start gap-2.5 px-3 py-2 text-sm text-foreground">
                                    <span className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden>{CHANGE_ICON[c.kind]}</span>
                                    <span className="min-w-0 [overflow-wrap:anywhere]"><ChangeLine c={c} /></span>
                                </li>
                            ))}
                        </ul>
                    </Section>
                </>
            )}

            {(notes.length > 0 || walls.length > 0) && (
                <Section title={t("tidy.notes")} icon={<TriangleAlert size={16} />}>
                    <ul className="divide-y divide-border/70 rounded-lg bg-surface ring-1 ring-inset ring-border/70">
                        {notes.map((n, i) => (
                            <li key={i} className="flex items-start gap-2.5 px-3 py-2 text-sm text-foreground">
                                <CircleAlert size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                                <span className="min-w-0 [overflow-wrap:anywhere]"><NoteLine n={n} /></span>
                            </li>
                        ))}
                        {walls.length > 0 && (
                            <li className="flex items-start gap-2.5 px-3 py-2 text-sm text-muted-foreground">
                                <CircleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
                                <span className="min-w-0">{t("tidy.note.wall", { lines: walls.join(", ") })}</span>
                            </li>
                        )}
                    </ul>
                </Section>
            )}
        </div>
    );
}
