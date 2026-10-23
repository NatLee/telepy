"use client";

import React, { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { useNotificationWsStatus } from "@/components/layout/AppLayout";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type View = "live" | "connecting" | "retrying" | "offline";

const DOT_CLASS: Record<View, string> = {
    live: "bg-success",
    connecting: "bg-warning animate-pulse",
    retrying: "bg-warning",
    offline: "bg-destructive",
};

/** 距離 retryAt 還有幾秒（每半秒更新）；沒有排定重連時為 null。/ Seconds until retryAt (ticks every 500 ms); null when nothing is scheduled. */
function useSecondsUntil(retryAt: number | null): number | null {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (retryAt === null) return;
        const tick = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(tick);
    }, [retryAt]);
    return retryAt === null ? null : Math.max(0, Math.ceil((retryAt - now) / 1000));
}

/**
 * 即時更新（全站共用的通知 WebSocket）的狀態：一顆燈 + 一行字。
 *  - 即時：綠燈；每收到一則更新就向外擴散一次，看得出資料真的在流動。
 *  - 連線中：琥珀燈呼吸。
 *  - 等待重連：琥珀燈 + 倒數；整顆可點，立即重試。
 *  - 已中斷（不會再自動重連）：紅燈；可點，重新連線。
 * Status of live updates (the app-wide notification WebSocket): one dot plus a label.
 *  - Live: green; it ripples once whenever an update arrives, so you can see data flowing.
 *  - Connecting: amber, breathing.
 *  - Waiting to reconnect: amber plus a countdown; the badge is a button that retries now.
 *  - Offline (no more automatic retries): red; the badge is a button that reconnects.
 */
export function WebSocketStatusBadge() {
    const { phase, messageCount, reconnect } = useNotificationWsStatus();
    const { t } = useI18n();
    const seconds = useSecondsUntil(phase.state === "retrying" ? phase.retryAt : null);

    const view: View =
        phase.state === "open" ? "live"
            : phase.state === "stopped" ? "offline"
                : phase.state === "retrying" ? "retrying"
                    : "connecting";

    const label =
        view === "live" ? t("ui.live")
            : view === "offline" ? t("ui.wsOffline")
                : view === "retrying" ? (seconds ? t("ui.wsRetryIn", { seconds }) : t("ui.wsReconnecting"))
                    : t("common.connecting");
    const hint =
        view === "live" ? t("ui.wsLiveHint")
            : view === "offline" ? t("ui.wsOfflineHint")
                : view === "retrying" ? t("ui.wsRetryHint")
                    : t("ui.wsConnectingHint");

    const dot = (
        <span className="relative grid size-2 shrink-0 place-items-center" aria-hidden>
            {/* key 每則訊息都換 → 重播一次擴散。/ A new key per message replays the ripple once. */}
            {view === "live" && messageCount > 0 && (
                <span
                    key={messageCount}
                    className="absolute inset-0 rounded-full bg-success animate-status-ping [animation-fill-mode:forwards] [animation-iteration-count:1]"
                />
            )}
            <span className={cn("relative size-2 rounded-full", DOT_CLASS[view])} />
        </span>
    );

    const actionable = view === "retrying" || view === "offline";

    return (
        <TooltipProvider delayDuration={200}>
            <Tooltip>
                <TooltipTrigger asChild>
                    {actionable ? (
                        <button
                            type="button"
                            onClick={reconnect}
                            aria-label={`${label} — ${t("ui.wsReconnectNow")}`}
                            className="-mx-2 -my-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-foreground select-none transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        >
                            {dot}
                            <span className="tabular-nums">{label}</span>
                            <RotateCw size={12} className="text-muted-foreground" aria-hidden />
                        </button>
                    ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground select-none">
                            {dot}
                            <span>{label}</span>
                        </span>
                    )}
                </TooltipTrigger>
                <TooltipContent side="bottom" align="end" className="max-w-72">
                    {hint}
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}
