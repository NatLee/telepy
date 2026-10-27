"use client";

/**
 * 終端機斷線、shell 還留著時的提示列：「重新連線中…（shell 還會留 N）」＋「為什麼？」（打開時間軸圖）＋「立刻重試」。
 * The banner while a dropped terminal reconnects to its kept shell, with "Why?" (the timeline) and "Retry now".
 * 「為什麼？」的對話框由使用的那一頁擺（接回之後提示列會消失，對話框要留著並改成「已接回」）。
 * The page owns the "Why?" dialog: the banner disappears once reconnected, and the dialog stays, showing "resumed".
 */
import React, { useEffect, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { remainingSecs, type DetachGrace } from "@/lib/terminalDetach";
import { leftLabel } from "./DetachTimeline";

export interface ReconnectState {
    droppedAt: number;
    grace: DetachGrace;
}

export function ReconnectBanner({ state, onWhy, onRetry }: { state: ReconnectState; onWhy: () => void; onRetry: () => void }) {
    const { t } = useI18n();
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, []);
    const left = remainingSecs(state.droppedAt, state.grace.secs, now);
    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-warning/40 bg-card px-3 py-2 text-sm text-foreground shadow-pop" role="status">
            <Loader2 size={15} className="shrink-0 animate-spin text-warning" aria-hidden />
            <span className="min-w-0 flex-1">{t("detach.reconnecting", { left: leftLabel(t, left) })}</span>
            <button type="button" className="text-xs text-foreground/80 underline decoration-foreground/30 underline-offset-4 hover:text-foreground" onClick={onWhy}>
                {t("detach.why")}
            </button>
            <Button size="sm" variant="outline" onClick={onRetry}>
                <RotateCcw /> {t("detach.retryNow")}
            </Button>
        </div>
    );
}
