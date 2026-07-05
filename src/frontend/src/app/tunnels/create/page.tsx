"use client";

/**
 * 建立新通道精靈頁：步驟導引與表單組合。
 * Create new tunnel wizard page: step indicator and form composition.
 */
import React from "react";
import { useToast } from "@/components/ui/Toast";
import { Check, Terminal, Key, Users, Activity, CheckCircle2 } from "lucide-react";
import { useCreateTunnelWizard } from "@/hooks/useCreateTunnelWizard";
import { Step1BasicConfig } from "@/components/tunnels/CreateWizardSteps/Step1BasicConfig";
import { Step2ServerKeys } from "@/components/tunnels/CreateWizardSteps/Step2ServerKeys";
import { Step3ServerUsers } from "@/components/tunnels/CreateWizardSteps/Step3ServerUsers";
import { Step4TestConnection } from "@/components/tunnels/CreateWizardSteps/Step4TestConnection";
import { Step5Completion } from "@/components/tunnels/CreateWizardSteps/Step5Completion";
import { KeyViewModal } from "@/components/tunnels/CreateWizardSteps/KeyViewModal";
import { useI18n } from "@/lib/i18n";

export default function CreateTunnelWizard() {
    const { t } = useI18n();
    const { showSuccess } = useToast();
    const { state, actions } = useCreateTunnelWizard();

    const STEPS = [
        { id: 1, title: t("wizard.stepBasicConfig"), icon: <Terminal size={18} /> },
        { id: 2, title: t("wizard.stepServerKeys"), icon: <Key size={18} /> },
        { id: 3, title: t("wizard.stepServerUsers"), icon: <Users size={18} /> },
        { id: 4, title: t("wizard.stepTestConnection"), icon: <Activity size={18} /> },
        { id: 5, title: t("wizard.stepCompletion"), icon: <CheckCircle2 size={18} /> },
    ];
    const {
        currentStep,
        setCurrentStep,
        isProcessing,
        sshKey,
        hostName,
        setHostName,
        endpointSshPort,
        setEndpointSshPort,
        sshPort,
        createdHostName,
        userKeys,
        serviceKeys,
        users,
        newUsername,
        setNewUsername,
        sshScriptContent,
        autosshScriptContent,
        status,
        keyModalOpen,
        setKeyModalOpen,
        keyModalContent,
        keyModalTitle,
        setKeyModalTitle,
        setKeyModalContent,
        configContent,
        configLoading,
    } = state;
    const { handleKeyChange, handleStep1Submit, handleAddUser, handleDeleteUser } = actions;

    const openKeyModal = (title: string, content: string) => {
        setKeyModalTitle(title);
        setKeyModalContent(content);
        setKeyModalOpen(true);
    };

    return (
        <div className="max-w-4xl mx-auto pb-12 animate-fade-in-up">
            <div className="mb-8">
                <h1 className="text-2xl font-bold text-foreground">{t("wizard.title")}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t("wizard.subtitle")}</p>
            </div>

            <div className="mb-8 overflow-hidden rounded-lg bg-card shadow ring-1 ring-border">
                <div className="flex bg-muted/50 border-b border-border divide-x divide-border">
                    {STEPS.map((step) => {
                        const isActive = step.id === currentStep;
                        const isCompleted = step.id < currentStep;
                        return (
                            <div
                                key={step.id}
                                className={`flex-1 relative py-4 px-2 text-center text-sm font-medium ${isActive ? "bg-card text-green-600 dark:text-green-400 after:absolute after:bottom-0 after:left-0 after:w-full after:h-[2px] after:bg-green-600 dark:after:bg-green-400 after:origin-left after:animate-progress-fill" : isCompleted ? "text-foreground" : "text-muted-foreground"}`}
                            >
                                <div className="flex flex-col items-center justify-center gap-2">
                                    <div
                                        className={`flex justify-center items-center w-8 h-8 rounded-full ${isActive ? "bg-green-100 dark:bg-green-500/20 ring-4 ring-green-100/50 dark:ring-green-500/10 animate-pulse-glow" : isCompleted ? "bg-green-500 text-white" : "bg-muted"}`}
                                    >
                                        {isCompleted ? <Check size={16} /> : <span className={isActive ? "animate-pulse-step block flex items-center justify-center" : ""}>{step.icon}</span>}
                                    </div>
                                    <span className="hidden sm:block">{step.title}</span>
                                </div>
                            </div>
                        );
                    })}
                </div>

                {currentStep === 1 && (
                    <Step1BasicConfig
                        sshKey={sshKey}
                        onKeyChange={handleKeyChange}
                        hostName={hostName}
                        onHostNameChange={setHostName}
                        endpointSshPort={endpointSshPort}
                        onEndpointSshPortChange={setEndpointSshPort}
                        isProcessing={isProcessing}
                        onSubmit={handleStep1Submit}
                    />
                )}
                {currentStep === 2 && (
                    <Step2ServerKeys
                        serviceKeys={serviceKeys}
                        userKeys={userKeys}
                        onViewKey={openKeyModal}
                        onBack={() => setCurrentStep(1)}
                        onNext={() => setCurrentStep(3)}
                    />
                )}
                {currentStep === 3 && (
                    <Step3ServerUsers
                        users={users}
                        newUsername={newUsername}
                        onNewUsernameChange={setNewUsername}
                        isProcessing={isProcessing}
                        onAddUser={handleAddUser}
                        onDeleteUser={handleDeleteUser}
                        onBack={() => setCurrentStep(2)}
                        onNext={() => setCurrentStep(4)}
                    />
                )}
                {currentStep === 4 && (
                    <Step4TestConnection
                        sshScriptContent={sshScriptContent}
                        autosshScriptContent={autosshScriptContent}
                        status={status}
                        createdHostName={createdHostName}
                        sshPort={sshPort ?? 22}
                        onBack={() => setCurrentStep(3)}
                        onNext={() => setCurrentStep(5)}
                    />
                )}
                {currentStep === 5 && (
                    <Step5Completion
                        createdHostName={createdHostName}
                        sshPort={sshPort ?? 22}
                        configContent={configContent}
                        configLoading={configLoading}
                    />
                )}
            </div>

            <KeyViewModal
                isOpen={keyModalOpen}
                title={keyModalTitle}
                content={keyModalContent}
                onClose={() => setKeyModalOpen(false)}
                onCopySuccess={() => showSuccess(t("wizard.keyCopied"))}
            />
        </div>
    );
}
