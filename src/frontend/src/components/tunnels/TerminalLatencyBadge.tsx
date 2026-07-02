"use client";

/**
 * 終端機頁的雙段延遲徽章（流程路徑風格）。/ Terminal dual-hop latency badge (flow-path style).
 *
 * 以「You ● ── Telepy ● ── Device」的路徑呈現兩段延遲，每段線上標該 hop 的往返 RTT、依品質變色：
 *   You → Telepy   ：瀏覽器 ↔ Telepy 的 WebSocket RTT（useTerminalPage 的 ping/pong）
 *   Telepy → Device：SSH 伺服器 ↔ 遠端裝置的 kernel RTT（update_ports 經 tunnel_connection 推送）
 *
 * 版面穩定性（防跑版）/ Layout stability:
 *   所有會變動的文字（各 hop 的 ms、Σ 總和）都放在「固定寬度」的欄位裡（tabular-nums），
 *   數字從 2 位數跳到 3、4 位數時整體寬度完全不變。Σ 欄位在量不到時也保留佔位（Σ —）。
 *   Every mutable number sits in a fixed-width, tabular-nums slot, so digit-count changes
 *   (72ms → 115ms) never shift the layout; the Σ slot is reserved even while unknown.
 *
 * 視覺 / Visuals：藥丸容器 + hop 線上的資料流光點動畫（連線中才顯示；respects reduced-motion），
 * 桌機 hover 顯示與手機 tooltip 相同的分段明細。
 *
 * 注意：兩個數字都是「往返 RTT」，非單向。端到端往返 ≈ 兩段相加（Σ）。
 */
import React from "react";
import { cn } from "@/lib/utils";
import { LatencyIndicator, latencyTier } from "@/components/ui/LatencyIndicator";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";

interface TerminalLatencyBadgeProps {
    youToServerMs: number | null;
    serverToDeviceMs: number | null;
    connected: boolean;
    connecting: boolean;
    compact?: boolean;
    className?: string;
}

const isNum = (v: number | null): v is number => v != null && Number.isFinite(v);
const fmtMs = (v: number | null) => (isNum(v) ? `${Math.round(v)}ms` : "—");

/** 一欄：上（hop 的 ms）/ 中（軸線：節點圓點或 hop 線）/ 下（節點標籤）。三欄同軸對齊。 */
function Col({ top, mid, bottom }: { top?: React.ReactNode; mid: React.ReactNode; bottom?: React.ReactNode }) {
    return (
        <span className="inline-flex flex-col items-center">
            <span className="h-3 flex items-end leading-none">{top}</span>
            <span className="h-2 flex items-center leading-none">{mid}</span>
            <span className="h-3 flex items-start leading-none">{bottom}</span>
        </span>
    );
}

function FlowNode({ label, connected, accent }: { label: string; connected: boolean; accent?: boolean }) {
    return (
        <Col
            mid={
                <span
                    className={cn(
                        "h-2 w-2 rounded-full transition-colors duration-300",
                        connected ? (accent ? "bg-primary" : "bg-foreground/70") : "bg-muted-foreground/40"
                    )}
                />
            }
            bottom={<span className="text-[10px] text-muted-foreground whitespace-nowrap">{label}</span>}
        />
    );
}

/**
 * 一段 hop：固定寬度欄（w-14）。ms 置中於線上方，位數變多也不改變欄寬 → 不跑版。
 * One hop: a fixed-width (w-14) column — the ms label re-centres but never resizes the column.
 */
