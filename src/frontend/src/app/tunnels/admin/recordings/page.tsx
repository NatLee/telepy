"use client";

/**
 * 管理區的全站錄影：每個人的終端機錄影，可依隧道、使用者篩選、播放、下載、刪除。只有管理員。
 * The admin section's site-wide recordings: everyone's terminal recordings, filtered by tunnel or user, with play,
 * download and delete. Admins only.
 */
import React, { Suspense } from "react";
import { AdminGate } from "@/components/layout/AdminViews";
import { RecordingsView } from "@/components/recordings/RecordingsView";
import { useI18n } from "@/lib/i18n";

export default function AdminRecordingsPage() {
    const { t } = useI18n();
    return (
        <AdminGate mineHref="/tunnels/recordings" mineLabel={t("nav.recordings")}>
            <Suspense>
                <RecordingsView scope="all" />
            </Suspense>
        </AdminGate>
    );
}
