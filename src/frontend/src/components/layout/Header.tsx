"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetHeader, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { WebSocketStatusBadge } from "@/components/ui/WebSocketStatusBadge";
import { NavContent, navLinks, isNavActive } from "./NavContent";
import { BrandMark } from "./BrandMark";
import { useI18n } from "@/lib/i18n";

export function Header() {
    const pathname = usePathname();
    const [isOpen, setIsOpen] = useState(false);
    const { t } = useI18n();

    // Get current page name for header title
    const currentLink = navLinks.find(link => isNavActive(pathname, link.href));
    const currentPage = currentLink
        ? t(currentLink.key)
        : (pathname.startsWith('/tunnels/settings') ? t("nav.settings") : t("nav.dashboard"));

    return (
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border/70 bg-background/70 backdrop-blur-xl px-4 sm:px-6">
            <Sheet open={isOpen} onOpenChange={setIsOpen}>
                <SheetTrigger asChild>
                    <Button variant="ghost" size="icon" className="md:hidden">
                        <Menu size={20} />
                        <span className="sr-only">{t("nav.toggleMenu")}</span>
                    </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-64 p-0 flex flex-col bg-sidebar">
                    <SheetHeader className="h-16 flex justify-center border-b border-sidebar-border px-4">
                        <SheetTitle className="m-0 p-0 text-left">
                            <Link href="/tunnels" className="flex items-center" onClick={() => setIsOpen(false)}>
                                <BrandMark />
                            </Link>
                        </SheetTitle>
                        <SheetDescription className="sr-only">
                            {t("nav.navigationMenu")}
                        </SheetDescription>
                    </SheetHeader>
                    <NavContent onNavigate={() => setIsOpen(false)} className="mt-auto" />
                </SheetContent>
            </Sheet>

            <div className="flex-1 min-w-0">
                <h1 className="text-base sm:text-lg font-semibold text-foreground truncate">{currentPage}</h1>
            </div>

            {/* 通知 WebSocket 狀態：全站共用一條連線，放在標題列每頁都看得到。
                The notification WebSocket is app-wide, so its status lives in the header on every page. */}
            <div className="shrink-0 rounded-full border border-border/70 bg-card/70 px-2.5 py-1">
                <WebSocketStatusBadge />
            </div>
        </header>
    );
}
