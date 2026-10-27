"use client";

/**
 * 日誌頁：自己擁有或被分享的隧道的 gateway 事件（管理員也一樣；全站的在管理區的稽核日誌）。
 * The Logs page: gateway events of the tunnels you own or that are shared with you (admins too; the whole site's are
 * in the admin section's audit log).
 */
import React, { Suspense } from "react";
import { LogsView } from "@/components/logs/LogsView";

export default function LogsPage() {
    // useSearchParams 需要 Suspense 邊界，否則靜態產生會整頁退回 client render。
    // useSearchParams needs a Suspense boundary or static generation bails out for the whole page.
    return (
        <Suspense fallback={null}>
            <LogsView scope="mine" />
        </Suspense>
    );
}
