"use client";

/**
 * 桌面版側邊欄:可收合(w-64 ⇄ w-16),狀態存 localStorage 跨頁記住。
 * 收合時導覽只顯示 icon(hover 有 title 提示),語言切換器與登出也縮成 icon。
 * Desktop sidebar: collapsible (w-64 ⇄ w-16); the state persists in localStorage.
 * When collapsed, nav items render icon-only with title tooltips.
 */
import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Terminal, ChevronsLeft, ChevronsRight } from "lucide-react";
import { NavContent } from "./NavContent";
import { useI18n } from "@/lib/i18n";

const COLLAPSED_STORAGE_KEY = "telepy.sidebarCollapsed";

export function Sidebar() {
    const { t } = useI18n();
    const [collapsed, setCollapsed] = useState(false);

    // localStorage 只在掛載後讀(SSR 沒有);預設展開,讀到收合再切換。
    // Read localStorage after mount (not available during SSR); default expanded.
    useEffect(() => {
        if (localStorage.getItem(COLLAPSED_STORAGE_KEY) === "1") {
            setCollapsed(true);
        }
    }, []);

    const toggle = () => {
        setCollapsed((prev) => {
            localStorage.setItem(COLLAPSED_STORAGE_KEY, prev ? "0" : "1");
            return !prev;
        });
    };

    return (
        <aside
            className={`hidden md:flex flex-col ${collapsed ? "w-16" : "w-64"} border-r border-border bg-sidebar shrink-0 h-screen sticky top-0 transition-[width] duration-200`}
        >
            <div className={`h-16 flex items-center border-b border-border ${collapsed ? "justify-center px-2" : "justify-between px-4"}`}>
                <Link href="/tunnels" className="flex items-center gap-2 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
                        <Terminal size={18} className="text-primary-foreground" />
                    </div>
                    {!collapsed && (
                        <span className="text-xl font-bold text-foreground tracking-wide truncate">
                            Telepy
                        </span>
                    )}
                </Link>
                {!collapsed && (
                    <button
                        type="button"
                        onClick={toggle}
                        title={t("nav.collapseSidebar")}
                        aria-label={t("nav.collapseSidebar")}
                        className="p-1.5 rounded-md text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-colors shrink-0"
                    >
                        <ChevronsLeft size={16} />
                    </button>
                )}
            </div>

            {collapsed && (
                <button
                    type="button"
                    onClick={toggle}
                    title={t("nav.expandSidebar")}
                    aria-label={t("nav.expandSidebar")}
                    className="mx-2 mt-2 p-1.5 rounded-md text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-colors flex justify-center"
                >
                    <ChevronsRight size={16} />
                </button>
            )}

            <NavContent collapsed={collapsed} />
        </aside>
    );
}
