"use client";

/**
 * API 頁頂端的基底網址：一列——標籤、等寬網址（太長就截斷、完整網址在 title）、複製按鈕。
 * CLI 說明與完整參考（Swagger）在頁首的動作列，「三條路怎麼比」在資訊按鈕的對話框（WaysInDialog）。
 * The API page's base URL: one row — label, mono URL (truncated, full text in the title) and a copy button.
 * The CLI guide and the full reference (Swagger) are header actions; "three ways in" is the info button's dialog.
 */
import React from "react";
import { CopyButton } from "@/components/ui/CopyButton";
import { useI18n } from "@/lib/i18n";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";
export const CLI_DOC_URL = "https://github.com/NatLee/telepy/blob/main/docs/cli.md";

export function ApiOverview({ baseUrl }: { baseUrl: string }) {
    const { t } = useI18n();
    return (
        <section className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-card-foreground shadow-card" aria-label={t("apiPage.baseUrl")}>
            <span className="shrink-0 text-sm text-muted-foreground">{t("apiPage.baseUrl")}</span>
            <div className="flex min-w-0 flex-1 items-center gap-1 rounded-lg bg-surface py-0.5 pl-3 pr-0.5 ring-1 ring-inset ring-border/80">
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground" title={baseUrl}>
                    {baseUrl || "…"}
                </span>
                {baseUrl && <CopyButton value={baseUrl} />}
            </div>
        </section>
    );
}
