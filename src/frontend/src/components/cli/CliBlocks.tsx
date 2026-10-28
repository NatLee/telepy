"use client";

/**
 * CLI 頁的小積木：一行指令（等寬 + 複製）、範例需要什麼的小標籤、終端機輸出的樣子（左邊可以放一張圖：
 * 真的 CLI 在 `login` / `doctor` 旁邊畫 Tapi）。
 * Small blocks of the CLI page: one command (mono + copy), the chips saying what an example needs, and what a
 * terminal prints (art on the left: the real CLI draws Tapi beside `login` / `doctor`).
 */
import React from "react";
import { KeyRound, Ticket } from "lucide-react";
import { CopyButton } from "@/components/ui/CopyButton";
import { Chip } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { LOGIN_SCOPES, type CliNeed, type OutputLine } from "@/lib/cliGuide";

/**
 * 指令的字：在空白處換行；每個片段是一個 inline-block，所以 `--online`、`[--group` 不會從連字號切開，
 * 只有比一行還寬的片段（網址、放大顯示時）才在裡面換行。
 * 選取 / 複製到的字跟原本一樣（只是包了 span）。
 * A command's text: wraps at spaces; each token is an inline-block, so `--online` / `[--group` never break at their
 * hyphens, and only a token wider than the line (a URL, a large display size) wraps inside. Selecting / copying gives the original text (spans only).
 */
export function CommandText({ value }: { value: string }) {
    return (
        <>
            {value.split("\n").map((line, i) => (
                <span key={i} className="block">
                    {line.split(" ").map((tok, j) => (
                        <React.Fragment key={j}>
                            {j > 0 && " "}
                            <span className="inline-block max-w-full [overflow-wrap:anywhere]">{tok}</span>
                        </React.Fragment>
                    ))}
                </span>
            ))}
        </>
    );
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
                const extra = !LOGIN_SCOPES.includes(need);
                return (
                    <Chip key={need} tone={extra ? "warning" : "neutral"} title={extra ? t("cli.need.addScopeHint") : undefined}>
                        <span className="font-mono">{need}</span>
                        {extra && <> · {t("cli.need.addScope")}</>}
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
