/**
 * 建立精靈的進度列。每一步是一張卡片：做完的步驟顯示摘要（裝置名稱、帳號、是否已上線…）與「修改」筆形圖示，
 * 一看就知道可以點回去；之後的修改讓做過的步驟需要重看時，掛上琥珀色「需重新確認」徽章並說明原因。
 * 容器窄時（container query）縮成一排實心圓點（線不會穿過圓點），下方寫出目前步驟與待確認的步驟。
 *
 * Wizard progress. Each step is a card: finished steps show a summary (device name, accounts, online…) and a pencil
 * "edit" icon, so it is obvious they can be reopened; when a later change sends a finished step back for review it
 * gets an amber "check again" badge with the reason. In a narrow container it collapses into a row of solid dots (the
 * track never shows through them) with the current step and anything to review spelled out below.
 */
"use client";

import React from "react";
import { AlertTriangle, Cable, Check, ChevronRight, Cpu, KeyRound, Pencil, ShieldCheck, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Callout } from "@/components/ui/callout";
import { useI18n, type Translate } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import type { CreateTunnelWizard, ReviewReason, WizardStep } from "@/hooks/useCreateTunnelWizard";

export const WIZARD_STEPS: { id: WizardStep; icon: LucideIcon; title: TranslationKey; hint: TranslationKey }[] = [
    { id: 1, icon: Cpu, title: "wizard.step.device", hint: "wizard.step.deviceHint" },
    { id: 2, icon: Users, title: "wizard.step.accounts", hint: "wizard.step.accountsHint" },
    { id: 3, icon: KeyRound, title: "wizard.step.authorize", hint: "wizard.step.authorizeHint" },
    { id: 4, icon: Cable, title: "wizard.step.connect", hint: "wizard.step.connectHint" },
    { id: 5, icon: ShieldCheck, title: "wizard.step.verify", hint: "wizard.step.verifyHint" },
];

type Status = "current" | "done" | "review" | "todo";

/** 需要重看的原因，給徽章的 title 與手機版的提示用。/ The review reason as text (badge title, phone notice). */
export function reviewText(t: Translate, r: ReviewReason): string {
    switch (r.kind) {
        case "accountsAdded":
            return t("wizard.review.accountsAdded", { names: r.names.join(", ") });
        case "keysChanged":
            return t("wizard.review.keysChanged");
        case "offline":
            return t("wizard.review.offline");
        case "unverified":
            return t("wizard.review.unverified", { names: r.names.join(", ") });
    }
}

/** 每一步做完後的一行摘要。/ The one-line summary of a finished step. */
function summary(t: Translate, w: CreateTunnelWizard, id: WizardStep): string | null {
    switch (id) {
        case 1:
            return w.created ? `${w.created.name} · :${w.created.reversePort}` : null;
        case 2:
            return w.accounts.list.length ? w.accounts.list.map((a) => a.username).join(", ") : null;
        case 3:
            return w.keys.authorized ? t("wizard.stepper.authorized", { n: w.keys.authorizedKeys.length }) : null;
        case 4:
            if (w.connected) return w.rttMs !== null ? t("wizard.stepper.onlineRtt", { ms: Math.round(w.rttMs) }) : t("wizard.stepper.online");
            return w.maxStep >= 4 ? t("wizard.stepper.waiting") : null;
        case 5: {
            const total = w.accounts.list.length;
            const ok = w.accounts.list.filter((a) => w.verify.checks[a.username]?.state === "ok").length;
            return total && Object.keys(w.verify.checks).length ? t("wizard.stepper.verified", { ok, total }) : null;
        }
    }
}