function Hop({ ms, connected }: { ms: number | null; connected: boolean }) {
    const tier = isNum(ms) ? latencyTier(ms) : null;
    return (
        <Col
            top={
                <span
                    className={cn(
                        "block w-14 text-center text-[10px] font-medium tabular-nums transition-colors duration-300",
                        tier ? tier.textClass : "text-muted-foreground/70"
                    )}
                >
                    {fmtMs(ms)}
                </span>
            }
            mid={
                <span
                    className={cn(
                        "relative block h-[2px] w-14 rounded-full transition-colors duration-300",
                        tier ? tier.barClass : "bg-muted-foreground/30"
                    )}
                >
                    {/* 資料流光點：連線中沿線滑動（reduced-motion 時不顯示）。/ Gliding data-flow dot. */}
                    {connected && tier && (
                        <span
                            aria-hidden
                            className="absolute top-1/2 -translate-y-1/2 h-[5px] w-[5px] rounded-full bg-foreground/70 opacity-0 animate-latency-flow"
                        />
                    )}
                </span>
            }
        />
    );
}

/** 水平流程路徑：You ● ──ms── ● Telepy ● ──ms── ● Device。 */
function FlowPath({
    youToServerMs,
    serverToDeviceMs,
    connected,
}: {
    youToServerMs: number | null;
    serverToDeviceMs: number | null;
    connected: boolean;
}) {
    return (
        <span className="inline-flex items-center">
            <FlowNode label="You" connected={connected} />
            <Hop ms={youToServerMs} connected={connected} />
            <FlowNode label="Telepy" connected={connected} accent />
            <Hop ms={serverToDeviceMs} connected={connected} />
            <FlowNode label="Device" connected={connected} />
        </span>
    );
}

export function TerminalLatencyBadge({
    youToServerMs,
    serverToDeviceMs,
    connected,
    connecting,
    compact = false,
    className,
}: TerminalLatencyBadgeProps) {
    // 未連線且非連線中：沒有延遲可顯示，直接不渲染（連線狀態另由標題列的圓點表示）。
    if (!connected && !connecting) return null;

    // 端到端往返 ≈ 兩段相加，僅在兩段都量得到時才顯示 Σ。
    const total = isNum(youToServerMs) && isNum(serverToDeviceMs) ? youToServerMs + serverToDeviceMs : null;

    const breakdown = (
        <div className="space-y-0.5 text-left">
            <div className="flex items-center justify-between gap-3">
                <span className="opacity-80">You → Telepy</span>
                <span className="font-medium tabular-nums">{fmtMs(youToServerMs)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
                <span className="opacity-80">Telepy → Device</span>
                <span className="font-medium tabular-nums">{fmtMs(serverToDeviceMs)}</span>
            </div>
            <div className="flex items-center justify-between gap-3 pt-0.5 border-t border-background/20">
                <span className="opacity-60">End-to-end</span>
                <span className="font-semibold tabular-nums">{fmtMs(total)}</span>
            </div>
            <div className="opacity-50 text-[10px] pt-0.5">round-trip per hop</div>
        </div>
    );

    // 手機：訊號格（總延遲品質）+ Σ 數字（保留固定欄寬防跑版），路徑明細走 tooltip。
    if (compact) {
        return (
            <LatencyIndicator
                rttMs={total}
                online={connected}
                size="xs"
                withTooltip
                tooltipContent={breakdown}
                reserveWidth
                className={className}
            />
        );
    }

    // 桌機：藥丸容器內畫流程路徑 + 固定寬度的 Σ 欄；hover 顯示分段明細。
    return (
        <TooltipProvider delayDuration={150}>
            <Tooltip>
                <TooltipTrigger asChild>
                    <div
                        className={cn(
                            "inline-flex items-center rounded-full border border-border/40 bg-muted/30 pl-3 pr-2.5 py-1 cursor-default select-none",
                            className
                        )}
                    >
                        <FlowPath
                            youToServerMs={youToServerMs}
                            serverToDeviceMs={serverToDeviceMs}
                            connected={connected}
                        />
                        {/* Σ 欄固定寬度並常駐（未知時顯示 Σ —），總和位數變動不影響版面。 */}
                        <span className="ml-2 pl-2 border-l border-border/50 w-[3.4rem] shrink-0 text-[10px] tabular-nums text-muted-foreground/80 whitespace-nowrap">
                            {total != null ? `Σ ${Math.round(total)}ms` : "Σ —"}
                        </span>
                    </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                    {breakdown}
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}
