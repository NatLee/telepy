"use client";

/**
 * 連線延遲指示器（訊號格風格）。/ Connection latency indicator (signal-bars style).
 *
 * 4 格訊號條依延遲品質填滿並變色（綠→黃→橙→紅），旁邊顯示精確 ms。離線 / 量不到時顯示灰格 + 「—」。
 * 全站共用：主頁面卡片 / 表格列、terminal 標題列與手機分頁列。
 *
 * 分級門檻（單程 RTT，毫秒）：
 *   <60 極佳(4 綠) · 60–150 良好(3 黃) · 150–300 普通(2 橙) · >300 不佳(1 紅)
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";

export interface LatencyIndicatorProps {
    /** Round-trip time in ms. null/undefined = unknown/offline. */
    rttMs: number | null | undefined;
    /** When false, force the offline (greyed) state regardless of rttMs. */
    online?: boolean;
    size?: "xs" | "sm";
    /** Show the numeric "24ms" text next to the bars (default true). */
    showValue?: boolean;
    /** Wrap in a tooltip describing the quality (default true). */
    withTooltip?: boolean;
    /** Override the tooltip body (e.g. a per-segment breakdown). */
    tooltipContent?: React.ReactNode;
    /** Small muted prefix rendered before the value (e.g. "你→伺服器"). */
    label?: string;
    /**
     * 為數值保留固定欄寬（tabular-nums + min-width），位數變動時不推擠周圍版面。
     * Reserve a fixed-width slot for the value so digit-count changes never shift the layout.
     */
    reserveWidth?: boolean;
    className?: string;
}

export type LatencyTier = {
    bars: number; // number of filled bars 1..4
    barClass: string; // filled bar colour
    textClass: string; // value text colour
    /** i18n key for the quality label; translate at display time (this is a plain function, not a component). */
    labelKey: "latency.excellent" | "latency.good" | "latency.fair" | "latency.poor";
};

/** 依單程 RTT（毫秒）決定品質分級與配色。全站共用（訊號格、terminal 流程路徑）。 */
export function latencyTier(rttMs: number): LatencyTier {
    if (rttMs < 60) return { bars: 4, barClass: "bg-emerald-500", textClass: "text-emerald-600 dark:text-emerald-400", labelKey: "latency.excellent" };
    if (rttMs < 150) return { bars: 3, barClass: "bg-amber-500", textClass: "text-amber-600 dark:text-amber-400", labelKey: "latency.good" };
    if (rttMs < 300) return { bars: 2, barClass: "bg-orange-500", textClass: "text-orange-600 dark:text-orange-400", labelKey: "latency.fair" };
    return { bars: 1, barClass: "bg-red-500", textClass: "text-red-600 dark:text-red-400", labelKey: "latency.poor" };
}

const SIZES = {
    xs: { width: "w-[2px]", heights: [4, 6, 8, 10], gap: "gap-[1.5px]", text: "text-[10px]" },
    sm: { width: "w-[3px]", heights: [5, 7, 9, 11], gap: "gap-[2px]", text: "text-xs" },
} as const;

export function LatencyIndicator({
    rttMs,
    online = true,
    size = "sm",
    showValue = true,
    withTooltip = true,
    tooltipContent,
    label,
    reserveWidth = false,
    className,
}: LatencyIndicatorProps) {
    const { t } = useI18n();
    const known = online && rttMs != null && Number.isFinite(rttMs);
    const tier = known ? latencyTier(rttMs as number) : null;
    const dims = SIZES[size];

    const bars = (
        <span className={cn("inline-flex items-end", dims.gap)} aria-hidden>
            {dims.heights.map((h, i) => {
                const filled = tier ? i < tier.bars : false;
                return (
                    <span
                        key={i}
                        className={cn(
                            "rounded-[1px] transition-colors",
                            dims.width,
                            filled ? tier!.barClass : "bg-muted-foreground/25"
                        )}
                        style={{ height: h }}
                    />
                );
            })}
        </span>
    );

    const content = (
        <span
            className={cn(
                "inline-flex items-center gap-1 tabular-nums select-none",
                dims.text,
                className
            )}
        >
            {bars}
            {showValue && (
                <span className="inline-flex items-center gap-0.5">
                    {label && <span className="text-muted-foreground/70">{label}</span>}
                    <span
                        className={cn(
                            "font-medium transition-colors",
                            tier ? tier.textClass : "text-muted-foreground",
                            reserveWidth && "inline-block min-w-[4.75ch] text-left"
                        )}
                    >
                        {known ? `${Math.round(rttMs as number)}ms` : "—"}
                    </span>
                </span>
            )}
        </span>
    );

    if (!withTooltip) return content;

    return (
        <TooltipProvider delayDuration={150}>
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="inline-flex cursor-default">{content}</span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>
                    {tooltipContent ?? (
                        <span>
                            {known
                                ? t("latency.tooltip", { ms: Math.round(rttMs as number), tier: t(tier!.labelKey) })
                                : online
                                    ? t("latency.measuring")
                                    : t("latency.offline")}
                        </span>
                    )}
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}
