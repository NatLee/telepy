"use client";

/**
 * 桌面版側邊欄:可收合(w-64 ⇄ w-16),狀態存 localStorage 跨頁記住。
 * 收合時導覽只顯示 icon(hover 有 title 提示),語言切換器與登出也縮成 icon。
 * Desktop sidebar: collapsible (w-64 ⇄ w-16); the state persists in localStorage.
 * When collapsed, nav items render icon-only with title tooltips.
 */
import React, { useSyncExternalStore } from "react";
import Link from "next/link";
import { Terminal, ChevronsLeft, ChevronsRight } from "lucide-react";
import { NavContent } from "./NavContent";
import { useI18n } from "@/lib/i18n";

const COLLAPSED_STORAGE_KEY = "telepy.sidebarCollapsed";
const COLLAPSED_EVENT = "telepy:sidebar-collapsed";

// localStorage 當外部 store:SSR 一律展開,client 端 hydration 後讀實際值(React 對
// useSyncExternalStore 的 server/client snapshot 差異有正規處理,不會有 mismatch 錯誤)。
// localStorage as an external store: SSR renders expanded; the client snapshot takes over
// after hydration via the sanctioned useSyncExternalStore path (no mismatch warnings).
function subscribeCollapsed(callback: () => void) {
    window.addEventListener(COLLAPSED_EVENT, callback);
    return () => window.removeEventListener(COLLAPSED_EVENT, callback);
}

export function Sidebar() {
    const { t } = useI18n();
    const collapsed = useSyncExternalStore(
        subscribeCollapsed,
        () => localStorage.getItem(COLLAPSED_STORAGE_KEY) === "1",
        () => false,
    );

    const toggle = () => {
        localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? "0" : "1");
        window.dispatchEvent(new Event(COLLAPSED_EVENT));
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
