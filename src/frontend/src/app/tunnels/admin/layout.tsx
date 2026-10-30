"use client";

/**
 * 管理區（/tunnels/admin/*）的外框：把同一區的分頁交給每頁的 PageHeader（components/layout/AdminAreaNav）。
 * The admin section's frame: hands the area's tabs to each page's PageHeader (components/layout/AdminAreaNav).
 */
import React from "react";
import { AdminAreaNav, PageHeaderNav } from "@/components/layout/AdminAreaNav";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
    return <PageHeaderNav.Provider value={<AdminAreaNav />}>{children}</PageHeaderNav.Provider>;
}
