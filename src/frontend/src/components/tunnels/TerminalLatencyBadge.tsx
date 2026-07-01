"use client";

/**
 * 終端機頁的雙段延遲徽章。/ Terminal dual-segment latency badge.
 *
 * 顯示兩段延遲：
 *   你 → 伺服器：瀏覽器 ↔ Telepy 的 WebSocket RTT（useTerminalPage 的 ping/pong）
 *   伺服器 → 裝置：SSH 伺服器 ↔ 遠端裝置的 kernel RTT（update_ports 經 tunnel_connection 推送）
 *
 * 訊號格以「總延遲」（兩段相加）決定品質；tooltip 展開逐段明細。
 * compact=true 供手機用（只顯示總和 + 訊號格，明細走 tooltip）。
 */
import React from "react";
import { LatencyIndicator } from "@/components/ui/LatencyIndicator";

interface TerminalLatencyBadgeProps {
    youToServerMs: number | null;
    serverToDeviceMs: number | null;
    connected: boolean;
    connecting: boolean;
    compact?: boolean;
    className?: string;
}

const fmt = (v: number | null) => (v != null && Number.isFinite(v) ? `${Math.round(v)}` : "—");

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

    const parts: number[] = [];
    if (youToServerMs != null && Number.isFinite(youToServerMs)) parts.push(youToServerMs);
    if (serverToDeviceMs != null && Number.isFinite(serverToDeviceMs)) parts.push(serverToDeviceMs);
    const total = parts.length ? parts.reduce((a, b) => a + b, 0) : null;

    const tooltip = (
        <div className="space-y-0.5 text-left">
            <div className="flex items-center justify-between gap-3">
                <span className="opacity-80">You → Server</span>
                <span className="font-medium tabular-nums">{fmt(youToServerMs)}ms</span>
            </div>
            <div className="flex items-center justify-between gap-3">
                <span className="opacity-80">Server → Device</span>
                <span className="font-medium tabular-nums">{fmt(serverToDeviceMs)}ms</span>
            </div>
            <div className="flex items-center justify-between gap-3 pt-0.5 border-t border-background/20">
                <span className="opacity-60">Total</span>
                <span className="font-semibold tabular-nums">{fmt(total)}ms</span>
            </div>
        </div>
    );

    // 手機：只給訊號格 + 總和 ms，明細走 tooltip。
    if (compact) {
        return (
            <LatencyIndicator
                rttMs={total}
                online={connected}
                size="xs"
                withTooltip
                tooltipContent={tooltip}
                className={className}
            />
        );
    }

    // 桌機：訊號格（總延遲品質）+ 逐段明細文字。
    return (
        <div className={`flex items-center gap-1.5 ${className ?? ""}`}>
            <LatencyIndicator
                rttMs={total}
                online={connected}
                size="sm"
                showValue={false}
                withTooltip
                tooltipContent={tooltip}
            />
            <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                <span className="opacity-70">You</span> {fmt(youToServerMs)}
                <span className="opacity-40 mx-1">·</span>
                <span className="opacity-70">Dev</span> {fmt(serverToDeviceMs)}
                <span className="ml-0.5">ms</span>
            </span>
        </div>
    );
}
