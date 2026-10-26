/**
 * 開關(role="switch"):軌道 + 白色圓鈕。給 children 時整列(開關 + 文字)都是同一顆按鈕。
 * 尺寸全部用 rem、圓鈕用 items-center 垂直置中:以前軌道是 rem 而邊框是固定 2px,
 * 顯示大小不是 100% 時圓鈕就偏上(130% 時上 2px、下 3.2px)。
 * Toggle switch (role="switch"): a track with a white knob. With children, the whole row (switch +
 * text) is one button. Every size is in rem and the knob is centred with items-center: the old track
 * was rem-sized with a fixed 2px border, so at any display size other than 100% the knob sat high.
 */
import * as React from "react";
import { cn } from "@/lib/utils";

const SIZES = {
    // 軌道 = 圓鈕 + 兩側 p-0.5;位移 = 軌道寬 − 圓鈕 − 內距。/ Track = knob + p-0.5 each side; travel = width − knob − padding.
    md: { track: "h-6 w-11", knob: "size-5", on: "translate-x-5" },
    sm: { track: "h-5 w-9", knob: "size-4", on: "translate-x-4" },
} as const;

interface SwitchProps {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
    size?: keyof typeof SIZES;
    /** 開關旁的文字;沒有時請給 aria-label。/ Text beside the switch; pass aria-label without it. */
    children?: React.ReactNode;
    "aria-label"?: string;
    className?: string;
}

export function Switch({ checked, onCheckedChange, disabled, size = "md", children, className, ...aria }: SwitchProps) {
    const s = SIZES[size];
    const track = (
        <span
            aria-hidden
            className={cn(
                "inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 ease-in-out",
                s.track,
                checked ? "bg-primary" : "bg-foreground/15",
            )}
        >
            <span
                className={cn(
                    "pointer-events-none rounded-full bg-white shadow-[0_1px_3px_oklch(0_0_0/0.2)] transition-transform duration-200 ease-in-out",
                    s.knob,
                    checked ? s.on : "translate-x-0",
                )}
            />
        </span>
    );
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={aria["aria-label"]}
            disabled={disabled}
            onClick={() => onCheckedChange(!checked)}
            className={cn(
                "shrink-0 focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
                disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                children
                    ? "flex items-center gap-2.5 rounded-lg px-1 py-1 text-left text-sm text-foreground enabled:hover:bg-muted/50"
                    : "inline-flex rounded-full",
                className,
            )}
        >
            {track}
            {children}
        </button>
    );
}
