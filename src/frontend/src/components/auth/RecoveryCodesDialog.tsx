"use client";

/**
 * 復原碼只顯示一次：提供複製與下載，按「我已存好」才關。
 * Recovery codes are shown once, with copy and download.
 */
import React from "react";
import { Copy, Download, ShieldAlert } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/ui/Toast";

export function RecoveryCodesDialog({ codes, onClose }: { codes: string[]; onClose: () => void }) {
    const { t } = useI18n();
    const { showSuccess } = useToast();
    const text = codes.join("\n") + "\n";

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            showSuccess(t("common.copied"));
        } catch {
            /* clipboard blocked: the codes stay on screen */
        }
    };

    const download = () => {
        const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `telepy-recovery-codes-${window.location.hostname}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    };

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={t("security.recoveryTitle")}
            footer={
                <Button type="button" onClick={onClose}>
                    {t("security.recoveryDone")}
                </Button>
            }
        >
            <div className="space-y-4">
                <div className="flex items-start gap-2 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm text-amber-800 dark:text-amber-200">
                    <ShieldAlert size={16} className="mt-0.5 shrink-0" />
                    <span>{t("security.recoveryWarning")}</span>
                </div>
                <ul className="grid grid-cols-2 gap-2 font-mono text-sm">
                    {codes.map((c) => (
                        <li key={c} className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-center select-all">
                            {c}
                        </li>
                    ))}
                </ul>
                <div className="flex gap-2">
                    <Button type="button" variant="outline" className="flex-1" onClick={copy}>
                        <Copy size={14} className="mr-2" />
                        {t("security.recoveryCopyAll")}
                    </Button>
                    <Button type="button" variant="outline" className="flex-1" onClick={download}>
                        <Download size={14} className="mr-2" />
                        {t("security.recoveryDownload")}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
