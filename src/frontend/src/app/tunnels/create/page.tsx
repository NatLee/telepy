"use client";

/**
 * 建立新通道精靈頁：進度列 + 活拓撲圖（目前在做什麼）+ 步驟內容 + 「為什麼」說明卡。
 * Create-tunnel wizard page: progress, a live topology (what is happening now), the step itself and a "why" card.
 */
import React from "react";
import { Cable } from "lucide-react";
import { useCreateTunnelWizard } from "@/hooks/useCreateTunnelWizard";
import { WizardStepper } from "@/components/tunnels/CreateWizardSteps/WizardStepper";
import { SetupDiagram } from "@/components/tunnels/CreateWizardSteps/SetupDiagram";
import { WhyPanel } from "@/components/tunnels/CreateWizardSteps/WhyPanel";
import { StepDevice } from "@/components/tunnels/CreateWizardSteps/StepDevice";
import { StepAccounts } from "@/components/tunnels/CreateWizardSteps/StepAccounts";
import { StepAuthorize } from "@/components/tunnels/CreateWizardSteps/StepAuthorize";
import { StepConnect } from "@/components/tunnels/CreateWizardSteps/StepConnect";
import { StepVerify } from "@/components/tunnels/CreateWizardSteps/StepVerify";
import { useI18n } from "@/lib/i18n";

const CARD = "rounded-2xl border border-border bg-card/85 backdrop-blur-sm shadow-card";

export default function CreateTunnelWizard() {
    const { t } = useI18n();
    const wizard = useCreateTunnelWizard();
    const { step, created } = wizard;
    const deviceName = created?.name ?? wizard.device.hostName.trim();

    return (
        <div className="mx-auto max-w-5xl space-y-6 pb-12 animate-fade-in-up">
            <header className="flex items-start gap-4">
                <div className="hidden size-12 shrink-0 place-items-center rounded-2xl bg-brand-gradient shadow-glow sm:grid" aria-hidden>
                    <Cable className="text-white" size={22} />
                </div>
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">{t("wizard.title")}</h1>
                    <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t("wizard.subtitle")}</p>
                </div>
            </header>

            <section className={`${CARD} space-y-6 p-4 sm:p-6`}>
                <WizardStepper step={step} maxStep={wizard.maxStep} canLeaveFirst={!!created} onSelect={wizard.goTo} />
                <SetupDiagram
                    step={step}
                    deviceName={deviceName}
                    sshPort={wizard.device.sshPort}
                    reversePort={created?.reversePort ?? null}
                    accounts={wizard.accounts.list.map((a) => a.username)}
                    connected={wizard.connected}
                    rttMs={wizard.rttMs}
                    allLoginsOk={wizard.verify.allLoginsOk}
                />
            </section>

            <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
                <section key={step} className={`${CARD} p-4 animate-fade-in-up sm:p-6`} aria-live="off">
                    {step === 1 && <StepDevice wizard={wizard} />}
                    {step === 2 && <StepAccounts wizard={wizard} />}
                    {step === 3 && <StepAuthorize wizard={wizard} />}
                    {step === 4 && <StepConnect wizard={wizard} />}
                    {step === 5 && <StepVerify wizard={wizard} />}
                </section>
                {/* 手機上「為什麼」放在步驟內容上方；桌面在右側並跟著捲動。/ Above the step on phones; a sticky side card on desktop. */}
                <div className="order-first lg:order-none lg:sticky lg:top-6">
                    <WhyPanel step={step} />
                </div>
            </div>
        </div>
    );
}
