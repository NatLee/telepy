"use client";

/**
 * 重連提示列「為什麼？」打開的時間軸圖：重連中 = 保留中（倒數），接回之後 = 已接回，放棄了 = 已結束。
 * The dialog behind the reconnect banner's "Why?": detached while reconnecting (with the countdown), resumed once
 * back, ended when it gave up. Kept by the page so it survives the banner going away.
 */
import React, { useEffect, useState } from "react";
import { remainingSecs, type DetachLayer, type DetachPhase } from "@/lib/terminalDetach";
import { DetachInfoDialog } from "./DetachTimeline";
import type { ReconnectState } from "./ReconnectBanner";

export function ReconnectWhy({ isOpen, onClose, reconnecting, ended, layers }: { isOpen: boolean; onClose: () => void; reconnecting: ReconnectState | null; ended: boolean; layers: DetachLayer[] }) {
    // 最後一次重連的狀態（接回後提示列沒了，圖還要畫保留時間）。/ The last reconnect state, still drawn after it is over.
    const [last, setLast] = useState<ReconnectState | null>(reconnecting);
    if (reconnecting && reconnecting !== last) setLast(reconnecting);
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!isOpen || !reconnecting) return;
        // 打開時先對一次時間，之後每秒。/ Sync the clock on open, then every second.
        const first = setTimeout(() => setNow(Date.now()), 0);
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => {
            clearTimeout(first);
            clearInterval(id);
        };
    }, [isOpen, reconnecting]);
    const shown = reconnecting ?? last;
    if (!shown) return null;
    const phase: DetachPhase = reconnecting ? "detached" : ended ? "ended" : "resumed";
    return <DetachInfoDialog isOpen={isOpen} onClose={onClose} phase={phase} grace={shown.grace} layers={layers} left={remainingSecs(shown.droppedAt, shown.grace.secs, now)} />;
}