export function WizardStepper({ wizard }: { wizard: CreateTunnelWizard }) {
    const { t } = useI18n();
    const { step, maxStep, created, review } = wizard;

    const status = (id: WizardStep): Status => {
        if (id === step) return "current";
        if (review[id]) return "review";
        if (id <= maxStep && (id < step || id < maxStep || (id === maxStep && id < step))) return "done";
        return id <= maxStep ? "done" : "todo";
    };
    const reachable = (id: WizardStep) => id !== step && id <= maxStep && (id === 1 || !!created);
    const progress = ((Math.max(step, maxStep) - 1) / (WIZARD_STEPS.length - 1)) * 100;
    const pending = WIZARD_STEPS.filter((s) => review[s.id] && s.id !== step);

    return (
        <nav aria-label={t("wizard.progressAria")} className="@container">
            {/* ── 寬：卡片 / Wide: cards ── */}
            <ol className="hidden grid-cols-5 gap-2.5 @min-[640px]:grid">
                {WIZARD_STEPS.map(({ id, icon: Icon, title, hint }, i) => {
                    const st = status(id);
                    const can = reachable(id);
                    const text = summary(t, wizard, id);
                    const r = review[id];
                    return (
                        <li key={id} className="relative min-w-0">
                            <button
                                type="button"
                                disabled={!can}
                                onClick={() => wizard.goTo(id)}
                                aria-current={st === "current" ? "step" : undefined}
                                title={r ? reviewText(t, r) : can ? t("wizard.stepper.editHint") : undefined}
                                className={cn(
                                    "group relative flex h-full w-full flex-col rounded-xl border px-3 pb-2.5 pt-2 text-left outline-none transition-all duration-200",
                                    "focus-visible:ring-2 focus-visible:ring-ring",
                                    st === "current" && "border-primary/60 bg-primary/[0.06] ring-1 ring-primary/25",
                                    st === "done" && "border-border bg-card hover:border-primary/45 hover:shadow-card",
                                    st === "review" && "border-warning/55 bg-warning/[0.07] hover:shadow-card",
                                    st === "todo" && "border-dashed border-border/80 bg-transparent",
                                    can ? "cursor-pointer" : "cursor-default"
                                )}
                            >
                                <span className="flex items-center gap-2">
                                    <span
                                        className={cn(
                                            "grid size-7 shrink-0 place-items-center rounded-full transition-colors",
                                            st === "current" && "bg-primary text-primary-foreground ring-4 ring-primary/15",
                                            st === "done" && "bg-success text-success-foreground",
                                            st === "review" && "bg-warning text-white",
                                            st === "todo" && "bg-muted text-muted-foreground"
                                        )}
                                        aria-hidden
                                    >
                                        {st === "done" ? <Check size={15} strokeWidth={3} /> : st === "review" ? <AlertTriangle size={14} strokeWidth={2.5} /> : <Icon size={15} />}
                                    </span>
                                    <span className={cn("text-[0.75rem] uppercase tracking-wider", st === "current" ? "text-primary" : "text-muted-foreground")}>
                                        {t("wizard.stepN", { n: id })}
                                    </span>
                                    {can && (
                                        <span className="ml-auto inline-flex items-center gap-1 text-[0.75rem] text-muted-foreground/70 transition-colors group-hover:text-primary">
                                            <Pencil size={12} aria-hidden />
                                            <span className="hidden @min-[860px]:inline">{t("wizard.stepper.edit")}</span>
                                        </span>
                                    )}
                                </span>
                                <span className={cn("mt-1.5 truncate text-sm", st === "todo" ? "text-muted-foreground" : "text-foreground")}>{t(title)}</span>
                                <span
                                    className={cn(
                                        "truncate text-xs",
                                        st === "review" ? "text-foreground/80" : text && st !== "current" ? "font-mono text-foreground/70" : "text-muted-foreground"
                                    )}
                                    title={text ?? undefined}
                                >
                                    {st === "review" && r ? t("wizard.stepper.review") : text && st !== "current" ? text : t(hint)}
                                </span>
                            </button>
                            {i < WIZARD_STEPS.length - 1 && (
                                <ChevronRight
                                    size={14}
                                    className={cn("absolute -right-[13px] top-1/2 z-10 -translate-y-1/2", id < Math.max(step, maxStep) ? "text-success" : "text-border")}
                                    aria-hidden
                                />
                            )}
                        </li>
                    );
                })}
            </ol>

            {/* ── 窄：圓點 / Narrow: dots ── */}
            <div className="@min-[640px]:hidden">
                <ol className="relative flex items-center justify-between">
                    {/* 軌道在圓點後面，圓點是實心的，所以線不會穿過去。/ The track sits behind solid dots. */}
                    <span className="absolute left-4 right-4 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-border" aria-hidden>
                        <span className="absolute inset-y-0 left-0 rounded-full bg-success transition-[width] duration-500" style={{ width: `${progress}%` }} />
                    </span>
                    {WIZARD_STEPS.map(({ id, icon: Icon, title }) => {
                        const st = status(id);
                        const can = reachable(id);
                        return (
                            <li key={id} className="relative">
                                <button
                                    type="button"
                                    disabled={!can}
                                    onClick={() => wizard.goTo(id)}
                                    aria-current={st === "current" ? "step" : undefined}
                                    aria-label={`${t("wizard.stepN", { n: id })} · ${t(title)}${can ? ` · ${t("wizard.stepper.edit")}` : ""}`}
                                    className={cn(
                                        "relative grid size-9 place-items-center rounded-full border-2 outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring",
                                        st === "current" && "scale-110 border-transparent bg-primary text-primary-foreground ring-4 ring-primary/15",
                                        st === "done" && "border-success bg-card text-success",
                                        st === "review" && "border-warning bg-card text-warning",
                                        st === "todo" && "border-border bg-card text-muted-foreground"
                                    )}
                                >
                                    {st === "done" ? <Check size={16} strokeWidth={3} /> : st === "review" ? <AlertTriangle size={15} /> : <Icon size={16} />}
                                    {can && st === "done" && (
                                        <span className="absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full bg-card text-foreground/70 ring-1 ring-border" aria-hidden>
                                            <Pencil size={9} />
                                        </span>
                                    )}
                                </button>
                            </li>
                        );
                    })}
                </ol>
                <p className="mt-3 text-center text-sm text-foreground">
                    {t("wizard.stepN", { n: step })} · {t(WIZARD_STEPS[step - 1].title)}
                    <span className="text-muted-foreground"> · {t(WIZARD_STEPS[step - 1].hint)}</span>
                </p>
            </div>

            {/* 有步驟需要重看：直接列出，點了就過去。/ Steps to review: listed, one tap away. */}
            {pending.length > 0 ? (
                <Callout tone="warning" role="status" className="mt-3 items-center py-2.5">
                    <div className="flex flex-wrap gap-2 text-xs">
                        {pending.map((s) => (
                            <button key={s.id} type="button" onClick={() => wizard.goTo(s.id)} className="rounded-sm bg-card px-2 py-0.5 ring-1 ring-inset ring-warning/40 transition-colors hover:ring-warning">
                                {t("wizard.stepN", { n: s.id })} · {reviewText(t, review[s.id]!)}
                            </button>
                        ))}
                    </div>
                </Callout>
            ) : maxStep > 1 && created ? (
                <p className="mt-2.5 flex items-center justify-center gap-1.5 text-[0.75rem] text-muted-foreground @min-[640px]:justify-end">
                    <Pencil size={11} aria-hidden /> {t("wizard.stepper.editHint")}
                </p>
            ) : null}
        </nav>
    );
}
