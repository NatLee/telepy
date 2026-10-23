/**
 * 每個步驟旁的「為什麼要這一步？」說明卡：一句話講原因，加上幾個重點。
 * The "Why this step?" card next to every step: one sentence of reasoning plus a few key points.
 */
"use client";

import React from "react";
import {
    BadgeCheck,
    DoorClosed,
    Hash,
    KeyRound,
    Laptop,
    Lightbulb,
    ListChecks,
    Lock,
    RefreshCw,
    RotateCcw,
    Server,
    ShieldCheck,
    TerminalSquare,
    UserCheck,
    Users,
    WifiOff,
    type LucideIcon,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { Callout } from "@/components/ui/callout";
import type { TranslationKey } from "@/locales/en";
import type { WizardStep } from "@/hooks/useCreateTunnelWizard";

const WHY: Record<WizardStep, { body: TranslationKey; points: { icon: LucideIcon; text: TranslationKey }[] }> = {
    1: {
        body: "wizard.why.device",
        points: [
            { icon: DoorClosed, text: "wizard.why.devicePoint1" },
            { icon: ShieldCheck, text: "wizard.why.devicePoint2" },
            { icon: Hash, text: "wizard.why.devicePoint3" },
        ],
    },
    2: {
        body: "wizard.why.accounts",
        points: [
            { icon: UserCheck, text: "wizard.why.accountsPoint1" },
            { icon: Users, text: "wizard.why.accountsPoint2" },
            { icon: ListChecks, text: "wizard.why.accountsPoint3" },
        ],
    },
    3: {
        body: "wizard.why.authorize",
        points: [
            { icon: TerminalSquare, text: "wizard.why.authorizePoint1" },
            { icon: Laptop, text: "wizard.why.authorizePoint2" },
            { icon: Lock, text: "wizard.why.authorizePoint3" },
        ],
    },
    4: {
        body: "wizard.why.connect",
        points: [
            { icon: Server, text: "wizard.why.connectPoint1" },
            { icon: RefreshCw, text: "wizard.why.connectPoint2" },
            { icon: BadgeCheck, text: "wizard.why.connectPoint3" },
        ],
    },
    5: {
        body: "wizard.why.verify",
        points: [
            { icon: KeyRound, text: "wizard.why.verifyPoint1" },
            { icon: WifiOff, text: "wizard.why.verifyPoint2" },
            { icon: RotateCcw, text: "wizard.why.verifyPoint3" },
        ],
    },
};

export function WhyPanel({ step }: { step: WizardStep }) {
    const { t } = useI18n();
    const why = WHY[step];
    return (
        <aside key={step} className="animate-fade-in-up" aria-label={t("wizard.why.title")}>
            <Callout
                tone="info"
                icon={<Lightbulb size={17} className="mt-0.5 shrink-0" aria-hidden />}
                title={t("wizard.why.title")}
                className="p-4 sm:p-5"
            >
                <p>{t(why.body)}</p>
                <ul className="mt-3 space-y-2.5">
                    {why.points.map(({ icon: Icon, text }) => (
                        <li key={text} className="flex gap-2.5 text-xs leading-relaxed text-muted-foreground">
                            <Icon size={14} className="mt-0.5 shrink-0 text-info" aria-hidden />
                            <span>{t(text)}</span>
                        </li>
                    ))}
                </ul>
            </Callout>
        </aside>
    );
}
