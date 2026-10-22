/**
 * 分段膠囊切換:灰色軌道 + 浮起的白色選取塊。用於分頁(kind="tabs")或單選(kind="toggle")。
 * Segmented control: a muted track with a raised selected segment. Works as tabs (kind="tabs",
 * role=tab + aria-selected) or as a single-choice toggle (kind="toggle", aria-pressed).
 *
 * fullWidth 時標籤可以換行而不是被截成「…」:偏好設定的「已連接的應用程式」在窄一點的對話框裡就被截掉過。
 * 依內容寬度(預設)時維持單行,外層需要的話用 overflow-x-auto 讓它橫向捲動(Modal 的 toolbar 已處理)。
 * With fullWidth, labels wrap instead of truncating to "…" (the preferences tab "Connected apps" used to
 * get cut off in a narrower dialog). Hug-content mode stays on one line; wrap it in overflow-x-auto to
 * scroll sideways when needed (Modal's toolbar slot already does).
 */
import * as React from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
    value: T;
    label: React.ReactNode;
    icon?: React.ReactNode;
    /** hover 文字(label 不是字串時用)。/ Hover text (when the label is not a plain string). */
    title?: string;
}

interface SegmentedProps<T extends string> {
    options: SegmentedOption<T>[];
    value: T;
    onChange: (value: T) => void;
    kind?: "tabs" | "toggle";
    /** 平均撐滿整列(預設依內容寬度)。/ Stretch segments evenly across the row (default: hug content). */
    fullWidth?: boolean;
    /** 小尺寸(表單內的小切換)。/ Compact size for in-form toggles. */
    size?: "sm" | "md";
    "aria-label"?: string;
    className?: string;
}

export function Segmented<T extends string>({
    options,
    value,
    onChange,
    kind = "toggle",
    fullWidth = false,
    size = "md",
    className,
    ...rest
}: SegmentedProps<T>) {
    return (
        <div
            role={kind === "tabs" ? "tablist" : "group"}
            aria-label={rest["aria-label"]}
            className={cn(
                "gap-0.5 rounded-md border border-border bg-surface p-0.5",
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
                        title={option.title ?? (typeof option.label === "string" ? option.label : undefined)}
                        {...(kind === "tabs" ? { role: "tab", "aria-selected": active } : { "aria-pressed": active })}
                        className={cn(
                            "flex min-w-0 items-center justify-center gap-1.5 rounded-sm transition-[color,background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:shrink-0",
                            size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm",
                            fullWidth ? "text-center leading-snug" : "whitespace-nowrap",
                            active ? "bg-card text-foreground ring-1 ring-border dark:bg-secondary [&_svg]:text-primary" : "text-muted-foreground hover:text-foreground",
                        )}
                    >
                        {option.icon}
                        <span className={cn("min-w-0", !fullWidth && "truncate")}>{option.label}</span>
                    </button>
                );
            })}
        </div>
    );
}
