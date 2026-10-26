"use client";

/**
 * 路徑圖的積木：節點（你的瀏覽器 / Telepy / 裝置 / 目標）與直線（兩節點之間的那一段）。遠端桌面與終端機的
 * 「現在在做什麼」圖、以及兩頁的連線選擇器都用它畫：直線與直角、平面樣式、寬容器橫排、窄容器直排。
 * 節點可以放控制項（選單、輸入框）：選擇器就是把選項放進對應的節點，讓人一眼看出「這一站可以選」。
 * Building blocks for the path diagrams: nodes (your browser / Telepy / device / target) and the straight links
 * between them. Used by the live "what is happening" diagrams and by the connect pickers on the terminal and
 * desktop pages. Straight lines only, flat styling, horizontal in a wide container, vertical in a narrow one.
 * A node can hold controls (selects, inputs): the pickers put each choice inside the node it belongs to.
 */
import React from "react";
import { CheckCircle2, CircleDashed, Loader2, XCircle, type LucideIcon } from "lucide-react";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import type { SpotState } from "@/lib/flow";
import type { TranslationKey } from "@/locales/en";

export const STATE_TEXT: Record<SpotState, TranslationKey> = {
    waiting: "flow.state.waiting",
    active: "flow.state.active",
    ok: "flow.state.ok",
    failed: "flow.state.failed",
};

const STATE_ICON: Record<SpotState, LucideIcon> = { waiting: CircleDashed, active: Loader2, ok: CheckCircle2, failed: XCircle };

export const STATE_TONE: Record<SpotState, string> = {
    waiting: "text-muted-foreground",
    active: "text-primary",
    ok: "text-success",
    failed: "text-destructive",
};

const NODE_BORDER: Record<SpotState, string> = {
    waiting: "border-border",
    active: "border-primary/60",
    ok: "border-success/50",
    failed: "border-destructive/70",
};

/** 一行狀態：圖示 + 文字（預設文字依狀態，可換成「線上 / 離線」這類）。/ One status line; the text can be overridden. */
export function StateLine({ state, text, className }: { state: SpotState; text?: string; className?: string }) {
    const { t } = useI18n();
    const Icon = STATE_ICON[state];
    return (
        <span className={cn("inline-flex items-center gap-1 text-xs", STATE_TONE[state], className)}>
            <Icon size={13} className={state === "active" ? "animate-spin" : undefined} aria-hidden />
            {text ?? t(STATE_TEXT[state])}
        </span>
    );
}

/** 橫排 / 直排的容器（container query）。/ The row / column container. */
export function FlowPath({ children, className, stretch = false }: { children: React.ReactNode; className?: string; stretch?: boolean }) {
    return (
        <div className={cn("@container", className)}>
            <ol className={cn("flex flex-col items-stretch @3xl:flex-row", stretch ? "@3xl:items-stretch" : "@3xl:items-center")}>{children}</ol>
        </div>
    );
}

interface FlowNodeProps {
    icon?: LucideIcon;
    /** Telepy 自己：品牌方塊。/ Telepy itself: the brand tile. */
    brand?: boolean;
    title: React.ReactNode;
    sub?: React.ReactNode;
    state?: SpotState;
    /** 狀態行的文字（預設依狀態）。/ The status line's text (defaults to the state). */
    stateText?: string;
    /** 放進節點的控制項（選單、輸入框）；有它時節點改成左對齊、標題在圖示旁邊。/ Controls inside the node (left-aligned layout). */
    control?: React.ReactNode;
    /** 橫排時佔兩份寬（放控制項的節點）。/ Twice the width in the row (nodes with controls). */
    wide?: boolean;
    className?: string;
}

export function FlowNode({ icon, brand, title, sub, state = "waiting", stateText, control, wide = false, className }: FlowNodeProps) {
    const Icon = icon;
    const tile = (size: string, iconSize: number) => (
        <span className={cn("grid shrink-0 place-items-center rounded-lg", size, brand ? "bg-brand-gradient text-white" : "bg-muted text-foreground")} aria-hidden>
            {brand ? <TelepyGlyph size={iconSize + 2} /> : Icon ? <Icon size={iconSize} /> : null}
        </span>
    );
    if (control) {
        return (
            <li className={cn("flex min-w-0 flex-col gap-2.5 rounded-xl border bg-card p-3 @3xl:basis-0", wide ? "@3xl:flex-[2_1_0%]" : "@3xl:flex-1", NODE_BORDER[state], className)}>
                <div className="flex items-start gap-2.5">
                    {tile("size-8", 16)}
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                            <span className="min-w-0 truncate text-sm text-foreground">{title}</span>
                            <StateLine state={state} text={stateText} />
                        </div>
                        {sub && <span className="block text-xs leading-snug text-muted-foreground">{sub}</span>}
                    </div>
                </div>
                <div className="min-w-0">{control}</div>
            </li>
        );
    }
    return (
        <li className={cn("flex min-w-0 flex-col items-center gap-1.5 rounded-xl border bg-card px-3 py-3 text-center @3xl:basis-0", wide ? "@3xl:flex-[2_1_0%]" : "@3xl:flex-1", NODE_BORDER[state], className)}>
            {tile("size-10", 20)}
            <span className="max-w-full truncate text-sm text-foreground" title={typeof title === "string" ? title : undefined}>{title}</span>
            {sub && <span className="text-xs leading-snug text-muted-foreground">{sub}</span>}
            <StateLine state={state} text={stateText} />
        </li>
    );
}

