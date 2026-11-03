"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetHeader, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { WebSocketStatusBadge } from "@/components/ui/WebSocketStatusBadge";
import { NavContent, navLinks, isLinkActive, activeChild } from "./NavContent";
import { BrandMark } from "./BrandMark";
import { useI18n } from "@/lib/i18n";
import { shownCrumbs, type Crumb } from "@/lib/breadcrumbs";
import { usePageCrumbValue } from "@/hooks/usePageCrumb";
import { cn } from "@/lib/utils";

export function Header() {
    const pathname = usePathname();
    const [isOpen, setIsOpen] = useState(false);
    const { t } = useI18n();

    // Get current page name for header title
    const currentLink = navLinks.find((link) => isLinkActive(link, pathname));
    // 有子頁的區（SSH 金鑰、管理區的幾區）：麵包屑多一層。/ Areas with sub-pages (SSH keys, the admin areas) get one more crumb.
    const currentChild = currentLink ? activeChild(currentLink, pathname) : undefined;
    // 頁面自己加的最後一段（通道頁面 = 通道名稱）。/ The page's own last crumb (a tunnel's page = its name).
    const pageCrumb = usePageCrumbValue();

    // Telepy 回首頁；區段能點回去（除非就在它那頁）；頁面加的那段是最後一段。
    // Telepy goes home; a section leads back (unless you are on it); the page's own crumb comes last.
    const crumbs: Crumb[] = [{ label: "Telepy", href: "/tunnels" }];
    if (currentLink) {
        crumbs.push({ label: t(currentLink.key), href: currentLink.href });
        if (currentChild) crumbs.push({ label: t(currentChild.key), href: currentChild.href });
    } else if (pathname.startsWith("/tunnels/create")) {
        // 建立通道算在「通道」底下。/ The create wizard sits under Tunnels.
        crumbs.push({ label: t("nav.tunnels"), href: "/tunnels" }, { label: t("wizard.title"), href: "/tunnels/create" });
    } else {
        // 不在導覽列裡的頁面。/ Pages outside navLinks.
        crumbs.push({ label: pathname.startsWith("/tunnels/settings") ? t("nav.settings") : t("nav.dashboard") });
    }
    if (pageCrumb) crumbs.push({ label: pageCrumb });
    const shown = shownCrumbs(crumbs, pathname);

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
                                <BrandMark playful />
                            </Link>
                        </SheetTitle>
                        <SheetDescription className="sr-only">
                            {t("nav.navigationMenu")}
                        </SheetDescription>
                    </SheetHeader>
                    <NavContent onNavigate={() => setIsOpen(false)} className="mt-auto" />
                </SheetContent>
            </Sheet>

            {/* 麵包屑:各頁自己有大標題(PageHeader),這裡標示位置,前面每一段都能點回去。手機上只留最後兩段。
                Breadcrumb — each page renders its own large title (PageHeader); every earlier crumb leads back. Phones keep the last two. */}
            <nav aria-label="breadcrumb" className="min-w-0 flex-1 text-sm">
                <ol className="flex min-w-0 items-center gap-1.5">
                    {shown.map((c, i) => {
                        const phoneHidden = i < shown.length - 2;
                        return (
                            <li key={`${i}-${c.label}`} className={cn("flex items-center gap-1.5", c.current ? "min-w-0" : "shrink-0", phoneHidden && "max-sm:hidden")}>
                                {/* 手機上第一個看得到的那段前面不畫箭頭。/ No arrow before the first crumb shown on phones. */}
                                {i > 0 && <ChevronRight size={14} className={cn("shrink-0 text-muted-foreground/50", i === shown.length - 2 && "max-sm:hidden")} aria-hidden />}
                                {c.link ? (
                                    <Link
                                        href={c.href!}
                                        prefetch={false}
                                        aria-current={c.current ? "page" : undefined}
                                        className={cn("truncate rounded-sm hover:text-foreground hover:underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60", c.current ? "text-foreground" : "text-muted-foreground")}
                                    >
                                        {c.label}
                                    </Link>
                                ) : (
                                    <span className={cn("truncate", c.current ? "text-foreground" : "text-muted-foreground")} aria-current={c.current ? "page" : undefined}>
                                        {c.label}
                                    </span>
                                )}
                            </li>
                        );
                    })}
                </ol>
            </nav>

            {/* 通知 WebSocket 狀態：全站共用一條連線，放在標題列每頁都看得到。
                The notification WebSocket is app-wide, so its status lives in the header on every page. */}
            <div className="shrink-0">
                <WebSocketStatusBadge />
            </div>
        </header>
    );
}
