"use client";

/**
 * 步驟式的側欄分頁（放在 Modal 的 `nav` 槽）：每一步一個圓點——還沒到 = 編號、處理中 = 轉圈、要處理 = 琥珀色、做完 =
 * 綠色打勾；桌面上圓點之間有直線（做完的那段變綠），名稱下面一行目前的狀況；手機上是一列橫排（只有圓點與名稱）。
 * 搭配 `StepFooter`：左邊「完成 N / M」，右邊上一步 / 下一步。狀態的判斷在 `lib/stepTabs.ts`。
 * Step-style side tabs for Modal's `nav` slot: one dot per step — number = not reached, spinner = in progress,
 * amber = needs attention, green check = done; on desktop straight lines join the dots (green once a step is done)
 * and a status line sits under each name; phones get one row (dots and names only). `StepFooter` adds
 * "N of M done" plus back / next. States come from `lib/stepTabs.ts`.
 */
import * as React from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { doneCount, nextStep, prevStep, type StepState } from "@/lib/stepTabs";

export interface StepTab<T extends string> {
    value: T;
    label: React.ReactNode;
    state: StepState;
    /** 名稱下的一行狀況（桌面才有）。/ One status line under the name (desktop only). */
    status?: React.ReactNode;
}

const STATUS_TONE: Record<StepState, string> = {
    done: "text-success",
    working: "text-warning",
    attention: "text-warning",
    todo: "text-muted-foreground",
};

function StepDot({ n, state, active }: { n: number; state: StepState; active: boolean }) {
    const { t } = useI18n();
    const base = "relative z-10 grid size-6 shrink-0 place-items-center rounded-full text-xs tabular-nums [&_svg]:size-3.5";
    if (state === "done") {
        return (
            <span className={cn(base, "bg-success text-success-foreground", active && "ring-2 ring-success/30")} role="img" aria-label={t("ui.steps.stateDone")}>
                <Check strokeWidth={3} />
            </span>
        );
    }
    if (state === "working") {
        return (
            <span className={cn(base, "bg-card text-warning ring-1 ring-inset ring-warning/60")} role="img" aria-label={t("ui.steps.stateWorking")}>
                <Loader2 className="animate-spin" />
            </span>
        );
    }
    if (state === "attention") {
        return (
            <span className={cn(base, "bg-warning/15 text-warning ring-1 ring-inset ring-warning/60")} role="img" aria-label={t("ui.steps.stateAttention")}>
                <AlertTriangle />
            </span>
        );
    }
    return (
        <span className={cn(base, "bg-card ring-1 ring-inset", active ? "text-primary ring-primary" : "text-muted-foreground ring-border")} aria-hidden>
            {n}
        </span>
    );
}

export function StepTabs<T extends string>({ tabs, value, onChange, className, ...rest }: {
    tabs: StepTab<T>[];
    value: T;
    onChange: (value: T) => void;
    "aria-label"?: string;
    className?: string;
}) {
    return (
        <div role="tablist" aria-orientation="vertical" aria-label={rest["aria-label"]} className={cn("flex items-center gap-1 sm:flex-col sm:items-stretch sm:gap-1.5", className)}>
            {tabs.map((tab, i) => {
                const active = tab.value === value;
                const last = i === tabs.length - 1;
                return (
                    <div key={tab.value} className={cn("relative", active && "max-sm:min-w-0 max-sm:flex-1")}>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={active}
                            onClick={() => onChange(tab.value)}
                            className={cn(
                                "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                                active ? "bg-card ring-1 ring-border dark:bg-secondary max-sm:bg-muted max-sm:ring-0" : "hover:bg-muted/70",
                            )}
                        >
                            <StepDot n={i + 1} state={tab.state} active={active} />
                            {/* 手機上只有目前這一步顯示名稱，其他只剩圓點，整排一定放得下。/ Phones: only the current step shows its name. */}
                            <span className={cn("min-w-0 pt-0.5", !active && "max-sm:sr-only")}>
                                <span className={cn("block leading-snug", active || tab.state === "done" ? "text-foreground" : "text-muted-foreground")}>{tab.label}</span>
                                {tab.status && <span className={cn("mt-0.5 hidden text-xs leading-snug sm:block", STATUS_TONE[tab.state])}>{tab.status}</span>}
                            </span>
                        </button>
                        {/* 圓點之間的直線（桌面）：這一步做完就變綠。/ The line to the next dot (desktop), green once this step is done. */}
                        {!last && (
                            <span
                                aria-hidden
                                className={cn("pointer-events-none absolute -bottom-3 left-[1.375rem] top-8 hidden w-px sm:block", tab.state === "done" ? "bg-success/60" : "bg-border")}
                            />
                        )}
                    </div>
                );
            })}
        </div>
    );
}

/** 對話框底部：完成幾步 + 上一步 / 下一步（最後一步換成 `final`，例如關閉）。/ Footer: progress plus back / next. */
export function StepFooter<T extends string>({ tabs, value, onChange, final }: {
    tabs: StepTab<T>[];
    value: T;
    onChange: (value: T) => void;
    final?: React.ReactNode;
}) {
    const { t } = useI18n();
    const next = nextStep(tabs, value);
    const prev = prevStep(tabs, value);
    const nextTab = tabs.find((x) => x.value === next);
    const done = doneCount(tabs);
    return (
        <>
            {/* 手機上不顯示（上面的圓點已經看得出進度），按鈕列才放得進一行。/ Hidden on phones: the dots already show it. */}
            <span className={cn("mr-auto text-sm max-sm:hidden", done === tabs.length ? "text-success" : "text-muted-foreground")}>
                {done === tabs.length && <Check size={14} className="mr-1 inline align-[-2px]" aria-hidden />}
                {t("ui.steps.progress", { done, total: tabs.length })}
            </span>
            {prev && (
                <Button type="button" variant="outline" onClick={() => onChange(prev)} aria-label={t("ui.steps.back")} title={t("ui.steps.back")}>
                    <ArrowLeft />
                    {/* 手機上只剩箭頭。/ Just the arrow on phones. */}
                    <span className="max-sm:hidden">{t("ui.steps.back")}</span>
                </Button>
            )}
            {next && nextTab ? (
                <Button type="button" onClick={() => onChange(next)} className="max-sm:h-auto max-sm:min-h-9 max-sm:flex-1 max-sm:whitespace-normal">
                    {t("ui.steps.next", { step: typeof nextTab.label === "string" ? nextTab.label : "" })}
                    <ArrowRight />
                </Button>
            ) : (
                final
            )}
        </>
    );
}
