"use client";

/**
 * 卡片 / 清單切換的兩顆按鈕。選擇存在帳號上（hooks/useViewMode.ts），這裡只負責畫與回報。
 * The card / list switch: two buttons. The choice lives on the account (hooks/useViewMode.ts); this only draws
 * and reports it.
 */
import { LayoutGrid, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ViewToggleProps } from "@/types/ui";

export function ViewToggle({ value, onChange, className }: ViewToggleProps) {
    const { t } = useI18n();
    const item = (mode: "card" | "list", icon: React.ReactNode, label: string) => (
        <Button
            variant={value === mode ? "outline" : "ghost"}
            size="sm"
            className={cn("h-7 rounded-sm px-2.5", value !== mode && "text-muted-foreground hover:text-foreground")}
            onClick={() => value !== mode && onChange(mode)}
            aria-label={label}
            aria-pressed={value === mode}
            title={label}
        >
            {icon}
        </Button>
    );
    return (
        <div className={cn("flex rounded-md border border-border bg-surface p-0.5", className)} role="group" aria-label={t("ui.viewToggle")}>
            {item("card", <LayoutGrid size={16} />, t("ui.cardView"))}
            {item("list", <List size={16} />, t("ui.listView"))}
        </div>
    );
}
