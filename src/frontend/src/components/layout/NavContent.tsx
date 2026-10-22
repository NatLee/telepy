"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Network, Key, FileText, Settings, LogOut, ExternalLink, BookOpen, SlidersHorizontal, SquareTerminal, Bot, Plug, Waypoints } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { UserPreferencesModal } from "./UserPreferencesModal";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

interface NavLink {
    key: TranslationKey;
    href: string;
    icon: React.ReactNode;
}

// 導覽連結以翻譯 key 定義,依區段分組;Header 用攤平後的 navLinks 反查目前頁面標題。
// Nav links carry translation keys and are grouped by section; the Header resolves the current
// page title from the flattened navLinks.
export const navSections: { key: TranslationKey; links: NavLink[] }[] = [
    {
        key: "nav.sectionWorkspace",
        links: [
            { key: "nav.tunnels", href: "/tunnels", icon: <Network size={18} /> },
            { key: "nav.cheatsheet", href: "/tunnels/cheatsheet", icon: <SquareTerminal size={18} /> },
            { key: "nav.network", href: "/tunnels/network", icon: <Waypoints size={18} /> },
            { key: "nav.keys", href: "/tunnels/keys", icon: <Key size={18} /> },
            { key: "nav.logs", href: "/tunnels/logs", icon: <FileText size={18} /> },
        ],
    },
    {
        // AI 工具(MCP):連線設定 + 已連接的 app,以及 AI 開的 session 與紀錄。
        // AI tools (MCP): connection setup + connected apps, and the sessions / audit log.
        key: "nav.sectionAi",
        links: [
            { key: "nav.mcp", href: "/tunnels/mcp", icon: <Plug size={18} /> },
            { key: "nav.activity", href: "/tunnels/activity", icon: <Bot size={18} /> },
        ],
    },
];

export const navLinks: NavLink[] = navSections.flatMap((section) => section.links);

/** /tunnels 只比對自己,其他連結比對前綴。/ /tunnels matches exactly; the others match by prefix. */
export function isNavActive(pathname: string, href: string) {
    return pathname === href || (href !== "/tunnels" && pathname.startsWith(href));
}

interface NavContentProps {
    onNavigate?: () => void;
    className?: string; // Used to style the bottom user section
    /** 桌面版 sidebar 收合時只顯示 icon。/ Icon-only rendering for the collapsed desktop sidebar. */
    collapsed?: boolean;
}

/** 目前頁面是浮起的白色膠囊(圖示轉主色),其餘是安靜的灰字。/ The current page is a raised pill with a brand-tinted icon. */
function navItemClass(active: boolean, collapsed: boolean) {
    return cn(
        "group relative flex items-center gap-3 py-2 rounded-xl text-sm transition-[color,background-color,box-shadow] duration-150",
        collapsed ? "justify-center px-2" : "px-3",
        active
            ? "bg-card text-foreground shadow-card ring-1 ring-sidebar-border [&>svg]:text-primary"
            : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
    );
}

function SectionLabel({ children, collapsed }: { children: React.ReactNode; collapsed: boolean }) {
    if (collapsed) return <div className="my-3 mx-2 border-t border-sidebar-border" />;
    return (
        <p className="px-3 pt-5 pb-1.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/70">
            {children}
        </p>
    );
}

