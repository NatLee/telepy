/**
 * 分段膠囊切換:灰色軌道 + 浮起的白色選取塊。用於分頁(kind="tabs")或單選(kind="toggle")。
 * Segmented control: a muted track with a raised selected segment. Works as tabs (kind="tabs",
 * role=tab + aria-selected) or as a single-choice toggle (kind="toggle", aria-pressed).
 */
import * as React from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
    value: T;
    label: React.ReactNode;
    icon?: React.ReactNode;
}

interface SegmentedProps<T extends string> {
    options: SegmentedOption<T>[];
    value: T;
    onChange: (value: T) => void;
    kind?: "tabs" | "toggle";
    /** 平均撐滿整列(預設依內容寬度)。/ Stretch segments evenly across the row (default: hug content). */
    fullWidth?: boolean;
    "aria-label"?: string;
    className?: string;
}

export function Segmented<T extends string>({
    options,
    value,
    onChange,
    kind = "toggle",
    fullWidth = false,
    className,
    ...rest
}: SegmentedProps<T>) {
    return (
        <div
            role={kind === "tabs" ? "tablist" : "group"}
            aria-label={rest["aria-label"]}
            className={cn(
                "gap-1 rounded-xl bg-muted p-1",
                fullWidth ? "grid auto-cols-fr grid-flow-col" : "inline-flex min-w-max",
                className,
            )}
        >
            {options.map((option) => {
                const active = option.value === value;
                return (
                    <button
                        key={option.value}
                        type="button"
                        onClick={() => onChange(option.value)}
                        {...(kind === "tabs" ? { role: "tab", "aria-selected": active } : { "aria-pressed": active })}
                        className={cn(
                            "flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition-[color,background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:shrink-0",
                            active ? "bg-card text-foreground shadow-card [&_svg]:text-primary" : "text-muted-foreground hover:text-foreground",
                        )}
                    >
                        {option.icon}
                        <span className="truncate">{option.label}</span>
                    </button>
                );
            })}
        </div>
    );
}
