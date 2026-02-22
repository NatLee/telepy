"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Terminal } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetHeader, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { NavContent, navLinks } from "./NavContent";

export function Header() {
    const pathname = usePathname();
    const [isOpen, setIsOpen] = useState(false);

    // Get current page name for header title
    const currentPage = navLinks.find(
        link => pathname === link.href || (pathname.startsWith(link.href) && link.href !== '/tunnels')
    )?.name || (pathname.startsWith('/tunnels/settings') ? 'Settings' : 'Dashboard');

    return (
        <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-border bg-background px-4 sm:px-6 shadow-sm">
            <Sheet open={isOpen} onOpenChange={setIsOpen}>
                <SheetTrigger asChild>
                    <Button variant="ghost" size="icon" className="md:hidden">
                        <Menu size={20} />
                        <span className="sr-only">Toggle navigation menu</span>
                    </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-64 p-0 flex flex-col">
                    <SheetHeader className="h-16 flex items-center justify-center border-b border-border px-6">
                        <SheetTitle className="flex items-center gap-2 m-0 p-0 text-left w-full h-full">
                            <Link href="/tunnels" className="flex items-center gap-2 w-full h-full pt-4" onClick={() => setIsOpen(false)}>
                                <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
                                    <Terminal size={18} className="text-primary-foreground" />
                                </div>
                                <span className="text-xl font-bold text-foreground tracking-wide">
                                    Telepy
                                </span>
                            </Link>
                        </SheetTitle>
                        <SheetDescription className="sr-only">
                            Navigation Menu
                        </SheetDescription>
                    </SheetHeader>
                    <NavContent onNavigate={() => setIsOpen(false)} className="mt-auto" />
                </SheetContent>
            </Sheet>

            <div className="flex-1">
                <h1 className="text-lg font-semibold text-foreground">{currentPage}</h1>
            </div>
        </header>
    );
}
