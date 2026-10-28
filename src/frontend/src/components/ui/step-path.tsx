"use client";

/**
 * 頁面用的步驟列（指令速查、CLI 頁的開始使用）：每一步一張可以點的小卡——狀態圓點（編號 / 綠勾 / 琥珀 / 轉圈）、
 * 圖示與名稱、下面一行目前的值；卡與卡之間是直線（前一步做完就變綠），線上可以標「走的是什麼」（例如 HTTPS、隧道），
 * 所以步驟列本身就是一張路徑圖。窄容器只剩一排圓點 + 目前這一步的名稱，一行放得下。
 * 下面接 `StepPanel`：一次只放目前這一步的內容，底部是上一步 / 下一步（`StepFooter`）。
 * A page-level step bar (command sheet, the CLI page's get-started): one clickable tile per step — a state dot
 * (number / green tick / amber / spinner), icon and name, and one line with its current value; straight links
 * join the tiles (green once the step before is done) and may say what travels along them (HTTPS, the tunnel),
 * so the bar doubles as a path diagram. A narrow container gets a row of dots plus the current step's name.
 * `StepPanel` below holds only the current step's content, with back / next (`StepFooter`).
 */
import * as React from "react";
import { AlertTriangle, Check, Loader2, type LucideIcon } from "lucide-react";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { StepFooter, type StepTab } from "@/components/ui/step-tabs";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { StepState } from "@/lib/stepTabs";

export interface PathStep<T extends string> {
    value: T;
    title: string;
    /** 名稱下的一行：這一步目前的值或狀況。/ One line under the name: the step's current value or state. */
    sub?: React.ReactNode;
    state: StepState;
    icon?: LucideIcon;
    /** Telepy 自己：品牌方塊。/ Telepy itself: the brand tile. */
    brand?: boolean;
}

