"use client";

/**
 * 指令顯示：終端機風格面板，token 依種類上色，每一段滑過就有說明；下面的圖例把每一段的意思列出來（手機沒有 hover）。
 * Command display: a terminal-style panel with tokens coloured by kind and a tooltip per segment; the legend below
 * spells out every segment (phones have no hover).
 */
import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { segmentsToString, type Segment, type TokenKind } from "@/lib/forwardRecipes";

const TOKEN_CLASS: Record<TokenKind, string> = {
    cmd: "text-emerald-400 font-semibold",
    flag: "text-sky-400",
    value: "text-amber-300",
    target: "text-violet-300",
    arg: "text-slate-200",
};

function useCopy(text: string) {
    const [copied, setCopied] = useState(false);
    const copy = () => {
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
        }).catch(() => { /* 剪貼簿不可用時不做事 / clipboard unavailable: no-op */ });
    };
    return { copied, copy };
}

export function CopyButton({ text, className, compact = false }: { text: string; className?: string; compact?: boolean }) {
    const { t } = useI18n();
    const { copied, copy } = useCopy(text);
    return (
        <button
            type="button"
            onClick={copy}
            title={t("ui.copyToClipboard")}
            aria-label={t("ui.copyToClipboard")}
            className={cn(
                "inline-flex items-center gap-1.5 rounded-md text-xs font-medium transition-colors shrink-0",
                compact ? "p-1.5" : "px-2.5 py-1.5",
                copied ? "bg-emerald-500/15 text-emerald-300" : "bg-white/10 text-slate-200 hover:bg-white/20",
                className
            )}
        >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {!compact && (copied ? t("common.copied") : t("common.copy"))}
        </button>
    );
}

function Tokens({ segments, interactive }: { segments: Segment[]; interactive: boolean }) {
    const { t } = useI18n();
    return (
        <>
            {segments.map((seg, i) => {
                const body = seg.tokens.map((tk, j) => (
                    <React.Fragment key={j}>
                        {j > 0 && " "}
                        <span className={cn("whitespace-nowrap", TOKEN_CLASS[tk.kind])}>{tk.text}</span>
                    </React.Fragment>
                ));
                return (
                    <React.Fragment key={i}>
                        {i > 0 && " "}
                        {interactive && seg.explain ? (
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <span className="rounded px-0.5 -mx-0.5 cursor-help transition-colors hover:bg-white/10">{body}</span>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-xs text-xs">
                                    {t(seg.explain.key, seg.explain.vars)}
                                </TooltipContent>
                            </Tooltip>
                        ) : (
                            <span>{body}</span>
                        )}
                    </React.Fragment>
                );
            })}
        </>
    );
}

/** 主指令面板（含複製按鈕）。/ Main command panel with a copy button. */
export function CommandLine({ segments, title }: { segments: Segment[]; title?: string }) {
    const text = segmentsToString(segments);
    return (
        <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#0b1020] shadow-card">
            <div className="flex items-center justify-between gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-2">
                <span className="flex items-center gap-1.5" aria-hidden>
                    <span className="size-2.5 rounded-full bg-red-400/80" />
                    <span className="size-2.5 rounded-full bg-amber-400/80" />
                    <span className="size-2.5 rounded-full bg-emerald-400/80" />
                </span>
                {title && <span className="truncate text-[11px] font-medium text-slate-400">{title}</span>}
                <CopyButton text={text} />
            </div>
            <TooltipProvider delayDuration={120}>
                <pre className="whitespace-pre-wrap overflow-x-auto px-4 py-4 font-mono text-[13px] leading-relaxed text-slate-200">
                    <span className="select-none text-slate-500">$ </span>
                    <Tokens segments={segments} interactive />
                </pre>
            </TooltipProvider>
        </div>
    );
}

/** 單行小指令（測試 / 停止用），可複製。/ Small one-line copyable command (for tests / stopping). */
export function MiniCommand({ command }: { command: string }) {
    return (
        <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-[#0b1020] py-1.5 pl-3 pr-1.5">
            <code className="flex-1 min-w-0 overflow-x-auto whitespace-nowrap font-mono text-xs text-slate-200">
                <span className="select-none text-slate-500">$ </span>{command}
            </code>
            <CopyButton text={command} compact />
        </div>
    );
}

/** 速查表的一列：彩色 token、不帶 tooltip、可橫向捲動。/ A quick-reference row: coloured, no tooltips, scrolls sideways. */
export function InlineCommand({ segments }: { segments: Segment[] }) {
    const text = segmentsToString(segments);
    return (
        <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-[#0b1020] py-1.5 pl-3 pr-1.5 min-w-0">
            <code className="flex-1 min-w-0 overflow-x-auto whitespace-nowrap font-mono text-xs">
                <span className="select-none text-slate-500">$ </span>
                <Tokens segments={segments} interactive={false} />
            </code>
            <CopyButton text={text} compact />
        </div>
    );
}

/** 每一段的意思（與 tooltip 同一份資料）。/ What every segment means (same data as the tooltips). */
export function CommandLegend({ segments }: { segments: Segment[] }) {
    const { t } = useI18n();
    const explained = segments.filter((s) => s.explain);
    return (
        <dl className="divide-y divide-border rounded-xl border border-border bg-background/60">
            {explained.map((seg, i) => (
                <div key={i} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[minmax(0,13rem)_1fr] sm:gap-4">
                    <dt className="min-w-0">
                        <code className="inline-block max-w-full truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground" title={seg.tokens.map((tk) => tk.text).join(" ")}>
                            {seg.tokens.map((tk) => tk.text).join(" ")}
                        </code>
                    </dt>
                    <dd className="text-xs leading-relaxed text-muted-foreground">{t(seg.explain!.key, seg.explain!.vars)}</dd>
                </div>
            ))}
        </dl>
    );
}
