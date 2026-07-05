/**
 * 建立通道精靈步驟 4：測試連線腳本與連線狀態。
 * Create tunnel wizard step 4: test connection script and status.
 */
import React from "react";
import { ChevronRight, Info, AlertTriangle } from "lucide-react";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { ConnectionStatusLight } from "@/components/ui/ConnectionStatusLight";
import { useI18n } from "@/lib/i18n";

export interface Step4TestConnectionProps {
    sshScriptContent: string;
    autosshScriptContent: string;
    status: { is_connected?: boolean; host_friendly_name?: string; reverse_port?: number } | null;
    createdHostName: string;
    sshPort: number;
    onBack: () => void;
    onNext: () => void;
}

export function Step4TestConnection({
    sshScriptContent,
    autosshScriptContent,
    status,
    createdHostName,
    sshPort,
    onBack,
    onNext,
}: Step4TestConnectionProps) {
    const { t, tn } = useI18n();
    return (
        <div className="p-6 sm:p-8">
            <h3 className="text-lg font-medium text-gray-900 mb-4">{t("wizard.step4Heading")}</h3>
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-3 flex items-start gap-2 text-sm text-blue-800">
                <Info size={16} className="mt-0.5 shrink-0" />
                <span>{tn("wizard.step4Banner", { onTargetServer: <strong>{t("wizard.step4BannerOnTarget")}</strong> })}</span>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 flex items-start gap-2 text-sm text-amber-800">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>{tn("wizard.step4Warning", {
                    step2: <strong>{t("wizard.step4WarningStep2")}</strong>,
                    path: <code className="bg-amber-100 px-1 rounded">~/.ssh/authorized_keys</code>,
                })}</span>
            </div>

            <div className="space-y-6 mb-6">
                <div>
                    <h4 className="text-sm font-semibold text-gray-800 mb-2">{t("wizard.step4Option1")}</h4>
                    <CodeBlock language="bash" value={sshScriptContent} />
                </div>
                <div>
                    <h4 className="text-sm font-semibold text-gray-800 mb-2">{t("wizard.step4Option2")}</h4>
                    <CodeBlock language="bash" value={autosshScriptContent} />
                </div>
            </div>

            <div className={`p-5 rounded-lg border flex items-center gap-5 ${status?.is_connected ? "bg-green-50 border-green-200 text-green-800" : "bg-yellow-50 border-yellow-200 text-yellow-800"}`}>
                <ConnectionStatusLight state={status?.is_connected ? "connected" : "disconnected"} size={48} />
                <div>
                    <strong className="block text-sm mb-1">{t("wizard.connectionStatus")}</strong>
                    <span className="text-sm">
                        {status?.is_connected
                            ? t("wizard.connectedStatus", { name: status.host_friendly_name ?? createdHostName, port: status.reverse_port ?? sshPort })
                            : t("wizard.waitingConnection")}
                    </span>
                </div>
            </div>

            <div className="mt-8 flex justify-between">
                <button type="button" onClick={onBack} className="inline-flex items-center px-6 py-3 border border-gray-300 rounded-lg shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50">{t("common.back")}</button>
                <button type="button" onClick={onNext} className="inline-flex items-center px-6 py-3 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700">{t("common.nextStep")} <ChevronRight size={16} className="ml-2 -mr-1" /></button>
            </div>
        </div>
    );
}
