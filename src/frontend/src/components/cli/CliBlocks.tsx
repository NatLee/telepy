"use client";

/**
 * CLI 頁的小積木：一行指令（等寬 + 複製）、範例需要什麼的小標籤、終端機輸出的樣子（左邊可以放一張圖：
 * 真的 CLI 在 `login` / `doctor` 旁邊畫 Tapi）。
 * Small blocks of the CLI page: one command (mono + copy), the chips saying what an example needs, and what a
 * terminal prints (art on the left: the real CLI draws Tapi beside `login` / `doctor`).
 */
import React, { useState } from "react";
import { KeyRound, Ticket } from "lucide-react";
import { CopyButton } from "@/components/ui/CopyButton";
import { Chip } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ShellText } from "@/components/ui/shell-text";
import { CLI_SUBCOMMANDS, outputLines, type CliNeed, type OutputLine } from "@/lib/cliGuide";

/**
 * 指令的字：上色、在空白處換行（`ShellText`，子指令照 `telepy` 的指令樹）。
 * A command's text: coloured and wrapping at spaces (`ShellText`, subcommands from telepy's command tree).
 */
export function CommandText({ value, synopsis = false }: { value: string; synopsis?: boolean }) {
    return <ShellText value={value} tree={CLI_SUBCOMMANDS} synopsis={synopsis} />;
}

/** 一行（或幾行）指令：等寬、會換行、右邊複製。/ A command: mono, wrapping, copy on the right. */
export function CommandLine({ value, className }: { value: string; className?: string }) {
    return (
        <div className={cn("flex min-w-0 items-start gap-1 rounded-lg bg-surface py-1 pl-3 pr-1 ring-1 ring-inset ring-border/80", className)}>
            <code className="min-w-0 flex-1 py-1 font-mono text-sm leading-relaxed text-foreground">
                <CommandText value={value} />
            </code>
            <CopyButton value={value} />
        </div>
    );
}

/** 範例需要的東西：scope（瀏覽器登入預設沒有的標出來）、SSH 金鑰、只有 API token。/ What an example needs. */
export function NeedChips({ needs }: { needs: CliNeed[] }) {
    const { t } = useI18n();
    if (needs.length === 0) return null;
    return (
        <span className="flex flex-wrap items-center gap-1">
            {needs.map((need) => {
                if (need === "ssh-key")
                    return (
                        <Chip key={need} tone="primary" title={t("cli.need.sshKeyHint")}>
                            <KeyRound aria-hidden />
                            {t("cli.need.sshKey")}
                        </Chip>
                    );
                if (need === "tunnels:manage")
                    return (
                        <Chip key={need} tone="warning" title={t("cli.need.tokenOnlyHint")}>
                            <Ticket aria-hidden />
                            <span className="font-mono">{need}</span> · {t("cli.need.tokenOnly")}
                        </Chip>
                    );
                return (
                    <Chip key={need} tone="neutral">
                        <span className="font-mono">{need}</span>
                    </Chip>
                );
            })}
        </span>
    );
}

/**
 * 終端機印出來的樣子（固定深色，跟 CodeBlock 一樣）；`art` 放在左邊，手機上疊在上面。
 * What a terminal prints (always dark, like CodeBlock); `art` sits on the left, above on phones.
 */
export function CliTerminal({ lines, art, label }: { lines: OutputLine[]; art?: React.ReactNode; label: string }) {
    return (
        <figure className="overflow-hidden rounded-lg bg-[oklch(0.2_0.012_260)] ring-1 ring-black/10 dark:bg-[oklch(0.14_0.01_260)] dark:ring-white/10" aria-label={label}>
            <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
                {art && <div className="shrink-0 self-start sm:self-center">{art}</div>}
                {/* 跟真的終端機一樣換行，手機上也看得到整行。/ Wraps like a real terminal, so phones see the whole line. */}
                <pre className="min-w-0 flex-1 whitespace-pre-wrap font-mono text-[0.8125rem] leading-relaxed text-white/85 [overflow-wrap:anywhere]">
                    {lines.map((l, i) => (
                        <span key={i} className={cn("block", l.tone === "prompt" && "text-white", l.tone === "muted" && "text-white/50", l.tone === "ok" && "text-[oklch(0.82_0.13_150)]")}>
                            {l.tone === "prompt" ? `$ ${l.text}` : l.text || " "}
                        </span>
                    ))}
                </pre>
            </div>
        </figure>
    );
}

const OUTPUT_FOLD = 16;
/** 表格那樣的行（欄位之間兩個以上的空白）不折，其他的照寬度折行。/ A table-like line (columns two or more spaces apart) never wraps; other lines wrap. */
const TABULAR = /\S {2,}\S/;

/**
 * 範例輸出：指令底下「跑起來長這樣」的終端機畫面。超過 16 行先收起來（一顆按鈕展開），頁面才不會被長輸出撐開；
 * 表格那種寬的輸出不折行、橫向捲（折了欄位就對不齊）。內容是真的跑出來的，名稱是示意的——標題那行說了。
 * Sample output: the terminal under a command showing what a run looks like. More than 16 lines start folded (one
 * button opens them) so long output doesn't stretch the page; wide table output scrolls sideways instead of wrapping
 * (wrapped columns no longer line up). It comes from a real run with sample names, as the caption says.
 */
export function ExampleOutput({ output, className }: { output: readonly string[]; className?: string }) {
    const { t } = useI18n();
    const [open, setOpen] = useState(false);
    if (output.length === 0) return null;
    const lines = outputLines(output);
    const folded = !open && lines.length > OUTPUT_FOLD;
    const shown = folded ? lines.slice(0, OUTPUT_FOLD / 2) : lines;
    return (
        <figure className={cn("overflow-hidden rounded-lg bg-[oklch(0.2_0.012_260)] ring-1 ring-black/10 dark:bg-[oklch(0.14_0.01_260)] dark:ring-white/10", className)}>
            <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 pt-2 text-xs text-white/50">
                <span>{t("cli.ex.output")}</span>
                <span>{t("cli.ex.outputHint")}</span>
            </figcaption>
            <pre className="overflow-x-auto px-3 py-2 font-mono text-[0.8125rem] leading-relaxed text-white/85">
                {shown.map((l, i) => (
                    <span key={i} className={cn("block", TABULAR.test(l.text) ? "whitespace-pre" : "whitespace-pre-wrap [overflow-wrap:anywhere]", l.tone === "prompt" && "text-white")}>
                        {l.tone === "prompt" ? `$ ${l.text}` : l.text || " "}
                    </span>
                ))}
            </pre>
            {lines.length > OUTPUT_FOLD && (
                <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="block w-full border-t border-white/10 px-3 py-1.5 text-left text-xs text-white/70 hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40">
                    {open ? t("cli.ex.outputLess") : t("cli.ex.outputMore", { count: lines.length })}
                </button>
            )}
        </figure>
    );
}
