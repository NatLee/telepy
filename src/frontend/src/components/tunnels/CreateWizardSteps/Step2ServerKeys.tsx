/**
 * 建立通道精靈步驟 2：伺服器金鑰列表與複製說明。
 * Create tunnel wizard step 2: server keys list and copy instructions.
 */
import React from "react";
import { ChevronRight, Eye, AlertTriangle } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export interface KeyItem {
    service?: string;
    host_friendly_name?: string;
    key?: string;
    public_key?: string;
}

export interface Step2ServerKeysProps {
    serviceKeys: KeyItem[];
    userKeys: KeyItem[];
    onViewKey: (title: string, content: string) => void;
    onBack: () => void;
    onNext: () => void;
}

export function Step2ServerKeys({ serviceKeys, userKeys, onViewKey, onBack, onNext }: Step2ServerKeysProps) {
    const { t, tn } = useI18n();
    return (
        <div className="p-6 sm:p-8">
            <h3 className="text-lg font-medium text-gray-900 mb-4">{t("wizard.step2Heading")}</h3>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 flex items-start gap-2 text-sm text-amber-800">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>{tn("wizard.step2Banner", {
                    path: <code className="bg-amber-100 px-1 rounded">~/.ssh/authorized_keys</code>,
                    serviceKeys: <strong>{t("wizard.step2BannerServiceKeys")}</strong>,
                    userKeys: <strong>{t("wizard.step2BannerUserKeys")}</strong>,
                })}</span>
            </div>
            <p className="text-sm text-gray-500 mb-6">{t("wizard.step2Description")}</p>

            <div className="space-y-6 relative">
                <div>
                    <h4 className="text-sm font-bold text-gray-700 mb-2">{t("wizard.serviceKeys")}</h4>
                    {serviceKeys.length > 0 ? (
                        <ul className="space-y-2">
                            {serviceKeys.map((serviceKey, i) => (
                                <li key={i} className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
                                    <span className="text-sm font-medium text-gray-700">{serviceKey.service || serviceKey.host_friendly_name || t("wizard.serviceKeyN", { n: i + 1 })}</span>
                                    <button
                                        type="button"
                                        onClick={() => onViewKey(serviceKey.service || t("wizard.serviceKeyN", { n: i + 1 }), serviceKey.key || serviceKey.public_key || "")}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
                                    >
                                        <Eye size={14} /> {t("wizard.viewKey")}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : <p className="text-sm text-gray-500">{t("wizard.noServiceKeys")}</p>}
                </div>
                <div>
                    <h4 className="text-sm font-bold text-gray-700 mb-2">{t("wizard.userKeys")}</h4>
                    {userKeys.length > 0 ? (
                        <ul className="space-y-2">
                            {userKeys.map((userKey, i) => (
                                <li key={i} className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
                                    <span className="text-sm font-medium text-gray-700">{userKey.host_friendly_name || t("wizard.userKeyN", { n: i + 1 })}</span>
                                    <button
                                        type="button"
                                        onClick={() => onViewKey(userKey.host_friendly_name || t("wizard.userKeyN", { n: i + 1 }), userKey.key || userKey.public_key || "")}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
                                    >
                                        <Eye size={14} /> {t("wizard.viewKey")}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : <p className="text-sm text-gray-500">{t("wizard.noUserKeys")}</p>}
                </div>
            </div>

            <div className="mt-8 flex justify-between">
                <button type="button" onClick={onBack} className="inline-flex items-center px-6 py-3 border border-gray-300 rounded-lg shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none">{t("common.back")}</button>
                <button type="button" onClick={onNext} className="inline-flex items-center px-6 py-3 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700 focus:outline-none">
                    {t("common.nextStep")} <ChevronRight size={16} className="ml-2 -mr-1" />
                </button>
            </div>
        </div>
    );
}
