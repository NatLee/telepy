"use client";

/**
 * 終端機頁的雙段延遲徽章（流程路徑風格）。/ Terminal dual-hop latency badge (flow-path style).
 *
 * 以「You ● ── Telepy ● ── Device」的路徑呈現兩段延遲，每段線上標該 hop 的往返 RTT、依品質變色：
 *   You → Telepy   ：瀏覽器 ↔ Telepy 的 WebSocket RTT（useTerminalPage 的 ping/pong）
 *   Telepy → Device：SSH 伺服器 ↔ 遠端裝置的 kernel RTT（update_ports 經 tunnel_connection 推送）
 *
 * 注意：兩個數字都是「往返 RTT」，非單向——WS ping/pong 與 kernel srtt 皆量測不到單向延遲。
 * 端到端往返 ≈ 兩段相加（Σ）。
 *
 * 桌機：直接畫出流程路徑。手機（compact）：收合成訊號格 + Σ，明細走 tooltip。
 */
import React from "react";
import { cn } from "@/lib/utils";
import { LatencyIndicator, latencyTier } from "@/components/ui/LatencyIndicator";

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
            <span className="h-3.5 flex items-end leading-none">{top}</span>
            <span className="h-2 flex items-center leading-none">{mid}</span>
            <span className="h-3.5 flex items-start leading-none">{bottom}</span>
        </span>
    );
}

function FlowNode({ label, connected }: { label: string; connected: boolean }) {
    return (
        <Col
            mid={<span className={cn("h-2 w-2 rounded-full", connected ? "bg-foreground/70" : "bg-muted-foreground/40")} />}
            bottom={<span className="text-[10px] text-muted-foreground">{label}</span>}
        />
    );
}

function Hop({ ms, wide }: { ms: number | null; wide?: boolean }) {
    const tier = isNum(ms) ? latencyTier(ms) : null;
    return (
        <Col
            top={
                <span className={cn("text-[10px] font-medium tabular-nums px-1", tier ? tier.textClass : "text-muted-foreground")}>
                    {fmtMs(ms)}
                </span>
            }
            mid={<span className={cn("h-[2px] rounded-full", wide ? "w-12" : "w-7", tier ? tier.barClass : "bg-muted-foreground/30")} />}
        />
    );
}

/** 水平流程路徑：You ● ──ms── ● Telepy ● ──ms── ● Device。 */
function FlowPath({
    youToServerMs,
    serverToDeviceMs,
    connected,
    wide,
}: {
    youToServerMs: number | null;
    serverToDeviceMs: number | null;
    connected: boolean;
    wide?: boolean;
}) {
    return (
        <span className="inline-flex items-center">
            <FlowNode label="You" connected={connected} />
            <Hop ms={youToServerMs} wide={wide} />
            <FlowNode label="Telepy" connected={connected} />
            <Hop ms={serverToDeviceMs} wide={wide} />
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

    // 手機：訊號格（總延遲品質）+ Σ 數字，路徑明細走 tooltip。
    if (compact) {
        return (
            <LatencyIndicator
                rttMs={total}
                online={connected}
                size="xs"
                withTooltip
                tooltipContent={breakdown}
                className={className}
            />
        );
    }

    // 桌機：直接畫流程路徑 + 尾端 Σ 總和。
    return (
        <div className={cn("inline-flex items-center gap-1.5", className)}>
            <FlowPath
                youToServerMs={youToServerMs}
                serverToDeviceMs={serverToDeviceMs}
                connected={connected}
            />
            {total != null && (
                <span className="text-[10px] text-muted-foreground/70 tabular-nums whitespace-nowrap">
                    Σ {Math.round(total)}ms
                </span>
            )}
        </div>
    );
}
