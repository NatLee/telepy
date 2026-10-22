/**
 * Telepy 品牌標誌：漸層圖示 + 字標，側邊欄與手機選單共用。
 * Telepy brand mark (gradient tile + wordmark), shared by the sidebar and the mobile menu.
 */
import React from "react";
import { Cable } from "lucide-react";
import { cn } from "@/lib/utils";

export function BrandMark({ collapsed = false, className }: { collapsed?: boolean; className?: string }) {
    return (
        <span className={cn("flex items-center gap-2.5 min-w-0", className)}>
            <span className="relative grid place-items-center w-9 h-9 rounded-xl bg-brand-gradient shadow-glow shrink-0">
                <Cable size={18} className="text-white" strokeWidth={2.25} />
                <span className="absolute inset-0 rounded-xl ring-1 ring-inset ring-white/25" aria-hidden />
            </span>
            {!collapsed && (
                <span className="flex flex-col min-w-0 leading-none">
                    <span className="text-lg font-bold tracking-tight text-foreground truncate">Telepy</span>
                    <span className="mt-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground truncate">
                        Reverse SSH
                    </span>
                </span>
            )}
        </span>
    );
}
