/**
 * 建立精靈內檢視/複製金鑰的彈窗。
 * Key view/copy modal used inside create wizard.
 */
import React from "react";
import { Copy } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export interface KeyViewModalProps {
    isOpen: boolean;
    title: string;
    content: string;
    onClose: () => void;
    onCopySuccess: () => void;
}

export function KeyViewModal({ isOpen, title, content, onClose, onCopySuccess }: KeyViewModalProps) {
    const { t, tn } = useI18n();
    if (!isOpen) return null;

    const handleCopy = () => {
        navigator.clipboard.writeText(content);
        onCopySuccess();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="fixed inset-0 bg-black/50" onClick={onClose} aria-hidden />
            <div className="relative bg-background text-foreground rounded-xl shadow-2xl border border-border max-w-xl w-full p-6 z-10">
                <h3 className="text-lg font-bold text-foreground mb-1">{title}</h3>
                <p className="text-xs text-muted-foreground mb-4">
                    {tn("wizard.keyViewInstruction", { path: <code className="bg-muted text-foreground border border-border px-1 rounded">~/.ssh/authorized_keys</code> })}
                </p>
                <textarea
                    readOnly
                    value={content}
                    rows={6}
                    className="w-full border border-input rounded-lg px-4 py-3 text-xs font-mono bg-muted/50 text-foreground resize-none focus:outline-none"
                />
                <div className="mt-4 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={handleCopy}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors"
                    >
                        <Copy size={14} /> {t("common.copy")}
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 text-sm font-medium text-secondary-foreground bg-secondary hover:bg-secondary/80 rounded-lg transition-colors"
                    >
                        {t("common.close")}
                    </button>
                </div>
            </div>
        </div>
    );
}
