"use client";

/**
 * 管理區的「伺服器狀態」：`telepy-server doctor` 的檢查從網頁看，加上「Telepy 怎麼看你的位址」。只有管理員。
 * The admin section's "Server health": the `telepy-server doctor` checks from the web, plus "How Telepy sees your
 * address". Admins only.
 */
import React from "react";
import { AdminGate } from "@/components/layout/AdminViews";
import { ServerHealthView } from "@/components/health/ServerHealthView";

export default function AdminHealthPage() {
    return (
        <AdminGate>
            <ServerHealthView />
        </AdminGate>
    );
}
