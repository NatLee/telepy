/**
 * 建立通道精靈步驟 1：基本設定（SSH 公鑰、主機名稱、埠）。
 * Create tunnel wizard step 1: basic config (SSH public key, host name, port).
 */
import React from "react";
import { Info, ChevronRight } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export interface Step1BasicConfigProps {
    sshKey: string;
    onKeyChange: (v: string) => void;
    hostName: string;
    onHostNameChange: (v: string) => void;
    endpointSshPort: number;
    onEndpointSshPortChange: (v: number) => void;
    isProcessing: boolean;
    onSubmit: (e: React.FormEvent) => void;
}

export function Step1BasicConfig({
    sshKey,
    onKeyChange,
    hostName,
    onHostNameChange,
    endpointSshPort,
    onEndpointSshPortChange,
    isProcessing,
    onSubmit,
}: Step1BasicConfigProps) {
    const { t, tn } = useI18n();
    return (
        <form className="p-6 sm:p-8" onSubmit={onSubmit}>
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 flex items-start gap-2 text-sm text-blue-800">
                <Info size={16} className="mt-0.5 shrink-0" />
                <span>{tn("wizard.step1Banner", { publicKey: <strong>{t("wizard.step1BannerPublicKey")}</strong>, port: <code className="bg-blue-100 px-1 rounded">22</code> })}</span>
            </div>
            <div className="space-y-6">
                <div>
                    <label className="block text-sm font-semibold text-gray-800 mb-1">{t("wizard.sshPublicKey")} <span className="text-red-500">*</span></label>
                    <textarea
                        required
                        rows={4}
                        value={sshKey}
                        onChange={(e) => onKeyChange(e.target.value)}
                        className="block w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500 sm:text-sm font-mono bg-slate-50"
                        placeholder="ssh-rsa AAAAB3NzaC1yc... user@machine"
                    />
                    <p className="mt-1 text-xs text-gray-500">{t("wizard.sshKeyHelper")}</p>
                </div>
                <div>
                    <label className="block text-sm font-semibold text-gray-800 mb-1">{t("wizard.hostFriendlyName")} <span className="text-red-500">*</span></label>
                    <input
                        type="text"
                        required
                        value={hostName}
                        onChange={(e) => onHostNameChange(e.target.value)}
                        className="block w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500 sm:text-sm bg-slate-50"
                        placeholder={t("wizard.hostNamePlaceholder")}
                    />
                </div>
                <div>
                    <label className="block text-sm font-semibold text-gray-800 mb-1">{t("wizard.sshPort")}</label>
                    <input
                        type="number"
                        min={1}
                        max={65535}
                        value={endpointSshPort}
                        onChange={(e) => onEndpointSshPortChange(Number(e.target.value))}
                        className="block w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500 sm:text-sm bg-slate-50"
                        placeholder="22"
                    />
                    <p className="mt-1 text-xs text-gray-500">{t("wizard.sshPortHelper")}</p>
                </div>
            </div>
            <div className="mt-8 flex justify-end">
                <button
                    type="submit"
                    disabled={isProcessing}
                    className="inline-flex items-center px-6 py-3 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:opacity-70"
                >
                    {isProcessing ? t("common.processing") : t("common.nextStep")}
                    {!isProcessing && <ChevronRight size={16} className="ml-2 -mr-1" />}
                </button>
            </div>
        </form>
    );
}
