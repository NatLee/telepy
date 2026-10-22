"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

type ConnectionState = "disconnected" | "connecting" | "connected";

/** 平的實色圓點 + 同色淡環；連線中才呼吸。/ A flat solid dot with a tinted halo; only "connecting" pulses. */
const STATE_CLASS: Record<ConnectionState, string> = {
    disconnected: "bg-destructive ring-destructive/20",
    connecting: "bg-warning ring-warning/25 animate-pulse",
    connected: "bg-success ring-success/20",
};

const STATE_LABEL_KEYS: Record<ConnectionState, "ui.stateConnected" | "ui.stateConnecting" | "ui.stateDisconnected"> = {
    connected: "ui.stateConnected",
    connecting: "ui.stateConnecting",
    disconnected: "ui.stateDisconnected",
};

interface ConnectionStatusLightProps {
    state: ConnectionState;
    /** Size of the light in pixels. Defaults to 48. */
    size?: number;
}

/**
 * A circular "traffic light" indicator for connection status.
 * Three states: disconnected (red), connecting (amber), connected (green).
 */
export function ConnectionStatusLight({ state, size = 48 }: ConnectionStatusLightProps) {
    const { t } = useI18n();
    return (
        <div
            className={cn("rounded-full ring-8", STATE_CLASS[state])}
            style={{ width: size, height: size }}
            role="status"
            aria-label={t("ui.connectionStatus", { state: t(STATE_LABEL_KEYS[state]) })}
        />
    );
}