interface FlowLinkProps {
    label: React.ReactNode;
    state?: SpotState;
    /** 線下方的數字（往返時間）。/ A figure under the label (round trip). */
    note?: string;
    /** 這段是最慢的。/ This hop is the slow one. */
    slow?: boolean;
    className?: string;
}

/** 兩節點之間的直線：待命 = 短虛線、進行中 / 通了 = 流動的虛線、失敗 = 點線。/ The straight link between two nodes. */
export function FlowLink({ label, state = "waiting", note, slow, className }: FlowLinkProps) {
    const motion = !useReducedMotion();
    const animate = motion && (state === "active" || state === "ok");
    const dash = state === "waiting" ? "4 5" : state === "failed" ? "2 6" : "7 5";
    const line = (vertical: boolean) => (
        <svg
            className={cn(vertical ? "h-10 w-3 @3xl:hidden" : "hidden h-3 w-full @3xl:block", STATE_TONE[state])}
            viewBox={vertical ? "0 0 6 100" : "0 0 100 6"}
            preserveAspectRatio="none"
            aria-hidden
        >
            <line x1={vertical ? 3 : 0} y1={vertical ? 0 : 3} x2={vertical ? 3 : 100} y2={vertical ? 100 : 3} stroke="currentColor" strokeWidth={2} strokeDasharray={dash} vectorEffect="non-scaling-stroke">
                {animate && <animate attributeName="stroke-dashoffset" values={state === "active" ? "24;0" : "48;0"} dur={state === "active" ? "0.8s" : "2s"} repeatCount="indefinite" />}
            </line>
        </svg>
    );
    return (
        <li className={cn("flex min-w-0 flex-row items-center gap-3 px-6 @3xl:w-24 @3xl:shrink-0 @3xl:flex-col @3xl:gap-1 @3xl:px-1.5 @3xl:self-center", className)}>
            {line(true)}
            {line(false)}
            <span className={cn("text-xs leading-tight @3xl:text-center", state === "failed" ? "text-destructive" : "text-muted-foreground")}>
                {state === "failed" && <XCircle size={12} className="mr-1 inline-block align-[-2px]" aria-hidden />}
                {label}
                {note && <span className={cn("block font-mono tabular-nums", slow ? "text-warning" : "text-foreground")}>{note}</span>}
            </span>
        </li>
    );
}

/** 步驟清單：目前那一步亮起、失敗的標紅、做完的打勾。/ The numbered step list under a diagram. */
export function FlowSteps({ steps, current, done, failed }: { steps: React.ReactNode[]; current: number; done: boolean; failed: boolean }) {
    return (
        <ol className="space-y-2">
            {steps.map((text, i) => {
                const n = i + 1;
                const isCurrent = n === current;
                const isDone = current > n || done;
                const failedHere = isCurrent && failed;
                return (
                    <li
                        key={n}
                        className={cn(
                            "flex gap-3 rounded-md border px-3 py-2 text-sm leading-relaxed",
                            failedHere ? "border-destructive/50 bg-destructive/5" : isCurrent ? "border-primary/50 bg-primary/5" : "border-transparent",
                        )}
                        aria-current={isCurrent ? "step" : undefined}
                    >
                        <span
                            className={cn(
                                "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-xs tabular-nums",
                                failedHere ? "bg-destructive text-destructive-foreground" : isDone ? "bg-success text-success-foreground" : isCurrent ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                            )}
                            aria-hidden
                        >
                            {n}
                        </span>
                        <span className={isCurrent || isDone ? "text-foreground" : "text-muted-foreground"}>{text}</span>
                    </li>
                );
            })}
        </ol>
    );
}

/** 圖上方的「現在」一行。/ The "right now" status line above a diagram. */
export function FlowNow({ failed, children }: { failed: boolean; children: React.ReactNode }) {
    return (
        <p className={cn("rounded-md border px-3 py-2 text-sm", failed ? "border-destructive/40 bg-destructive/5 text-destructive" : "border-border bg-surface text-foreground")} role="status">
            {children}
        </p>
    );
}
