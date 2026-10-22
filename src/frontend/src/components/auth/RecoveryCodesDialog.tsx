"use client";

/**
 * 復原碼只顯示一次：提供複製與下載，按「我已存好」才關。
 * Recovery codes are shown once, with copy and download.
 */
import React from "react";
import { Copy, Download, LifeBuoy } from "lucide-react";
import { Callout } from "@/components/ui/callout";
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
            icon={<LifeBuoy />}
            footer={
                <Button type="button" onClick={onClose}>
                    {t("security.recoveryDone")}
                </Button>
            }
        >
            <div className="space-y-4">
                <Callout tone="warning">{t("security.recoveryWarning")}</Callout>
                <ul className="grid grid-cols-2 gap-2 rounded-xl bg-surface p-3 font-mono text-sm ring-1 ring-inset ring-border/80">
                    {codes.map((c) => (
                        <li key={c} className="rounded-lg bg-card px-3 py-1.5 text-center tracking-wider ring-1 ring-inset ring-border/60 select-all">
                            {c}
                        </li>
                    ))}
                </ul>
                <div className="flex gap-2">
                    <Button type="button" variant="outline" className="flex-1" onClick={copy}>
                        <Copy />
                        {t("security.recoveryCopyAll")}
                    </Button>
                    <Button type="button" variant="outline" className="flex-1" onClick={download}>
                        <Download />
                        {t("security.recoveryDownload")}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
