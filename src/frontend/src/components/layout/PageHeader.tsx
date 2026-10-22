/**
 * 每頁頂端的標題區:漸層圖示 + 標題(可附 tooltip / 狀態)+ 說明 + 右側動作按鈕。各頁共用,間距與字級一致。
 * Page title block shared by every page: gradient icon tile, title (with optional addon such as an
 * info tooltip or a status badge), description and right-aligned actions.
 */
import React from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
    icon: React.ReactNode;
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
            <div className="flex min-w-0 items-start gap-4">
                <div
                    className="hidden size-12 shrink-0 place-items-center rounded-2xl bg-brand-gradient text-white shadow-glow ring-1 ring-inset ring-white/20 sm:grid [&_svg]:size-[22px]"
                    aria-hidden
                >
                    {icon}
                </div>
                <div className="min-w-0">
                    <h1 className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[1.625rem] leading-tight tracking-tight text-foreground sm:text-[1.75rem]">
                        {title}
                        {titleAddon}
                    </h1>
                    {description && <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted-foreground">{description}</p>}
                </div>
            </div>
            {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
    );
}
