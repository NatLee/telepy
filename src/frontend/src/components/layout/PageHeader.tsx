/**
 * 每頁頂端的標題區:標題(可附 tooltip / 狀態)+ 說明 + 右側動作按鈕。各頁共用,間距與字級一致。
 * 跟 Cloudflare / Tailscale 的主控台一樣,標題只有文字——不放圖示方塊;`icon` 仍可傳(舊呼叫端),但只在手機寬度
 * 當成標題前的小灰色圖示,桌面不顯示。
 * Page title block shared by every page: title (with optional addon such as an info tooltip or a status badge),
 * description and right-aligned actions. Like the Cloudflare / Tailscale consoles the title is text only — no icon
 * tile; `icon` is still accepted and shows as a small muted glyph before the title on phones only.
 */
import React from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
    icon?: React.ReactNode;
    title: React.ReactNode;
    /** 標題右側的小元件(說明 tooltip、連線狀態…)。/ Small element after the title (info tooltip, status…). */
    titleAddon?: React.ReactNode;
    description?: React.ReactNode;
    actions?: React.ReactNode;
    className?: string;
}

export function PageHeader({ icon, title, titleAddon, description, actions, className }: PageHeaderProps) {
    return (
        <div className={cn("flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)}>
            <div className="min-w-0">
                <h1 className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xl leading-tight tracking-tight text-foreground">
                    {icon && <span className="text-muted-foreground sm:hidden [&_svg]:size-5" aria-hidden>{icon}</span>}
                    {title}
                    {titleAddon}
                </h1>
                {description && <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted-foreground">{description}</p>}
            </div>
            {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
    );
}
