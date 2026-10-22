/**
 * 對話框與設定頁共用的區塊元件:
 * - SectionHeading:小圖示 + 標題 + 一行說明(+ 右側動作)。取代各處手刻的 h3/text-xs 標題。
 * - PropertyList / Property:「標籤:值」的屬性清單(詳細資訊視窗用)。
 * - Chip:小圓角標籤(ID、埠號、權限等)。
 * Shared blocks for dialogs and settings pages: SectionHeading (icon + title + one-line description +
 * optional action), PropertyList / Property (label : value rows for details dialogs) and Chip.
 */
import * as React from "react";
import { cn } from "@/lib/utils";

export function SectionHeading({
    icon,
    title,
    description,
    action,
    as: Tag = "h3",
    className,
}: {
    icon?: React.ReactNode;
    title: React.ReactNode;
    description?: React.ReactNode;
    action?: React.ReactNode;
    as?: "h2" | "h3" | "h4";
    className?: string;
}) {
    return (
        <div className={cn("flex items-start justify-between gap-3", className)}>
            <div className="min-w-0 flex-1">
                <Tag className="flex items-center gap-2 text-base leading-snug text-foreground [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-primary">
                    {icon}
                    <span className="min-w-0 truncate">{title}</span>
                </Tag>
                {description && <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{description}</p>}
            </div>
            {action && <div className="shrink-0">{action}</div>}
        </div>
    );
}

/** 一個區塊 = 標題 + 內容,區塊之間留固定間距。/ Heading + content; sections share one spacing. */
export function Section({ children, className, ...heading }: React.ComponentProps<typeof SectionHeading> & { children: React.ReactNode }) {
    return (
        <section className={cn("space-y-3", className)}>
            <SectionHeading {...heading} />
            {children}
        </section>
    );
}

/** 屬性清單外框:凹槽底 + 細線分隔。/ Property list frame: well surface, hairline dividers. */
export function PropertyList({ children, className }: { children: React.ReactNode; className?: string }) {
    return <dl className={cn("divide-y divide-border/70 rounded-xl bg-surface px-4 ring-1 ring-inset ring-border/80", className)}>{children}</dl>;
}

export function Property({ label, children, mono = false }: { label: React.ReactNode; children: React.ReactNode; mono?: boolean }) {
    return (
        <div className="grid grid-cols-[minmax(6rem,9rem)_1fr] items-baseline gap-3 py-2.5 text-sm">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={cn("min-w-0 break-words text-foreground", mono && "font-mono")}>{children}</dd>
        </div>
    );
}

const CHIP_TONE = {
    neutral: "bg-muted text-muted-foreground",
    primary: "bg-primary/10 text-primary",
    success: "bg-success/10 text-success",
    warning: "bg-warning/12 text-warning",
    danger: "bg-destructive/10 text-destructive",
} as const;

export function Chip({
    children,
    tone = "neutral",
    mono = false,
    className,
    ...props
}: React.ComponentProps<"span"> & { tone?: keyof typeof CHIP_TONE; mono?: boolean }) {
    return (
        <span
            className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs leading-5 whitespace-nowrap [&>svg]:size-3.5", CHIP_TONE[tone], mono && "font-mono tabular-nums", className)}
            {...props}
        >
            {children}
        </span>
    );
}
