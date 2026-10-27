"use client";

/**
 * 管理區的全站即時連線：每個人現在連在哪台裝置上，可依隧道、使用者篩選、看終端機、結束。只有管理員。
 * The admin section's site-wide live sessions: everyone connected right now, filtered by tunnel or user, with
 * watch and end. Admins only.
 */
import React, { Suspense } from "react";
import { AdminGate } from "@/components/layout/AdminViews";
import { LiveSessionsView } from "@/components/sessions/LiveSessionsView";
import { useI18n } from "@/lib/i18n";

export default function AdminLiveSessionsPage() {
    const { t } = useI18n();
    return (
        <AdminGate mineHref="/tunnels/sessions" mineLabel={t("nav.sessions")}>
            <Suspense>
                <LiveSessionsView scope="all" />
            </Suspense>
        </AdminGate>
    );
}
