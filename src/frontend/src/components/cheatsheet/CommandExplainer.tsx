"use client";

/**
 * 指令解說：主指令列本身就是說明書。指令的每一段各一個顏色、底下一條色線；滑鼠移過去（或 Tab 聚焦、手機點一下）
 * 那一段就亮起來，下面那一列換成「這一段是什麼 + 完整說明」；沒有指到任何一段時，那一列是每一段幾個字的圖例
 * （也能指）。點一下會釘住，再點一次放開。跟上面的填空句雙向連動：指到指令的某段，`onActive` 告訴頁面去點亮對應的
 * 空格；頁面把正在編輯的那一格對應的段落用 `lit` 傳回來，這裡就把那幾段亮起來。
 * `TaskRun` 是底下「跑起來長這樣」的終端機：指令、真的會印的那幾行、再一句接下來會怎樣（那句不是終端機印的，所以長得不一樣）。
 * The command explainer: the main command bar is its own manual. Every part has a colour and a line under it; hover
 * (or Tab to, or tap) a part and it lights up while the row below becomes "what this part is + the full explanation";
 * with nothing pointed at, that row is a legend of a few words per part (pointable too). A click pins a part, another
 * click releases it. It is linked both ways with the fill-in sentence above: pointing at a part tells the page through
 * `onActive` to light the blanks it uses, and the page passes back, as `lit`, the parts of the blank being edited.
 * `TaskRun` is the "what a run looks like" terminal under it: the command, the lines really printed, then one
 * sentence on what happens next (not printed by the terminal, so it looks different).
 */
import React, { useState } from "react";
import { MousePointerClick } from "lucide-react";
import { Breakable, CopyButton, PART_COLORS } from "@/components/cheatsheet/CommandView";
import { useI18n } from "@/lib/i18n";
import { SHORT_LABEL, segmentsToString, type Segment } from "@/lib/forwardRecipes";
import type { TaskOutput } from "@/lib/taskOutput";
import { cn } from "@/lib/utils";

interface Props {
    segments: Segment[];
    /** 頁面要亮的段落（正在編輯的空格用到的那幾段）。/ Parts the page wants lit (those the blank being edited appears in). */
    lit?: readonly number[];
    /** 指到 / 釘住了哪一段（null = 沒有）。/ The part pointed at or pinned (null = none). */
    onActive?: (index: number | null) => void;
    onCopy?: () => void;
}

