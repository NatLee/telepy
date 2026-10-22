"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Menu } from "lucide-react";
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
    // 不在導覽列裡的頁面:設定(管理員區)、建立通道、終端機(屬於通道)。
    // Pages outside navLinks: settings (admin section), the create wizard, the terminal (part of Tunnels).
    const currentPage = currentLink
        ? t(currentLink.key)
        : pathname.startsWith("/tunnels/settings") ? t("nav.settings")
            : pathname.startsWith("/tunnels/create") ? t("wizard.title")
                : pathname.startsWith("/tunnels/terminal") ? t("nav.tunnels")
                    : t("nav.dashboard");

    return (
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background px-4 sm:px-6">
            <Sheet open={isOpen} onOpenChange={setIsOpen}>
                <SheetTrigger asChild>
                    <Button variant="ghost" size="icon" className="md:hidden">
                        <Menu size={20} />
                        <span className="sr-only">{t("nav.toggleMenu")}</span>
                    </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-72 p-0 flex flex-col gap-0 bg-sidebar">
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

            {/* 麵包屑:各頁自己有大標題(PageHeader),這裡只標示位置。
                Breadcrumb only — each page renders its own large title (PageHeader). */}
            <nav aria-label="breadcrumb" className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
                <span className="hidden text-muted-foreground sm:inline">Telepy</span>
                <ChevronRight size={14} className="hidden shrink-0 text-muted-foreground/50 sm:block" aria-hidden />
                <span className="truncate text-foreground" aria-current="page">{currentPage}</span>
            </nav>

            {/* 通知 WebSocket 狀態：全站共用一條連線，放在標題列每頁都看得到。
                The notification WebSocket is app-wide, so its status lives in the header on every page. */}
            <div className="shrink-0">
                <WebSocketStatusBadge />
            </div>
        </header>
    );
}
