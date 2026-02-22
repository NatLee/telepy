"use client";

import React from "react";

type ConnectionState = "disconnected" | "connecting" | "connected";

interface ConnectionStatusLightProps {
    state: ConnectionState;
    /** Size of the light in pixels. Defaults to 48. */
    size?: number;
}

const STATE_STYLES: Record<ConnectionState, { bg: string; shadow: string; ring: string; animClass: string }> = {
    disconnected: {
        bg: "bg-gradient-to-br from-red-400 to-red-600",
        shadow: "shadow-[0_0_12px_2px_rgba(239,68,68,0.45)]",
        ring: "ring-red-300/50",
        animClass: "animate-pulse-glow",
    },
    connecting: {
        bg: "bg-gradient-to-br from-amber-300 to-amber-500",
        shadow: "shadow-[0_0_16px_3px_rgba(245,158,11,0.5)]",
        ring: "ring-amber-300/50",
        animClass: "animate-pulse-glow",
    },
    connected: {
        bg: "bg-gradient-to-br from-emerald-300 to-emerald-500",
        shadow: "shadow-[0_0_20px_4px_rgba(16,185,129,0.55)]",
        ring: "ring-emerald-300/60",
        animClass: "animate-pulse-glow",
    },
};

/**
 * A circular "traffic light" indicator for connection status.
 * Three states: disconnected (red), connecting (amber), connected (green).
 */
export function ConnectionStatusLight({ state, size = 48 }: ConnectionStatusLightProps) {
    const s = STATE_STYLES[state];
    return (
        <div
            className={`rounded-full ring-4 ${s.bg} ${s.shadow} ${s.ring} ${s.animClass}`}
            style={{ width: size, height: size }}
            role="status"
            aria-label={`Connection status: ${state}`}
        />
    );
}
