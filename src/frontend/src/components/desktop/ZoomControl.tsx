"use client";

/**
 * 觸控裝置上畫面右上角的縮放鈕：− / 目前百分比（點一下回到塞進框裡）/ +，剛連上時附一行雙指手勢的提示。
 * 滑鼠用的在工具列的「顯示」選單（DisplayMenu）。
 * The zoom pill shown on touch devices: − / current percentage (tap = fit) / +, with a two-finger hint at first.
 * Mouse users get the same commands in the toolbar's Display menu.
 */
import React, { useEffect, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { DesktopZoom } from "@/hooks/useDesktopZoom";

/** 提示顯示多久。/ How long the gesture hint stays. */
const HINT_MS = 6000;

export function ZoomControl({ zoom }: { zoom: DesktopZoom }) {
    const { t } = useI18n();
    const [hint, setHint] = useState(true);
    useEffect(() => {
        const id = setTimeout(() => setHint(false), HINT_MS);
        return () => clearTimeout(id);
    }, []);
    const btn = "grid size-9 place-items-center text-foreground disabled:text-muted-foreground/50";
    return (
        // 不讓點擊冒到畫面（那會把焦點交給輸入框、跳出鍵盤）。/ Keep taps from reaching the viewer (it would focus the input sink).
        <div className="absolute right-2 top-2 z-[5] flex flex-col items-end gap-1.5" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center rounded-md border border-border bg-background/90 shadow-pop" role="group" aria-label={t("desktop.zoom.label")}>
                <button type="button" className={btn} onClick={zoom.zoomOut} disabled={!zoom.info.canZoomOut} aria-label={t("desktop.zoom.out")} title={t("desktop.zoom.out")}>
                    <Minus size={16} aria-hidden />
                </button>
                <button type="button" className="h-9 min-w-13 px-1 font-mono text-xs tabular-nums text-foreground" onClick={() => zoom.setMode("fit")} aria-label={t("desktop.zoom.fit")} title={t("desktop.zoom.fit")}>
                    {zoom.info.percent}%
                </button>
                <button type="button" className={btn} onClick={zoom.zoomIn} disabled={!zoom.info.canZoomIn} aria-label={t("desktop.zoom.in")} title={t("desktop.zoom.in")}>
                    <Plus size={16} aria-hidden />
                </button>
            </div>
            {hint && <p className="pointer-events-none max-w-56 rounded-md border border-border bg-background/90 px-2.5 py-1 text-right text-xs text-foreground shadow-pop">{t("desktop.zoom.hint")}</p>}
        </div>
    );
}
