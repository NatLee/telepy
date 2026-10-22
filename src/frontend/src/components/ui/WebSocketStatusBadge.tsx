"use client";

import React from "react";
import { useNotificationWsStatus } from "@/components/layout/AppLayout";
import { Wifi, WifiOff } from "lucide-react";
import { useI18n } from "@/lib/i18n";

/**
 * Small badge indicating the notification WebSocket connection status.
 * Displays "Live" with a green dot when connected, or "Disconnected"
 * with a red dot otherwise. Consistent with shadcn muted text styling.
 */
export function WebSocketStatusBadge() {
    const { isConnected } = useNotificationWsStatus();
    const { t } = useI18n();

    return (
        <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground select-none">
            <span
                className={`size-2 rounded-full shrink-0 ${isConnected ? "bg-success" : "bg-destructive"}`}
                aria-hidden="true"
            />
            {isConnected ? (
                <>
                    <Wifi size={12} className="text-success" />
                    <span>{t("ui.live")}</span>
                </>
            ) : (
                <>
                    <WifiOff size={12} className="text-destructive" />
                    <span>{t("common.disconnected")}</span>
                </>
            )}
        </div>
    );
}
