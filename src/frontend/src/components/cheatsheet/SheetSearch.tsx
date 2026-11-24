"use client";

/**
 * 指令速查的搜尋：一個輸入框（`/` 聚焦、Esc 清掉），以及搜尋中取代步驟的結果清單。結果同時包含速查頁的任務
 * （點了跳到填空）與 telepy CLI 的範例（點了在原地展開、可複製），每一列都標明 telepy / ssh 哪個做得到。
 * 三種語言一起比對：用別的語言找到時，把那個語言的標題也寫出來，讓人知道為什麼會出現。
 * The command sheet's search: one input (`/` focuses it, Esc clears it) and the result list that replaces the steps
 * while searching. Results mix the sheet's tasks (a click goes to fill-in) and the telepy CLI's examples (a click
 * unfolds them in place, copyable); every row says which of telepy / ssh can do it. All three languages are matched:
 * a row found through another language also shows that language's title, so it is clear why it is there.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, ChevronDown, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MiniCommand } from "@/components/cheatsheet/CommandView";
import { WayMarks } from "@/components/cheatsheet/WayMarks";
import { useI18n } from "@/lib/i18n";
import { DICTIONARIES } from "@/lib/translate";
import { catalogue, fillTunnel, searchCatalogue, type CatalogueEntry, type SearchHit, type Way } from "@/lib/sheetCatalogue";
import type { CliTopicId } from "@/lib/cliExamples.gen";
import type { RecipeId } from "@/lib/forwardRecipes";
import type { TranslationKey } from "@/locales/en";
import { cn } from "@/lib/utils";

export const SHEET_CATALOGUE: CatalogueEntry[] = catalogue();

export type WayFilter = Way | "all";

const topicLabel = (id: CliTopicId) => `cli.topic.${id}` as TranslationKey;

/** 搜尋框。/ The search box. */
export function SheetSearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    const { t } = useI18n();
    const ref = useRef<HTMLInputElement>(null);
    // `/` 聚焦（不在輸入框裡的時候）。/ `/` focuses it (when not typing somewhere).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
            const el = e.target as HTMLElement | null;
            if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
            e.preventDefault();
            ref.current?.focus();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
    return (
        <div className="relative">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
                ref={ref}
                type="search"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Escape" && value) {
                        e.preventDefault();
                        onChange("");
                    }
                }}
                placeholder={t("sheet.search.placeholder")}
                aria-label={t("sheet.search.label")}
                autoComplete="off"
                spellCheck={false}
                className="h-11 w-full rounded-xl border border-border bg-card pl-9 pr-10 text-sm text-foreground shadow-card outline-none placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
            />
            {value ? (
                <button type="button" onClick={() => { onChange(""); ref.current?.focus(); }} aria-label={t("sheet.search.clear")} className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
                    <X size={15} />
                </button>
            ) : (
                <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-muted px-1.5 font-mono text-[0.6875rem] text-muted-foreground sm:block" aria-hidden>/</kbd>
            )}
        </div>
    );
}