function Dot({ n, state, active, size = "md" }: { n: number; state: StepState; active: boolean; size?: "md" | "lg" }) {
    const { t } = useI18n();
    const base = cn("grid shrink-0 place-items-center rounded-full tabular-nums", size === "lg" ? "size-7 text-sm [&_svg]:size-4" : "size-6 text-xs [&_svg]:size-3.5");
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
            <span className={cn(base, "bg-warning/15 text-warning ring-1 ring-inset ring-warning/60", active && "ring-2")} role="img" aria-label={t("ui.steps.stateAttention")}>
                <AlertTriangle />
            </span>
        );
    }
    return (
        <span className={cn(base, active ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground ring-1 ring-inset ring-border")} aria-hidden>
            {n}
        </span>
    );
}

function Glyph({ step }: { step: PathStep<string> }) {
    if (step.brand) {
        return (
            <span className="grid size-4 shrink-0 place-items-center rounded-[0.25rem] bg-brand-gradient text-white" aria-hidden>
                <TelepyGlyph size={11} />
            </span>
        );
    }
    const Icon = step.icon;
    return Icon ? <Icon size={15} className="shrink-0 text-muted-foreground" aria-hidden /> : null;
}

export function StepPath<T extends string>({ steps, value, onChange, links, panelId, className, ...rest }: {
    steps: PathStep<T>[];
    value: T;
    onChange: (value: T) => void;
    /** 第 i 步到第 i+1 步那條線上的字（沒有 = 只有線）。/ The label on the link after step i (none = a bare line). */
    links?: (React.ReactNode | null)[];
    /** 對應的 `StepPanel` id（aria-controls）。/ The matching `StepPanel` id. */
    panelId?: string;
    "aria-label"?: string;
    className?: string;
}) {
    const index = Math.max(0, steps.findIndex((s) => s.value === value));
    const active = steps[index];
    const labelled = (links ?? []).some(Boolean);
    return (
        <nav aria-label={rest["aria-label"]} className={cn("@container", className)}>
            {/* 寬：一列小卡，中間直線。/ Wide: a row of tiles joined by straight links. */}
            <div role="tablist" className="hidden items-stretch @3xl:flex">
                {steps.map((s, i) => {
                    const isActive = i === index;
                    const link = links?.[i] ?? null;
                    return (
                        <React.Fragment key={s.value}>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={isActive}
                                aria-controls={panelId}
                                onClick={() => onChange(s.value)}
                                className={cn(
                                    "flex min-w-0 flex-1 basis-0 items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                                    isActive ? "border-primary bg-primary/[0.04] ring-1 ring-primary" : "border-border bg-card hover:border-foreground/30",
                                )}
                            >
                                <Dot n={i + 1} state={s.state} active={isActive} />
                                <span className="min-w-0 flex-1 pt-0.5">
                                    <span className={cn("flex items-center gap-1.5 text-sm leading-snug", isActive || s.state === "done" ? "text-foreground" : "text-muted-foreground")}>
                                        <Glyph step={s} />
                                        <span className="min-w-0">{s.title}</span>
                                    </span>
                                    {s.sub && (
                                        <span className={cn("mt-0.5 block text-xs leading-snug [overflow-wrap:anywhere]", s.state === "attention" ? "text-warning" : "text-muted-foreground")}>{s.sub}</span>
                                    )}
                                </span>
                            </button>
                            {i < steps.length - 1 && (
                                <span className={cn("flex shrink-0 flex-col items-center justify-center gap-1 px-1", labelled ? "w-24" : "w-8")} aria-hidden={!link}>
                                    <span className={cn("h-px w-full", s.state === "done" ? "bg-success/60" : "bg-border")} />
                                    {link && <span className="text-center text-xs leading-tight text-muted-foreground">{link}</span>}
                                </span>
                            )}
                        </React.Fragment>
                    );
                })}
            </div>
            {/* 窄：一排圓點 + 目前這一步。/ Narrow: a row of dots plus the current step. */}
            {/* 放不下名稱時（窄手機、放大顯示）名稱換到圓點下面一行，不擠成一字一行。/ The name drops below the dots when it can't fit. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 @3xl:hidden">
                <div role="tablist" className="flex shrink-0 items-center">
                    {steps.map((s, i) => (
                        <React.Fragment key={s.value}>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={i === index}
                                aria-controls={panelId}
                                aria-label={s.title}
                                title={s.title}
                                onClick={() => onChange(s.value)}
                                className="rounded-full p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                            >
                                <Dot n={i + 1} state={s.state} active={i === index} size="lg" />
                            </button>
                            {i < steps.length - 1 && <span className={cn("h-px w-3", s.state === "done" ? "bg-success/60" : "bg-border")} aria-hidden />}
                        </React.Fragment>
                    ))}
                </div>
                {active && (
                    <span className="min-w-0 flex-1 basis-40">
                        <span className="flex items-center gap-1.5 text-sm leading-snug text-foreground">
                            <Glyph step={active} />
                            <span className="min-w-0">{active.title}</span>
                        </span>
                        {active.sub && <span className={cn("block text-xs leading-snug [overflow-wrap:anywhere]", active.state === "attention" ? "text-warning" : "text-muted-foreground")}>{active.sub}</span>}
                    </span>
                )}
            </div>
        </nav>
    );
}

/**
 * 目前這一步的內容：標題 + 一行說明、內容、底部上一步 / 下一步。
 * The current step's content: heading and one line, the body, then back / next.
 */
export function StepPanel<T extends string>({ id, steps, value, onChange, title, description, actions, final, children }: {
    id?: string;
    steps: PathStep<T>[];
    value: T;
    onChange: (value: T) => void;
    title: React.ReactNode;
    description?: React.ReactNode;
    /** 標題右邊的控制項。/ Controls beside the heading. */
    actions?: React.ReactNode;
    /** 最後一步的按鈕（沒有「下一步」時）。/ The last step's button (instead of next). */
    final?: React.ReactNode;
    children: React.ReactNode;
}) {
    const tabs: StepTab<T>[] = steps.map((s) => ({ value: s.value, label: s.title, state: s.state }));
    return (
        <section id={id} role="tabpanel" aria-label={typeof title === "string" ? title : undefined} className="rounded-xl border border-border bg-card text-card-foreground shadow-card">
            <div className="space-y-5 p-4 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                    <div className="min-w-0 flex-1 basis-72 space-y-1">
                        <h2 className="text-lg leading-snug text-foreground">{title}</h2>
                        {description && <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>}
                    </div>
                    {actions}
                </div>
                {children}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3 sm:px-6">
                {/* 進度看上面的步驟列就好，這裡不再數一次。/ The step bar above shows progress; no second count here. */}
                <StepFooter tabs={tabs} value={value} onChange={onChange} final={final} progress={false} />
            </div>
        </section>
    );
}
