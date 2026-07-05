"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Terminal, Key, FileText, Settings, LogOut, ExternalLink, Shield, BookOpen } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { LanguageSwitcher } from "./LanguageSwitcher";

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

                {/* 設定頁現在含個人設定(語言),所有人都看得到。/ Settings now holds personal preferences — visible to everyone. */}
                <Link
                    href="/tunnels/settings"
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

            <div className={`p-4 border-t border-border space-y-1 ${className}`}>
                {/* 語言切換器固定在 sidebar 底部。/ Language switcher pinned to the sidebar footer. */}
                <LanguageSwitcher collapsed={collapsed} />

                {user && !collapsed && (
                    <div className="mb-2 mt-3 px-2">
                        <p className="text-sm font-medium text-foreground truncate">{user.username}</p>
                        <p className="text-xs text-muted-foreground truncate">{user.is_superuser ? t("nav.roleAdministrator") : t("nav.roleUser")}</p>
                    </div>
                )}
                <button
                    onClick={handleLogout}
                    title={collapsed ? t("nav.logout") : undefined}
                    className={`flex w-full items-center gap-3 ${linkLayout} py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors ${collapsed ? "justify-center" : ""}`}
                >
                    <LogOut size={18} />
                    {!collapsed && t("nav.logout")}
                </button>
            </div>
        </>
    );
}
