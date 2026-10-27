"use client";

/**
 * 管理區的全站 API 活動：每個人的 API token 與 OAuth app token 打的 REST 請求、個人 token 的 MCP tool call，
 * 可依使用者篩選（`?user=`，管理使用者對話框連過來）。只有管理員。
 * The admin section's site-wide API activity: everyone's token REST calls and personal tokens' MCP tool calls,
 * filtered by user (`?user=`, linked from Manage user). Admins only.
 */
import React, { Suspense } from "react";
import { Braces } from "lucide-react";
import { AdminChip, AdminGate } from "@/components/layout/AdminViews";
import { PageHeader } from "@/components/layout/PageHeader";
import { Callout } from "@/components/ui/callout";
import { ApiCallsView } from "@/components/api/ApiCallsView";
import { useI18n } from "@/lib/i18n";

export default function AdminApiActivityPage() {
    const { t } = useI18n();
    return (
        <AdminGate mineHref="/tunnels/api?tab=activity" mineLabel={t("nav.api")}>
            <div className="animate-fade-in-up">
                <PageHeader className="mb-6" icon={<Braces />} title={t("apiPage.allTitle")} titleAddon={<AdminChip />} description={t("apiPage.allSubtitle")} />
                <Callout tone="info" className="mb-4">
                    {t("apiPage.allBanner")}
                </Callout>
                <Suspense fallback={null}>
                    <ApiCallsView scope="all" />
                </Suspense>
            </div>
        </AdminGate>
    );
}
