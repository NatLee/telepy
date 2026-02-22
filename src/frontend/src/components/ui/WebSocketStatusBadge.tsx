"use client";

import React from "react";
import { useNotificationWsStatus } from "@/components/layout/AppLayout";
import { Wifi, WifiOff } from "lucide-react";

/**
 * Small badge indicating the notification WebSocket connection status.
 * Displays "Live" with a green dot when connected, or "Disconnected"
 * with a red dot otherwise. Consistent with shadcn muted text styling.
 */
export function WebSocketStatusBadge() {
    const { isConnected } = useNotificationWsStatus();

    return (
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground select-none">
            <span
                className={`w-2 h-2 rounded-full shrink-0 ${isConnected
                        ? "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]"
                        : "bg-destructive"
                    }`}
                aria-hidden="true"
            />
            {isConnected ? (
                <>
                    <Wifi size={12} className="text-emerald-500" />
                    <span>Live</span>
                </>
            ) : (
                <>
                    <WifiOff size={12} className="text-destructive" />
                    <span>Disconnected</span>
                </>
            )}
        </div>
    );
}
