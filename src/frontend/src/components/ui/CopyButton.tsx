"use client";

/** 單一值的複製按鈕(複製後短暫顯示勾勾)。/ Icon button that copies one value and briefly shows a check. */
import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export function CopyButton({ value }: { value: string }) {
    const { t } = useI18n();
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            onClick={() =>
                navigator.clipboard.writeText(value).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                })
            }
            title={t("ui.copyToClipboard")}
            aria-label={t("ui.copyToClipboard")}
            className="shrink-0 grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
            {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
        </button>
    );
}