function Row({ hit, tunnel, open, onToggle, onTask, taskCommand }: { hit: SearchHit; tunnel: string; open: boolean; onToggle: () => void; onTask: (id: RecipeId) => void; taskCommand?: (id: RecipeId) => string }) {
    const { t } = useI18n();
    const e = hit.entry;
    // 任務的預覽是這一頁現在會給的指令（帳號、填好的數字都對）；範例是填上通道名的原文。
    // A task previews the command this page would give right now (account and numbers included); an example is its own lines with the tunnel filled in.
    const lines = useMemo(() => (e.recipe && taskCommand ? [taskCommand(e.recipe)] : fillTunnel(e.lines, tunnel)), [e.lines, e.recipe, taskCommand, tunnel]);
    const task = e.kind === "task";
    const via = hit.via ? DICTIONARIES[hit.via as keyof typeof DICTIONARIES]?.[e.title] : null;
    const body = (
        <>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">{t(e.title)}</span>
                <WayMarks ways={e.ways} />
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{task ? t("sheet.search.kindTask") : t(topicLabel(e.topic))}</span>
            </span>
            {via && via !== t(e.title) && <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{t("sheet.search.via", { title: via })}</span>}
            {e.note && <span className="block text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{t(e.note)}</span>}
            {!open && lines[0] && <code className="block truncate font-mono text-xs text-muted-foreground">$ {lines[0]}{lines.length > 1 ? " …" : ""}</code>}
        </>
    );
    if (task) {
        return (
            <li>
                <button type="button" onClick={() => onTask(e.recipe!)} className="group flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                    <span className="min-w-0 flex-1 space-y-1">{body}</span>
                    <span className="mt-0.5 flex shrink-0 items-center gap-1 text-xs text-primary">
                        <span className="hidden sm:inline">{t("sheet.search.fill")}</span>
                        <ArrowRight size={15} aria-hidden />
                    </span>
                </button>
            </li>
        );
    }
    return (
        <li>
            <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                <span className="min-w-0 flex-1 space-y-1">{body}</span>
                <ChevronDown size={16} className={cn("mt-0.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
            </button>
            {open && (
                <div className="space-y-2 px-4 pb-4">
                    {lines.map((l, i) => <MiniCommand key={i} command={l} />)}
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>{lines.some((l) => /<[^<>\s]+>/.test(l)) ? t("sheet.search.fillHint") : ""}</span>
                        <Link href="/tunnels/cli?tab=examples" prefetch={false} className="underline underline-offset-2 hover:text-foreground">{t("sheet.search.openCli")}</Link>
                    </div>
                </div>
            )}
        </li>
    );
}

export interface SheetResultsProps {
    query: string;
    topic: CliTopicId | null;
    way: WayFilter;
    onWay: (w: WayFilter) => void;
    /** 填進範例的通道名稱。/ The tunnel name filled into the examples. */
    tunnel: string;
    onTask: (id: RecipeId) => void;
    /** 任務現在會給的指令（結果列的預覽）。/ The command a task gives right now (the row's preview). */
    taskCommand?: (id: RecipeId) => string;
    onBack: () => void;
}

/** 搜尋結果（或某個主題的全部）。/ The search results (or everything in a topic). */
export function SheetResults({ query, topic, way, onWay, tunnel, onTask, taskCommand, onBack }: SheetResultsProps) {
    const { t, locale } = useI18n();
    const [open, setOpen] = useState<string | null>(null);
    const hits = useMemo(() => searchCatalogue(SHEET_CATALOGUE, query, DICTIONARIES, locale, { topic, way: way === "all" ? null : way }), [query, topic, way, locale]);
    const filters: { value: WayFilter; label: string }[] = [
        { value: "all", label: t("sheet.search.filterAll") },
        { value: "telepy", label: "telepy" },
        { value: "ssh", label: "ssh" },
    ];
    return (
        <section className="rounded-xl border border-border bg-card shadow-card" aria-label={t("sheet.search.results")}>
            <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
                <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
                    <ArrowLeft size={15} /> {t("sheet.search.back")}
                </Button>
                <p role="status" className="min-w-0 flex-1 text-sm text-muted-foreground">
                    {topic && <span className="text-foreground">{t(topicLabel(topic))} · </span>}
                    {t("sheet.search.count", { count: hits.length })}
                </p>
                <div role="group" aria-label={t("sheet.search.filterLabel")} className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
                    {filters.map((f) => (
                        <button
                            key={f.value}
                            type="button"
                            aria-pressed={way === f.value}
                            onClick={() => onWay(f.value)}
                            className={cn("rounded-md px-2.5 py-1 text-xs transition-colors", f.value !== "all" && "font-mono", way === f.value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
            </header>
            {hits.length === 0 ? (
                <div className="px-4 py-10 text-center">
                    <p className="text-sm text-foreground">{t("sheet.search.none", { query: query.trim() })}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{t("sheet.search.noneHint")}</p>
                </div>
            ) : (
                <ul className="divide-y divide-border">
                    {hits.map((h) => (
                        <Row key={h.entry.id} hit={h} tunnel={tunnel} open={open === h.entry.id} onToggle={() => setOpen((o) => (o === h.entry.id ? null : h.entry.id))} onTask={onTask} taskCommand={taskCommand} />
                    ))}
                </ul>
            )}
        </section>
    );
}
