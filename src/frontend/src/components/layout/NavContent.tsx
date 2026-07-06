"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Terminal, Key, FileText, Settings, LogOut, ExternalLink, Shield, BookOpen, SlidersHorizontal } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { UserPreferencesModal } from "./UserPreferencesModal";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

// 導覽連結以翻譯 key 定義,Header 也用它反查目前頁面標題。
// Nav links carry translation keys; the Header reuses them to resolve the current page title.
export const navLinks: { key: TranslationKey; href: string; icon: React.ReactNode }[] = [
    { key: "nav.tunnels", href: "/tunnels", icon: <Terminal size={18} /> },
    { key: "nav.keys", href: "/tunnels/keys", icon: <Key size={18} /> },
    { key: "nav.logs", href: "/tunnels/logs", icon: <FileText size={18} /> },
];

interface NavContentProps {
    onNavigate?: () => void;
    className?: string; // Used to style the bottom user section
    /** 桌面版 sidebar 收合時只顯示 icon。/ Icon-only rendering for the collapsed desktop sidebar. */
    collapsed?: boolean;
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

    const linkLayout = collapsed ? "justify-center px-2" : "px-3";

    return (
        <>
            <div className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
                {navLinks.map((link) => {
                    const isActive = pathname === link.href || (pathname.startsWith(link.href) && link.href !== '/tunnels');
                    return (
                        <Link
                            key={link.key}
                            href={link.href}
                            // prefetch={false}：側邊欄常駐，主頁每 ~5s 因 WebSocket 延遲更新而 re-render，
                            // Next 的 router-tree hash 隨之改變會「反覆重抓」這幾條 nav 的 RSC(每條 route 一次
                            // 載入被抓 4~6 次),整批湧出把連線塞爆、拖慢真正在等的 dashboard/profile。內部工具
                            // 點導覽是刻意行為,點擊時才抓(多幾百毫秒)划算。See TunnelCard for the same rationale.
                            // Persistent sidebar × frequent re-renders made these nav routes re-prefetch
                            // repeatedly, flooding the connection; fetch on click instead.
                            prefetch={false}
                            onClick={onNavigate}
                            title={collapsed ? t(link.key) : undefined}
                            className={`flex items-center gap-3 ${linkLayout} py-2 rounded-md text-sm font-medium transition-all duration-200 hover:-translate-y-px ${isActive
                                    ? "bg-secondary text-secondary-foreground"
                                    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                                }`}
                        >
                            {link.icon}
                            {!collapsed && t(link.key)}
                        </Link>
                    );
                })}

                {/* 設定頁只剩站台管理(個人偏好在左下齒輪 modal),回歸管理員限定。
                    The settings page is admin-only again; personal preferences live in the gear modal. */}
                {user?.is_superuser && (
                    <Link
                        href="/tunnels/settings"
                        prefetch={false}
                        onClick={onNavigate}
                        title={collapsed ? t("nav.settings") : undefined}
                        className={`flex items-center gap-3 ${linkLayout} py-2 rounded-md text-sm font-medium transition-all duration-200 hover:-translate-y-px ${pathname.startsWith('/tunnels/settings')
                                ? "bg-secondary text-secondary-foreground"
                                : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                            }`}
                    >
                        <Settings size={18} />
                        {!collapsed && t("nav.settings")}
                    </Link>
                )}

                {user?.is_superuser && (
                    <>
                        <div className="my-3 border-t border-border" />
                        {!collapsed && (
                            <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">{t("nav.admin")}</p>
                        )}
                        <a
                            href={`${API_BASE}/api/__hidden_admin/`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={onNavigate}
                            title={collapsed ? t("nav.adminPanel") : undefined}
                            className={`flex items-center gap-3 ${linkLayout} py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-all duration-200 hover:-translate-y-px`}
                        >
                            <Shield size={18} />
                            {!collapsed && (
                                <>
                                    {t("nav.adminPanel")}
                                    <ExternalLink size={12} className="ml-auto opacity-50" />
                                </>
                            )}
                        </a>
                        <a
                            href={`${API_BASE}/api/__hidden_swagger`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={onNavigate}
                            title={collapsed ? t("nav.apiDocs") : undefined}
                            className={`flex items-center gap-3 ${linkLayout} py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-all duration-200 hover:-translate-y-px`}
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
            </div>

            <div className={`p-4 border-t border-border space-y-2 ${className}`}>
                {/* 語言:四顆並排按鈕,點一下直接切換;收合時是下拉選單。
                    Language: four inline buttons, one-click switch; a dropdown when collapsed. */}
                <LanguageSwitcher collapsed={collapsed} />

                {/* 主題:系統/淺色/深色三顆並排按鈕;收合時是下拉選單。
                    Theme: three inline buttons (system/light/dark); a dropdown when collapsed. */}
                <ThemeSwitcher collapsed={collapsed} />

                {/* 使用者列 + 偏好設定齒輪 / User row + preferences gear */}
                {user && !collapsed && (
                    <div className="flex items-center gap-2 px-2 pt-1">
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-foreground truncate">{user.username}</p>
                            <p className="text-xs text-muted-foreground truncate">{user.is_superuser ? t("nav.roleAdministrator") : t("nav.roleUser")}</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setPrefsOpen(true)}
                            title={t("nav.preferences")}
                            aria-label={t("nav.preferences")}
                            className="p-2 rounded-md text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors shrink-0"
                        >
                            <SlidersHorizontal size={16} />
                        </button>
                    </div>
                )}
                {user && collapsed && (
                    <button
                        type="button"
                        onClick={() => setPrefsOpen(true)}
                        title={t("nav.preferences")}
                        aria-label={t("nav.preferences")}
                        className="flex w-full items-center justify-center px-2 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-colors"
                    >
                        <SlidersHorizontal size={18} />
                    </button>
                )}

                <button
                    type="button"
                    onClick={handleLogout}
                    title={collapsed ? t("nav.logout") : undefined}
                    aria-label={t("nav.logout")}
                    className={`flex w-full items-center gap-3 ${linkLayout} py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors ${collapsed ? "justify-center" : ""}`}
                >
                    <LogOut size={18} />
                    {!collapsed && t("nav.logout")}
                </button>
            </div>

            <UserPreferencesModal isOpen={prefsOpen} onClose={() => setPrefsOpen(false)} />
        </>
    );
}
