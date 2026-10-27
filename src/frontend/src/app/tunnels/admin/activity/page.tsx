"use client";

/**
 * 管理區的全站 AI 活動：每個人的 AI session 與工具呼叫，可依隧道、使用者（`?user=`，管理使用者對話框連過來）與 app 篩選。只有管理員。
 * The admin section's site-wide AI activity: everyone's AI sessions and tool calls, filtered by tunnel, user (`?user=`,
 * linked from Manage user) and app. Admins only.
 */
import React, { Suspense } from "react";
import { AdminGate } from "@/components/layout/AdminViews";
import { AiActivityView } from "@/components/activity/AiActivityView";
import { useI18n } from "@/lib/i18n";

export default function AdminAiActivityPage() {
    const { t } = useI18n();
    return (
        <AdminGate mineHref="/tunnels/activity" mineLabel={t("nav.activity")}>
            <Suspense fallback={null}>
                <AiActivityView scope="all" />
            </Suspense>
        </AdminGate>
    );
}
