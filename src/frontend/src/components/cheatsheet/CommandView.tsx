"use client";

/**
 * 指令顯示：一條大的指令列（複製按鈕很明顯）、像 explainshell 那樣「每一段底下標註意思」的拆解圖、速查表用的小列。
 * Command display: one big command bar with an obvious Copy button, an explainshell-style breakdown that labels
 * every part right under it, and compact rows for the quick reference.
 */
import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { SHORT_LABEL, segmentsToString, type Segment, type TokenKind } from "@/lib/forwardRecipes";

const TOKEN_CLASS: Record<TokenKind, string> = {
    cmd: "text-success font-semibold",
    flag: "text-sky-400",
    value: "text-warning",
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

function CopyButton({ text, big = false }: { text: string; big?: boolean }) {
    const { t } = useI18n();
    const { copied, copy } = useCopy(text);
    return (
        <button
            type="button"
            onClick={copy}
            title={t("ui.copyToClipboard")}
            aria-label={t("ui.copyToClipboard")}
            className={cn(
                "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium transition-all",
                big ? "h-10 px-4 text-sm" : "p-1.5 text-xs",
                big
                    ? copied ? "bg-success text-success-foreground" : "bg-primary text-primary-foreground hover:bg-primary/90"
                    : copied ? "bg-success/15 text-success" : "bg-white/10 text-slate-200 hover:bg-white/20"
            )}
        >
            {copied ? <Check size={big ? 16 : 14} /> : <Copy size={big ? 16 : 14} />}
            {big && (copied ? t("common.copied") : t("common.copy"))}
        </button>
    );
}

/**
 * `wrap`：長 token（例如 `-J user@host:port,user@localhost:port`）比框還寬時在框內斷行。以前每個 token 都是
 * nowrap，長的就被框切掉（網路頁的主機面板在手機上只看得到半條指令）。單行的速查列（InlineCommand）仍然不斷行、橫向捲動。
 * `wrap`: a token longer than the box (e.g. `-J user@host:port,user@localhost:port`) breaks inside it. Every token
 * used to be nowrap, so long ones were cut off by the box (half a command on the network page's host panel on a
 * phone). The one-line quick-reference rows (InlineCommand) still stay on one line and scroll sideways.
 */
/** 逗號後面可以斷行（`-J a,b` 的跳板鏈先在逗號斷，不在數字中間斷）。/ A break opportunity after each comma (jump chains break there first). */
function Breakable({ text }: { text: string }) {
    const parts = text.split(/(?<=,)/);
    return <>{parts.map((p, i) => <React.Fragment key={i}>{i > 0 && <wbr />}{p}</React.Fragment>)}</>;
}

function Tokens({ segments, wrap = false }: { segments: Segment[]; wrap?: boolean }) {
    return (
        <>
            {segments.map((seg, i) => (
                <React.Fragment key={i}>
                    {i > 0 && " "}
                    {seg.tokens.map((tk, j) => (
                        <React.Fragment key={j}>
                            {j > 0 && " "}
                            <span className={cn(!wrap && "whitespace-nowrap", TOKEN_CLASS[tk.kind])}>{wrap ? <Breakable text={tk.text} /> : tk.text}</span>
                        </React.Fragment>
                    ))}
                </React.Fragment>
            ))}
        </>
    );
}

/** 主指令列：只有指令和一顆大大的複製鈕。/ The main command bar: just the command and a big Copy button. */
export function CommandBar({ segments }: { segments: Segment[] }) {
    const text = segmentsToString(segments);
    return (
        <div className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-[#0b1020] p-3 pl-4 shadow-card sm:flex-row sm:items-center">
            <pre className="min-w-0 flex-1 whitespace-pre-wrap py-1 font-mono text-[1rem] leading-relaxed text-slate-200 [overflow-wrap:anywhere]">
                <span className="select-none text-slate-500">$ </span>
                <Tokens segments={segments} wrap />
            </pre>
            <CopyButton text={text} big />
        </div>
    );
}

/** 單行小指令（測試 / 停止用）。/ Small one-line copyable command (tests / stopping). */
export function MiniCommand({ command }: { command: string }) {
    return (
        <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-[#0b1020] py-1.5 pl-3 pr-1.5">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-slate-200">
                <span className="select-none text-slate-500">$ </span>{command}
            </code>
            <CopyButton text={command} />
        </div>
    );
}

/** 速查表的一列：彩色、可橫向捲動。/ A quick-reference row: coloured, scrolls sideways. */
export function InlineCommand({ segments }: { segments: Segment[] }) {
    return (
        <div className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-800 bg-[#0b1020] py-1.5 pl-3 pr-1.5">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs">
                <span className="select-none text-slate-500">$ </span>
                <Tokens segments={segments} />
            </code>
            <CopyButton text={segmentsToString(segments)} />
        </div>
    );
}

const PART_COLORS = [
    { text: "text-success", bar: "bg-success" },
    { text: "text-sky-400", bar: "bg-sky-400" },
    { text: "text-warning", bar: "bg-warning" },
    { text: "text-violet-300", bar: "bg-violet-300" },
    { text: "text-pink-300", bar: "bg-pink-300" },
    { text: "text-teal-300", bar: "bg-teal-300" },
];

/**
 * 拆解圖：指令的每一段各一個顏色，底下一條色條 + 幾個字的意思（滑過看完整說明）。
 * Breakdown: each part of the command in its own colour with a bar and a few words underneath (hover for more).
 * 每一段最寬就是框寬，太長的那段在段內斷行。以前一段比框寬時置中排版會把它往左右兩邊推出框外，左邊那截連捲動都捲不到。
 * A part is at most as wide as the box and a longer one wraps inside it. A part wider than the box used to be
 * pushed out on both sides by the centring, and its left end could not even be scrolled to.
 */
export function AnnotatedCommand({ segments }: { segments: Segment[] }) {
    const { t } = useI18n();
    return (
        <div className="min-w-0 rounded-xl border border-slate-800 bg-[#0b1020] p-4 sm:p-5">
            <div className="flex flex-wrap items-start gap-x-4 gap-y-5">
                {segments.map((seg, i) => {
                    const color = PART_COLORS[i % PART_COLORS.length];
                    const short = seg.explain ? SHORT_LABEL[seg.explain.key] : undefined;
                    return (
                        <div key={i} className="flex min-w-0 max-w-full flex-col items-center" title={seg.explain ? t(seg.explain.key, seg.explain.vars) : undefined}>
                            <span className={cn("max-w-full text-center font-mono text-sm [overflow-wrap:anywhere]", color.text)}><Breakable text={seg.tokens.map((tk) => tk.text).join(" ")} /></span>
                            <span className={cn("mt-1.5 h-[3px] w-full min-w-6 rounded-full", color.bar)} aria-hidden />
                            {short && (
                                <span className="mt-1.5 max-w-[11rem] text-center text-[0.75rem] leading-snug text-slate-300">
                                    {t(short, seg.explain!.vars)}
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