export function CommandExplainer({ segments, lit = [], onActive, onCopy }: Props) {
    const { t } = useI18n();
    const [hover, setHover] = useState<number | null>(null);
    const [pinned, setPinned] = useState<number | null>(null);
    // 指令換了（換任務、換跑法、選項多一段）而釘住的那段不在了：當作沒釘。/ The command changed and the pinned part is gone: treat it as unpinned.
    const pin = pinned !== null && segments[pinned]?.explain ? pinned : null;
    const active = hover ?? pin ?? (lit.length > 0 ? lit[0] : null);
    const point = (i: number | null) => {
        setHover(i);
        onActive?.(i ?? pin);
    };
    const toggle = (i: number) => {
        const next = pin === i ? null : i;
        setPinned(next);
        onActive?.(next ?? hover);
    };
    const on = (i: number) => active === i || lit.includes(i);
    const seg = active !== null ? segments[active] : null;
    const short = (s: Segment) => (s.explain && SHORT_LABEL[s.explain.key] ? t(SHORT_LABEL[s.explain.key]!, s.explain.vars) : null);
    const text = (s: Segment) => s.tokens.map((tk) => tk.text).join(" ");

    return (
        <div className="code-terminal min-w-0 rounded-xl border border-slate-800 bg-[#0b1020] shadow-card" onMouseLeave={() => point(null)}>
            <div className="flex flex-col gap-3 p-3 pl-4 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1 py-1 font-mono text-[1rem] leading-[2.1] text-slate-200" role="group" aria-label={t("sheet.explainer.label")}>
                    <span className="select-none text-slate-500">$ </span>
                    {segments.map((s, i) => {
                        const color = PART_COLORS[i % PART_COLORS.length];
                        const body = <Breakable text={text(s)} />;
                        if (!s.explain) return <React.Fragment key={i}>{i > 0 && " "}<span className="text-slate-200 [overflow-wrap:anywhere]">{body}</span></React.Fragment>;
                        return (
                            <React.Fragment key={i}>
                                {i > 0 && " "}
                                <button
                                    type="button"
                                    aria-pressed={pin === i}
                                    aria-describedby={active === i ? "sheet-explainer-now" : undefined}
                                    onMouseEnter={() => point(i)}
                                    onFocus={() => point(i)}
                                    onBlur={() => point(null)}
                                    onClick={() => toggle(i)}
                                    className={cn(
                                        "relative inline cursor-help rounded-sm px-0.5 text-left font-mono transition-colors [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
                                        color.text,
                                        on(i) ? "bg-white/15" : active !== null ? "opacity-45" : "",
                                    )}
                                    style={{ boxShadow: `inset 0 -2px 0 0 currentColor` }}
                                >
                                    {body}
                                </button>
                            </React.Fragment>
                        );
                    })}
                </div>
                <CopyButton text={segmentsToString(segments)} big onCopy={onCopy} />
            </div>
            {/* 說明列：圖例與說明疊在同一格（沒輪到的那個只是看不見），高度永遠是兩者較高的那個，指來指去時下面的東西不會跳。
                The explanation row: the legend and the explanation share one grid cell (the other is merely invisible), so
                the row is always as tall as the taller one and nothing below jumps while pointing around. */}
            <div className="grid border-t border-white/10 px-4 py-2.5 [&>*]:col-start-1 [&>*]:row-start-1">
                <div className={cn("space-y-1.5", seg?.explain && "invisible")} aria-hidden={seg?.explain ? true : undefined}>
                    <p className="flex items-center gap-1.5 text-xs text-slate-400">
                        <MousePointerClick size={13} className="shrink-0" aria-hidden /> {t("sheet.explainer.hint")}
                    </p>
                    <ul className="flex flex-wrap gap-x-3 gap-y-1">
                        {segments.map((s, i) => {
                            const label = short(s);
                            if (!label) return null;
                            const color = PART_COLORS[i % PART_COLORS.length];
                            return (
                                <li key={i}>
                                    <button type="button" tabIndex={-1} onMouseEnter={() => point(i)} onClick={() => toggle(i)} className="inline-flex items-center gap-1.5 rounded-sm text-xs text-slate-300 hover:text-white">
                                        <span className={cn("inline-block h-[3px] w-3 rounded-full", color.bar)} aria-hidden />
                                        {label}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                </div>
                {seg?.explain && (
                    <p id="sheet-explainer-now" role="status" className="self-start text-sm leading-relaxed text-slate-300">
                        <span className={cn("mr-2 inline-flex items-center gap-1.5 font-medium", PART_COLORS[active! % PART_COLORS.length].text)}>
                            <span className={cn("inline-block size-2 rounded-full", PART_COLORS[active! % PART_COLORS.length].bar)} aria-hidden />
                            {short(seg) ?? text(seg)}
                        </span>
                        {t(seg.explain.key, seg.explain.vars)}
                    </p>
                )}
            </div>
        </div>
    );
}

/** 「跑起來長這樣」：指令、會印的那幾行、接下來會怎樣。/ "What a run looks like": the command, the lines printed, what happens next. */
export function TaskRun({ command, output }: { command: string; output: TaskOutput }) {
    const { t } = useI18n();
    return (
        <figure className="overflow-hidden rounded-lg bg-[oklch(0.2_0.012_260)] ring-1 ring-black/10 dark:bg-[oklch(0.14_0.01_260)] dark:ring-white/10">
            <figcaption className="px-3 pt-2 text-xs text-white/50">{t("sheet.out.title")}</figcaption>
            <pre className="overflow-x-auto px-3 pt-2 font-mono text-[0.8125rem] leading-relaxed text-white/85">
                <span className="block whitespace-pre-wrap text-white [overflow-wrap:anywhere]">$ {command}</span>
                {output.lines.map((l, i) => (
                    <span key={i} className={cn("block", /\S {2,}\S/.test(l) ? "whitespace-pre" : "whitespace-pre-wrap [overflow-wrap:anywhere]")}>{l || " "}</span>
                ))}
            </pre>
            {/* 這句不是終端機印的：換一種字、前面一條線。/ Not printed by the terminal, so another face and a rule in front. */}
            <p className="mx-3 mb-2.5 mt-2 border-l-2 border-white/25 pl-2.5 text-xs leading-relaxed text-white/65">{t(output.note, output.vars)}</p>
        </figure>
    );
}
