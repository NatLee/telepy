"use client";

/**
 * 編輯器的「簡化」分頁：摘要（行數、設定行數、逐一驗證過幾個名稱）＋「改用這個版本」，下面一次看一個——簡化後 / 簡化前
 * （拿掉或搬走的行劃掉、新寫的行標綠）/ 改了什麼。版面在分頁自己的高度裡，長設定不會把整頁拉長。
 * The editor's "simplify" tab: a summary (lines, settings, how many names were checked) with "use this version",
 * then one view at a time — after / before (removed or moved lines struck through, new lines marked) / what
 * changed — inside the tab's own height, so a long config never stretches the page.
 */
import React, { useState } from "react";
import { Check, CircleAlert, Layers, Scissors, Sparkles, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { Change, Note, TidyResult } from "@/lib/sshConfigTidy";

const NAMES_SHOWN = 6;

export function names(list: string[], t: ReturnType<typeof useI18n>["t"]): string {
    return list.length > NAMES_SHOWN ? t("tidy.moreHosts", { names: list.slice(0, NAMES_SHOWN).join(" "), count: list.length - NAMES_SHOWN }) : list.join(" ");
}

/** 設定文字，左邊行號，標記的行上色。/ Config text with line numbers; marked lines tinted. */
export function Pane({ lines, mark }: { lines: { text: string; n: number; marked: boolean }[]; mark: "removed" | "added" }) {
    const width = String(Math.max(...lines.map((l) => l.n), lines.length, 1)).length;
    return (
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

/** 一則提醒的句子。/ One note as a sentence. */
export function NoteLine({ n }: { n: Note }) {
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
            return <>{t("tidy.note.wall", { lines: n.n })}</>;
    }
}

const CHANGE_ICON: Record<Change["kind"], React.ReactNode> = {
    duplicate: <Scissors size={15} />,
    repeat: <Scissors size={15} />,
    shared: <Layers size={15} />,
    wildcard: <Sparkles size={15} />,
};

type View = "after" | "before" | "changes";

interface Props {
    input: string;
    result: TidyResult;
    /** 打字中、結果還沒跟上。/ Still typing; the result lags behind. */
    stale?: boolean;
    wildcards: boolean;
    onWildcards: (on: boolean) => void;
    /** 把編輯器換成簡化後的版本。/ Put the simpler version in the editor. */
    onUse: (text: string) => void;
    onExplain: () => void;
}

export function TidyResultView({ input, result, stale, wildcards, onWildcards, onUse, onExplain }: Props) {
    const { t } = useI18n();
    const [view, setView] = useState<View>("after");
    const changed = result.text !== input;
    // 空行不標（分隔用的空行搬來搬去不算改了什麼）。/ Blank lines are never marked (moving spacing changes nothing).
    const before = input.replace(/\r?\n$/, "").split(/\r?\n/).map((text, i) => ({ text, n: i + 1, marked: result.removed.has(i + 1) && text.trim() !== "" }));
    const after = result.lines.map((l) => ({ ...l, marked: l.n === 0 && l.text.trim() !== "" }));

    return (
        <div className={cn("space-y-4 transition-opacity", stale && "opacity-60")}>
            <div className="space-y-1">
                <Switch checked={wildcards} onCheckedChange={onWildcards} size="sm">
                    <span className="text-sm text-foreground">{t("tidy.wildcards")}</span>
                </Switch>
                <p className="pl-11 text-xs leading-relaxed text-muted-foreground">{t("tidy.wildcardsHint")}</p>
            </div>
            {result.failed.length > 0 ? (
                <Callout tone="danger">{t("tidy.failed", { names: result.failed.join(", ") })}</Callout>
            ) : !changed ? (
                <Callout tone="info">{t("tidy.nothing")}</Callout>
            ) : (
                <>
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-xl bg-card px-4 py-3 ring-1 ring-inset ring-border">
                        <div className="min-w-0 space-y-1">
                            <p className="text-foreground">
                                {t("tidy.stats", { before: result.before.lines, after: result.after.lines })}
                                <span className="text-muted-foreground"> · {t("tidy.statsSettings", { before: result.before.settings, after: result.after.settings })}</span>
                            </p>
                            <p className="flex flex-wrap items-center gap-x-1.5 text-sm">
                                <Check size={15} className="text-success" aria-hidden />
                                <span className="text-muted-foreground">{t("tidy.checked", { count: result.checked.length })}</span>
                                <button type="button" onClick={onExplain} className="text-primary underline-offset-4 hover:underline">{t("tidy.seeName")}</button>
                            </p>
                        </div>
                        <Button size="sm" onClick={() => onUse(result.text)}>
                            <Wand2 size={15} /> {t("tidy.use")}
                        </Button>
                    </div>
                    <Segmented
                        size="sm"
                        aria-label={t("tidy.result")}
                        value={view}
                        onChange={setView}
                        options={[
                            { value: "after", label: t("tidy.after") },
                            { value: "before", label: t("tidy.before") },
                            { value: "changes", label: t("tidy.changesCount", { count: result.changes.length }) },
                        ]}
                    />
                    {view === "after" && <Pane lines={after} mark="added" />}
                    {view === "before" && <Pane lines={before} mark="removed" />}
                    {view !== "changes" && (
                        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            <span><span className="mr-1.5 inline-block size-2.5 rounded-sm bg-destructive/25 align-middle" aria-hidden />{t("tidy.legendRemoved")}</span>
                            <span><span className="mr-1.5 inline-block size-2.5 rounded-sm bg-success/30 align-middle" aria-hidden />{t("tidy.legendAdded")}</span>
                        </p>
                    )}
                    {view === "changes" && (
                        <ul className="divide-y divide-border/70 rounded-lg bg-surface ring-1 ring-inset ring-border/70">
                            {result.changes.map((c, i) => (
                                <li key={i} className="flex items-start gap-2.5 px-3 py-2 text-sm text-foreground">
                                    <span className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden>{CHANGE_ICON[c.kind]}</span>
                                    <span className="min-w-0 [overflow-wrap:anywhere]"><ChangeLine c={c} /></span>
                                </li>
                            ))}
                        </ul>
                    )}
                </>
            )}
            {result.notes.some((n) => n.kind !== "wall") && (
                <p className="flex items-start gap-2 text-xs text-muted-foreground">
                    <CircleAlert size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                    {t("tidy.notesElsewhere", { count: result.notes.filter((n) => n.kind !== "wall").length })}
                </p>
            )}
        </div>
    );
}
