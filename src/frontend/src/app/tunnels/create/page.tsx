"use client";

/**
 * 建立新通道精靈頁：進度列 + 活拓撲圖（目前在做什麼）+ 步驟內容 + 「為什麼」說明卡。
 * Create-tunnel wizard page: progress, a live topology (what is happening now), the step itself and a "why" card.
 */
import React, { useState, useSyncExternalStore } from "react";
import { Cable, ListChecks, Terminal } from "lucide-react";
import { useCreateTunnelWizard, type WizardStep } from "@/hooks/useCreateTunnelWizard";
import { useDeviceJoin } from "@/hooks/useDeviceJoin";
import { JoinPanel, JoinWhy } from "@/components/tunnels/JoinPanel";
import { Segmented } from "@/components/ui/segmented";
import { PageHeader } from "@/components/layout/PageHeader";
import { WizardStepper } from "@/components/tunnels/CreateWizardSteps/WizardStepper";
import { SetupDiagram } from "@/components/tunnels/CreateWizardSteps/SetupDiagram";
import { WhyPanel } from "@/components/tunnels/CreateWizardSteps/WhyPanel";
import { StepDevice } from "@/components/tunnels/CreateWizardSteps/StepDevice";
import { StepAccounts } from "@/components/tunnels/CreateWizardSteps/StepAccounts";
import { StepAuthorize } from "@/components/tunnels/CreateWizardSteps/StepAuthorize";
import { StepConnect } from "@/components/tunnels/CreateWizardSteps/StepConnect";
import { StepVerify } from "@/components/tunnels/CreateWizardSteps/StepVerify";
import { useI18n } from "@/lib/i18n";

const CARD = "rounded-xl border border-border bg-card shadow-card";
const MODE_KEY = "telepy.createMode";
type Mode = "command" | "steps";

function subscribeStorage(onChange: () => void) {
    window.addEventListener("storage", onChange);
    return () => window.removeEventListener("storage", onChange);
}
function readStoredMode(): string | null {
    try { return localStorage.getItem(MODE_KEY); } catch { return null; }
}

export default function CreateTunnelWizard() {
    const { t } = useI18n();
    const wizard = useCreateTunnelWizard();
    const join = useDeviceJoin();
    const { step, created } = wizard;
    const deviceName = created?.name ?? wizard.device.hostName.trim();

    // 一行指令（預設）或逐步精靈；記住上次的選擇。/ One command (default) or the step-by-step wizard; remembered.
    const stored = useSyncExternalStore(subscribeStorage, readStoredMode, () => null);
    const [picked, setPicked] = useState<Mode | null>(null);
    const mode: Mode = picked ?? (stored === "steps" ? "steps" : "command");
    const setMode = (m: Mode) => {
        setPicked(m);
        try { localStorage.setItem(MODE_KEY, m); } catch { /* 沒有 localStorage 就只記在這頁 / page-only without storage */ }
    };
    // 精靈開始後（已建立通道）就不再顯示切換。/ Hide the switch once the wizard created a tunnel.
    const showModes = !created && !join.ticket;

    // 一行指令模式的拓撲圖：註冊前 = 裝置把金鑰交給 Telepy；之後 = 連線 / 驗證。
    // The diagram in command mode: before registration the device hands its key over; then connect / verify.
    const jt = join.ticket;
    const joinStep: WizardStep = !jt || jt.phase === "waiting" ? 1 : jt.phase === "registered" ? 4 : 5;
    const joinConnected = !!jt && (jt.phase === "connected" || jt.phase === "verified" || (jt.phase === "failed" && !!jt.tunnel_id));

    return (
        <div className="mx-auto max-w-5xl space-y-6 pb-12 animate-fade-in-up">
            <PageHeader
                icon={<Cable />}
                title={t("wizard.title")}
                description={mode === "command" ? t("join.pageSubtitle") : t("wizard.subtitle")}
            />

            {showModes && (
                // 分段切換不會縮（min-w-max）：窄螢幕讓它在自己這一列裡捲動，整頁不會被撐寬。
                // The segmented control never shrinks (min-w-max): on narrow screens it scrolls in its own row instead of widening the page.
                <div className="max-w-full overflow-x-auto [scrollbar-width:none]">
                    <Segmented<Mode>
                        kind="tabs"
                        value={mode}
                        onChange={setMode}
                        options={[
                            { value: "command", label: t("join.mode.command"), icon: <Terminal size={14} /> },
                            { value: "steps", label: t("join.mode.steps"), icon: <ListChecks size={14} /> },
                        ]}
                    />
                </div>
            )}

            {mode === "command" ? (
                <>
                    <section className={`${CARD} p-4 sm:p-6`}>
                        <SetupDiagram
                            step={joinStep}
                            deviceName={jt?.tunnel_name ?? jt?.name ?? join.form.name.trim()}
                            sshPort={String(jt?.ssh_port ?? 22)}
                            reversePort={jt?.reverse_port ?? null}
                            accounts={jt?.username ? [jt.username] : []}
                            connected={joinConnected}
                            rttMs={join.rttMs}
                            allLoginsOk={jt?.phase === "verified"}
                        />
                    </section>
                    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
                        <section className={`${CARD} p-4 animate-fade-in-up sm:p-6`}>
                            <JoinPanel join={join} />
                        </section>
                        <div className="order-first lg:order-none lg:sticky lg:top-6">
                            <JoinWhy />
                        </div>
                    </div>
                </>
            ) : (
            <>
            <section className={`${CARD} space-y-6 p-4 sm:p-6`}>
                <WizardStepper wizard={wizard} />
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
            </>
            )}
        </div>
    );
}
