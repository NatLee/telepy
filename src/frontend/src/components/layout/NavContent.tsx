"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Terminal, Key, FileText, Settings, LogOut, ExternalLink, Shield, BookOpen } from "lucide-react";
import { useAuth } from "@/lib/auth";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

export const navLinks = [
    { name: "Tunnels", href: "/tunnels", icon: <Terminal size={18} /> },
    { name: "Keys", href: "/tunnels/keys", icon: <Key size={18} /> },
    { name: "Logs", href: "/tunnels/logs", icon: <FileText size={18} /> },
];

interface NavContentProps {
    onNavigate?: () => void;
    className?: string; // Used to style the bottom user section
}

export function NavContent({ onNavigate, className = "" }: NavContentProps) {
    const pathname = usePathname();
    const { user, logout } = useAuth();

    const handleLogout = () => {
        onNavigate?.();
        logout();
    };

    return (
        <>
            <div className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
                {navLinks.map((link) => {
                    const isActive = pathname === link.href || (pathname.startsWith(link.href) && link.href !== '/tunnels');
                    return (
                        <Link
                            key={link.name}
                            href={link.href}
                            onClick={onNavigate}
                            className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-all duration-200 hover:-translate-y-px ${isActive
                                    ? "bg-secondary text-secondary-foreground"
                                    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                                }`}
                        >
                            {link.icon}
                            {link.name}
                        </Link>
                    );
                })}

                {user?.is_superuser && (
                    <Link
                        href="/tunnels/settings"
                        onClick={onNavigate}
                        className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-all duration-200 hover:-translate-y-px ${pathname.startsWith('/tunnels/settings')
                                ? "bg-secondary text-secondary-foreground"
                                : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                            }`}
                    >
                        <Settings size={18} />
                        Settings
                    </Link>
                )}

                {user?.is_superuser && (
                    <>
                        <div className="my-3 border-t border-border" />
                        <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">Admin</p>
                        <a
                            href={`${API_BASE}/api/__hidden_admin/`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={onNavigate}
                            className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-all duration-200 hover:-translate-y-px"
                        >
                            <Shield size={18} />
                            Admin Panel
                            <ExternalLink size={12} className="ml-auto opacity-50" />
                        </a>
                        <a
                            href={`${API_BASE}/api/__hidden_swagger`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={onNavigate}
                            className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-all duration-200 hover:-translate-y-px"
                        >
                            <BookOpen size={18} />
                            API Docs
                            <ExternalLink size={12} className="ml-auto opacity-50" />
                        </a>
                    </>
                )}
            </div>

            <div className={`p-4 border-t border-border ${className}`}>
                {user && (
                    <div className="mb-4 px-2">
                        <p className="text-sm font-medium text-foreground truncate">{user.username}</p>
                        <p className="text-xs text-muted-foreground truncate">{user.is_superuser ? 'Administrator' : 'User'}</p>
                    </div>
                )}
                <button
                    onClick={handleLogout}
                    className="flex w-full items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                >
                    <LogOut size={18} />
                    Logout
                </button>
            </div>
        </>
    );
}
