/**
 * Telepy 品牌標誌：漸層圖示 + 字標，側邊欄與手機選單共用。全站唯一保留品牌漸層的地方（logo 方塊），不加光暈。
 * Telepy brand mark (gradient tile + wordmark), shared by the sidebar and the mobile menu. The logo tile is the
 * one place that keeps the brand gradient — no glow.
 */
import React from "react";
import { cn } from "@/lib/utils";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";

export function BrandMark({ collapsed = false, className }: { collapsed?: boolean; className?: string }) {
    return (
        <span className={cn("flex items-center gap-2.5 min-w-0", className)}>
            <span className="grid place-items-center size-8 rounded-lg bg-brand-gradient shrink-0">
                <TelepyGlyph size={18} className="text-white" />
            </span>
            {!collapsed && (
                <span className="flex flex-col min-w-0 leading-none">
                    <span className="text-base tracking-tight text-foreground truncate">Telepy</span>
                    <span className="mt-0.5 text-[0.75rem] text-muted-foreground truncate">Reverse SSH</span>
                </span>
            )}
        </span>
    );
}
