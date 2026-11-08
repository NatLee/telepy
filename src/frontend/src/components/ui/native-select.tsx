/**
 * 原生 <select>,外觀對齊 Input(同高、同框線、同 focus ring)。選項很多或要在手機上用原生選單時用它,
 * 不然用 components/ui/select.tsx 的 Radix 版本。
 * Native <select> styled like Input (same height, border, focus ring). Use it for long option lists or
 * when the native picker is wanted on phones; otherwise use the Radix Select.
 *
 * `className` 放在外框上，裡面的 <select> 跟著外框的高度與字級（`h-8 text-xs` 就是小的那種）；以前 <select> 固定 h-9，
 * 外框給 h-8 時選單比旁邊的按鈕高、往下凸出。
 * `className` goes on the wrapper and the <select> follows its height and font size (`h-8 text-xs` = the small one);
 * the <select> used to stay h-9, so with an h-8 wrapper it stood taller than the buttons next to it.
 */
import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function NativeSelect({ className, children, ...props }: React.ComponentProps<"select">) {
    return (
        <span className={cn("relative block h-9 text-sm", className)}>
            <select
                data-slot="native-select"
                className={cn(
                    "h-full w-full min-w-0 appearance-none rounded-md border border-input bg-card pl-3 pr-9 [font-size:inherit] text-foreground transition-[border-color,box-shadow] outline-none",
                    "hover:border-foreground/30 focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/20",
                    "disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-destructive/20",
                )}
                {...props}
            >
                {children}
            </select>
            <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
        </span>
    );
}
