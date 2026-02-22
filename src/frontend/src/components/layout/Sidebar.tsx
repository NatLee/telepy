"use client";

import React from "react";
import Link from "next/link";
import { Terminal } from "lucide-react";
import { NavContent } from "./NavContent";

export function Sidebar() {
    return (
        <aside className="hidden md:flex flex-col w-64 border-r border-border bg-sidebar shrink-0 h-screen sticky top-0">
            <div className="h-16 flex items-center px-6 border-b border-border">
                <Link href="/tunnels" className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
                        <Terminal size={18} className="text-primary-foreground" />
                    </div>
                    <span className="text-xl font-bold text-foreground tracking-wide">
                        Telepy
                    </span>
                </Link>
            </div>

            <NavContent />
        </aside>
    );
}
