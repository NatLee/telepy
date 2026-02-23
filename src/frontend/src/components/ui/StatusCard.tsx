/**
 * 狀態/空狀態卡：標題、說明、按鈕，用於無連線、權限拒絕、無使用者等情境。
 * Status / empty state card: title, message, and action button for no-connection, denied, no-users, etc.
 */
import React from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export type StatusCardVariant = "default" | "destructive" | "warning";

export interface StatusCardProps {
    /** 標題 / Title */
    title: string;
    /** 說明內容，可為字串或 React 節點 / Message, string or React node */
    message: React.ReactNode;
    /** 標題旁圖示 / Icon next to title */
    icon: React.ReactNode;
    /** 樣式變體：預設、錯誤、警告 / Variant: default, error, warning */
    variant?: StatusCardVariant;
    /** 按鈕文字 / Button label */
    actionLabel: string;
    /** 按鈕點擊 / Button click handler */
    onAction: () => void;
    /** 外層容器 class，用於置中與高度 / Wrapper class for centering and height */
    className?: string;
}

const variantClasses: Record<StatusCardVariant, { card: string; title: string }> = {
    default: { card: "border-border/50 shadow-sm", title: "text-foreground" },
    destructive: { card: "border-destructive/30 shadow-sm", title: "text-destructive" },
    warning: { card: "border-warning/30 shadow-sm", title: "text-warning" },
};

export function StatusCard({
    title,
    message,
    icon,
    variant = "default",
    actionLabel,
    onAction,
    className = "flex items-center justify-center h-[calc(100dvh-4rem)] md:h-[calc(100dvh-5rem)] p-4 bg-background w-full",
}: StatusCardProps) {
    const { card, title: titleClass } = variantClasses[variant];

    return (
        <div className={className}>
            <Card className={`max-w-md w-full ${card}`}>
                <CardHeader>
                    <CardTitle className={`flex items-center gap-2 ${titleClass}`}>
                        {icon}
                        {title}
                    </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                    <div className="text-sm text-muted-foreground">{message}</div>
                    <Button onClick={onAction} className="w-full">
                        {actionLabel}
                    </Button>
                </CardContent>
            </Card>
        </div>
    );
}
