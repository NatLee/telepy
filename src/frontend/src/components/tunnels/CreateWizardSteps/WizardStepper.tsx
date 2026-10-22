/**
 * 建立精靈的進度列：五個節點＋漸層進度線；到過的步驟可以點回去。
 * Wizard progress: five nodes on a gradient progress line; visited steps are clickable.
 */
"use client";

import React from "react";
import { Cable, Check, Cpu, KeyRound, ShieldCheck, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import type { WizardStep } from "@/hooks/useCreateTunnelWizard";

export const WIZARD_STEPS: { id: WizardStep; icon: LucideIcon; title: TranslationKey; hint: TranslationKey }[] = [
    { id: 1, icon: Cpu, title: "wizard.step.device", hint: "wizard.step.deviceHint" },
    { id: 2, icon: Users, title: "wizard.step.accounts", hint: "wizard.step.accountsHint" },
    { id: 3, icon: KeyRound, title: "wizard.step.authorize", hint: "wizard.step.authorizeHint" },
    { id: 4, icon: Cable, title: "wizard.step.connect", hint: "wizard.step.connectHint" },
    { id: 5, icon: ShieldCheck, title: "wizard.step.verify", hint: "wizard.step.verifyHint" },
];

interface WizardStepperProps {
    step: WizardStep;
    maxStep: WizardStep;
    canLeaveFirst: boolean;
    onSelect: (s: WizardStep) => void;
}

export function WizardStepper({ step, maxStep, canLeaveFirst, onSelect }: WizardStepperProps) {
    const { t } = useI18n();
    const progress = ((step - 1) / (WIZARD_STEPS.length - 1)) * 100;
    return (
        <nav aria-label={t("wizard.progressAria")}>
            <ol className="relative grid grid-cols-5">
                {/* 進度線：兩端各縮半格，剛好連到第一與最後一個圓心。/ Track spans circle centre to circle centre. */}
                <span className="pointer-events-none absolute left-[10%] right-[10%] top-5 h-0.5 rounded-full bg-border" aria-hidden>
                    <span
                        className="absolute inset-y-0 left-0 rounded-full bg-brand-gradient transition-[width] duration-500 ease-out"
                        style={{ width: `${progress}%` }}
                    />
                </span>
                {WIZARD_STEPS.map(({ id, icon: Icon, title, hint }) => {
                    const active = id === step;
                    const done = !active && (id < step || id < maxStep);
                    const visited = !active && !done && id <= maxStep;
                    const reachable = !active && id <= maxStep && (id === 1 || canLeaveFirst);
                    return (
                        <li key={id} className="relative flex flex-col items-center text-center">
                            <button
                                type="button"
                                disabled={!reachable}
                                onClick={() => onSelect(id)}
                                aria-current={active ? "step" : undefined}
                                className={cn(
                                    "group flex flex-col items-center gap-2 rounded-xl px-1 pb-1 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    reachable ? "cursor-pointer" : "cursor-default"
                                )}
                            >
                                <span
                                    className={cn(
                                        "relative grid size-10 place-items-center rounded-full border-2 transition-all duration-300",
                                        active && "border-transparent bg-brand-gradient text-white shadow-glow scale-110 animate-pulse-step",
                                        done && "border-primary bg-primary/10 text-primary group-hover:bg-primary/20",
                                        visited && "border-primary/50 bg-card text-primary group-hover:bg-primary/10",
                                        !active && !done && !visited && "border-border bg-card text-muted-foreground"
                                    )}
                                >
                                    {done ? <Check size={18} strokeWidth={2.5} /> : <Icon size={18} />}
                                </span>
                                <span className="flex flex-col items-center gap-0.5">
                                    <span className={cn("text-[0.75rem] font-medium uppercase tracking-wider", active ? "text-primary" : "text-muted-foreground")}>
                                        {t("wizard.stepN", { n: id })}
                                    </span>
                                    <span className={cn("hidden text-sm font-semibold sm:block", active || done ? "text-foreground" : "text-muted-foreground")}>
                                        {t(title)}
                                    </span>
                                    <span className="hidden max-w-[11rem] text-[0.75rem] leading-snug text-muted-foreground lg:block">{t(hint)}</span>
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ol>
            {/* 手機只顯示圓點，這裡補上目前步驟名稱。/ Phones show dots only; name the current step here. */}
            <p className="mt-3 text-center text-sm font-semibold text-foreground sm:hidden">
                {t(WIZARD_STEPS[step - 1].title)}
                <span className="font-normal text-muted-foreground"> · {t(WIZARD_STEPS[step - 1].hint)}</span>
            </p>
        </nav>
    );
}