export function NavContent({ onNavigate, className = "", collapsed = false }: NavContentProps) {
    const pathname = usePathname();
    const { user, logout } = useAuth();
    const { t } = useI18n();
    const [prefsOpen, setPrefsOpen] = useState(false);

    const handleLogout = () => {
        onNavigate?.();
        logout();
    };

    const settingsActive = pathname.startsWith("/tunnels/settings");

    return (
        <>
            <nav className="flex-1 overflow-y-auto px-3 pb-4 space-y-0.5">
                {navSections.map((section) => (
                    <React.Fragment key={section.key}>
                        <SectionLabel collapsed={collapsed}>{t(section.key)}</SectionLabel>
                        {section.links.map((link) => {
                            const active = isNavActive(pathname, link.href);
                            return (
                                <Link
                                    key={link.key}
                                    href={link.href}
                                    // prefetch={false}：側邊欄常駐，主頁每 ~5s 因 WebSocket 延遲更新而 re-render，
                                    // Next 的 router-tree hash 隨之改變會「反覆重抓」這幾條 nav 的 RSC(每條 route 一次
                                    // 載入被抓 4~6 次),整批湧出把連線塞爆、拖慢真正在等的 dashboard/profile。內部工具
                                    // 點導覽是刻意行為,點擊時才抓(多幾百毫秒)划算。See TunnelOpenButtons for the same rationale.
                                    // Persistent sidebar × frequent re-renders made these nav routes re-prefetch
                                    // repeatedly, flooding the connection; fetch on click instead.
                                    prefetch={false}
                                    onClick={onNavigate}
                                    title={collapsed ? t(link.key) : undefined}
                                    aria-current={active ? "page" : undefined}
                                    className={navItemClass(active, collapsed)}
                                >
                                    {link.icon}
                                    {!collapsed && t(link.key)}
                                </Link>
                            );
                        })}
                    </React.Fragment>
                ))}

                {/* 設定頁只剩站台管理(個人偏好在左下齒輪 modal),回歸管理員限定。Django admin 已隨後端改寫移除,
                    所以這裡只剩設定頁與 API 文件。
                    The settings page is admin-only; personal preferences live in the gear modal. The Django
                    admin panel went away with the Rust backend, so only Settings and the API docs remain. */}
                {user?.is_superuser && (
                    <>
                        <SectionLabel collapsed={collapsed}>{t("nav.admin")}</SectionLabel>
                        <Link
                            href="/tunnels/settings"
                            prefetch={false}
                            onClick={onNavigate}
                            title={collapsed ? t("nav.settings") : undefined}
                            aria-current={settingsActive ? "page" : undefined}
                            className={navItemClass(settingsActive, collapsed)}
                        >
                            <Settings size={18} />
                            {!collapsed && t("nav.settings")}
                        </Link>
                        <a
                            href={`${API_BASE}/api/__hidden_swagger`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={onNavigate}
                            title={collapsed ? t("nav.apiDocs") : undefined}
                            className={navItemClass(false, collapsed)}
                        >
                            <BookOpen size={18} />
                            {!collapsed && (
                                <>
                                    {t("nav.apiDocs")}
                                    <ExternalLink size={12} className="ml-auto opacity-50" />
                                </>
                            )}
                        </a>
                    </>
                )}
            </nav>

            <div className={`p-3 border-t border-sidebar-border space-y-2.5 ${className}`}>
                {/* 語言(Auto/EN/繁/日)與主題(系統/淺色/深色)並排成同一列的兩條分段軌道,一鍵切換;
                    收合時各自變成下拉選單。
                    Language (Auto/EN/繁/日) and theme (system/light/dark) share one row as two segmented
                    tracks, one click to switch; each becomes a dropdown when collapsed. */}
                <div className={collapsed ? "space-y-2" : "flex gap-1.5"}>
                    <LanguageSwitcher collapsed={collapsed} className="flex-[4]" />
                    <ThemeSwitcher collapsed={collapsed} className="flex-[3]" />
                </div>

                {/* 使用者列 + 偏好設定齒輪 + 登出 / User row + preferences gear + logout */}
                {user && !collapsed && (
                    <div className="flex items-center gap-2.5 rounded-xl bg-card/80 p-2 shadow-card ring-1 ring-sidebar-border">
                        <span className="grid place-items-center w-8 h-8 rounded-full bg-brand-gradient text-white text-sm shrink-0 uppercase" aria-hidden>
                            {(user.username ?? "?").slice(0, 1)}
                        </span>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm text-foreground truncate leading-tight">{user.username}</p>
                            <p className="text-[11px] text-muted-foreground truncate leading-tight mt-0.5">{user.is_superuser ? t("nav.roleAdministrator") : t("nav.roleUser")}</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setPrefsOpen(true)}
                            title={t("nav.preferences")}
                            aria-label={t("nav.preferences")}
                            className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors shrink-0"
                        >
                            <SlidersHorizontal size={16} />
                        </button>
                        <button
                            type="button"
                            onClick={handleLogout}
                            title={t("nav.logout")}
                            aria-label={t("nav.logout")}
                            className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors shrink-0"
                        >
                            <LogOut size={16} />
                        </button>
                    </div>
                )}
                {user && collapsed && (
                    <>
                        <button
                            type="button"
                            onClick={() => setPrefsOpen(true)}
                            title={t("nav.preferences")}
                            aria-label={t("nav.preferences")}
                            className="flex w-full items-center justify-center px-2 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors"
                        >
                            <SlidersHorizontal size={18} />
                        </button>
                        <button
                            type="button"
                            onClick={handleLogout}
                            title={t("nav.logout")}
                            aria-label={t("nav.logout")}
                            className="flex w-full items-center justify-center px-2 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                        >
                            <LogOut size={18} />
                        </button>
                    </>
                )}
            </div>

            <UserPreferencesModal isOpen={prefsOpen} onClose={() => setPrefsOpen(false)} />
        </>
    );
}
