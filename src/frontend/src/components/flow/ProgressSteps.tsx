"use client";

/**
 * 「一步步做」的清單：編號、名稱、一行說明（還沒做 = 會怎麼做，做完 = 結果），進行中的那步框起來、轉圈，等待中的步驟
 * 有倒數條（「最多 25 秒」），略過的變淡。步驟裡可以放控制項（開關、選單）：開始之前就是選項，開始之後同一張清單即時亮起來。
 * 狀態由 `lib/progressSteps.ts` 的 `stepViews` 算；文字由呼叫的人給。
 * A step-by-step list: number, name, one line (what it will do before, the result after), the step in progress framed
 * with a spinner, a countdown bar for steps that wait ("up to 25 s"), skipped steps faded. A step can hold controls
 * (switches, selects): before the start they are the options, afterwards the same list lights up live. States come from
 * `stepViews` in `lib/progressSteps.ts`; the caller supplies the text.
 */
import React from "react";
import { CheckCircle2, CircleDashed, CircleMinus, Loader2, TriangleAlert, XCircle, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/useNow";
import { countdown, type StepEvent, type StepState } from "@/lib/progressSteps";
import type { TranslationKey } from "@/locales/en";

const ICON: Record<StepState, LucideIcon> = { waiting: CircleDashed, active: Loader2, done: CheckCircle2, warn: TriangleAlert, failed: XCircle, skipped: CircleMinus };

const TONE: Record<StepState, string> = {
    waiting: "text-muted-foreground",
    active: "text-primary",
    done: "text-success",
    warn: "text-warning",
    failed: "text-destructive",
    skipped: "text-muted-foreground",
};

export const STEP_STATE_TEXT: Record<StepState, TranslationKey> = {
    waiting: "steps.state.waiting",
    active: "steps.state.active",
    done: "steps.state.done",
    warn: "steps.state.warn",
    failed: "steps.state.failed",
    skipped: "steps.state.skipped",
};

/** 一步的狀態行：圖示 + 文字。/ A step's state: icon + text. */
export function StepStateLine({ state, text, className }: { state: StepState; text?: string; className?: string }) {
    const { t } = useI18n();
    const Icon = ICON[state];
    return (
        <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs", TONE[state], className)}>
            <Icon size={13} className={state === "active" ? "animate-spin" : undefined} aria-hidden />
            {text ?? t(STEP_STATE_TEXT[state])}
        </span>
    );
}

export interface ProgressStep {
    id: string;
    state: StepState;
    title: React.ReactNode;
    /** 一行：會怎麼做 / 為什麼略過 / 結果。/ One line: the plan, why skipped, or the result. */
    line?: React.ReactNode;
    /** 等待的倒數（active 時）。/ The wait's countdown while active. */
    event?: Pick<StepEvent, "secs" | "at">;
    /** 標題旁的小東西（說明按鈕）。/ Something small beside the title (a help button). */
    aside?: React.ReactNode;
    /** 放在右邊、取代狀態行的控制項（開始前的開關）。/ A control on the right instead of the state (a switch before the start). */
    control?: React.ReactNode;
    /** 步驟裡的控制項或細節。/ Controls or details inside the step. */
    children?: React.ReactNode;
}

/** 進行中那步的倒數條。/ The countdown bar of the step in progress. */
function Countdown({ event }: { event: Pick<StepEvent, "secs" | "at"> }) {
    const { t } = useI18n();
    const now = useNow(500);
    const c = countdown(event, now);
    if (!c) return null;
    return (
        <div className="mt-1.5 flex items-center gap-2" role="timer">
            <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                <span className="block h-full rounded-full bg-primary transition-[width] duration-500 ease-linear" style={{ width: `${Math.round(c.progress * 100)}%` }} />
            </span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{t("steps.countdown", { elapsed: c.elapsed, secs: event.secs ?? 0 })}</span>
        </div>
    );
}

/**
 * `planning`：還沒開始，「待命」不顯示（每一步都待命只是雜訊），只標出略過的。
 * `planning`: not started yet; "waiting" is not shown (every step waits, it is noise), only skipped ones are marked.
 */
export function ProgressSteps({ steps, planning = false, className, "aria-label": label }: { steps: ProgressStep[]; planning?: boolean; className?: string; "aria-label"?: string }) {
    return (
        <ol className={cn("space-y-1.5", className)} aria-label={label}>
            {steps.map((s, i) => {
                const active = s.state === "active";
                const bad = s.state === "failed";
                const faded = s.state === "skipped";
                return (
                    <li
                        key={s.id}
                        aria-current={active ? "step" : undefined}
                        className={cn(
                            "flex gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                            bad ? "border-destructive/50 bg-destructive/5" : active ? "border-primary/50 bg-primary/5" : s.state === "warn" ? "border-warning/40" : "border-border",
                        )}
                    >
                        <span
                            className={cn(
                                "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-xs tabular-nums",
                                bad ? "bg-destructive text-destructive-foreground" : s.state === "done" ? "bg-success text-success-foreground" : s.state === "warn" ? "bg-warning text-warning-foreground" : active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                            )}
                            aria-hidden
                        >
                            {i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                                <span className={cn("flex min-w-0 items-center gap-1.5 text-sm", faded ? "text-muted-foreground" : "text-foreground")}>
                                    {s.title}
                                    {s.aside}
                                </span>
                                {s.control ?? (planning && s.state === "waiting" ? null : <StepStateLine state={s.state} />)}
                            </div>
                            {s.line && <p className={cn("mt-0.5 text-xs leading-relaxed", s.state === "warn" ? "text-warning" : bad ? "text-destructive" : "text-muted-foreground")}>{s.line}</p>}
                            {active && s.event && <Countdown event={s.event} />}
                            {s.children && <div className="mt-2">{s.children}</div>}
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}

/** 卡住時的「等多久了」：跑著的整件事已經過了幾秒。/ How long the whole run has taken so far. */
export function Elapsed({ since }: { since: number }) {
    const { t } = useI18n();
    const now = useNow(1000);
    return <span className="tabular-nums">{t("steps.elapsed", { secs: Math.max(0, Math.floor((now - since) / 1000)) })}</span>;
}

