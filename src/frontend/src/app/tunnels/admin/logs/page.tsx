"use client";

/**
 * 管理區的稽核日誌：全站每一條隧道的 gateway 事件，加上沒有隧道的站台事件，以及完整性驗證。只有管理員。
 * The admin section's audit log: gateway events of every tunnel on the site plus the tunnel-less site events, and
 * the integrity check. Admins only.
 */
import React, { Suspense } from "react";
import { AdminGate } from "@/components/layout/AdminViews";
import { LogsView } from "@/components/logs/LogsView";
import { useI18n } from "@/lib/i18n";

export default function AdminLogsPage() {
    const { t } = useI18n();
    return (
        <AdminGate mineHref="/tunnels/logs" mineLabel={t("nav.logs")}>
            <Suspense fallback={null}>
                <LogsView scope="all" />
            </Suspense>
        </AdminGate>
    );
}
