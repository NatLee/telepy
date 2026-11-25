"use client";

/**
 * 手機上頁面被放大、遠端畫面又開著時的半透明蓋板：蓋滿看得到的範圍（點擊不會誤觸後面的按鈕，兩指照樣能縮放頁面），
 * 中間一張卡寫出放大倍數、一張小地圖標出現在看到的是畫面的哪一塊、兩指往內捏的動畫，以及「試著還原縮放」（做不到就改成
 * 請使用者自己捏）。X 只是收成角落的小標籤「放大中 300%」，點了又展開；縮放本身不受影響，想放大看東西的人照樣能看。
 * The semi-transparent overlay on a phone while the page is zoomed and the remote screen is up: it covers the visible
 * area (taps don't reach the buttons behind it, two fingers still zoom the page), and a card in the middle shows the
 * zoom level, a minimap of which part of the screen is visible, a pinch-in animation and "Try to reset" (replaced by
 * "pinch in yourself" when the browser won't allow it). X only folds it into a small "Zoomed 300%" tag in the corner
 * that opens it again; the zoom itself is left alone, so someone who wants to look closer still can.
 */
import React, { useState } from "react";
import { X, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { minimapRect, resetPageZoom, zoomBarStyle, zoomCoverStyle, zoomPercent, type VisualViewportBox } from "@/lib/pageZoom";
import { useI18n } from "@/lib/i18n";

/** 兩根手指往內捏的示意（一個循環動畫，減少動態時停在結尾）。/ Two fingers pinching in (one looping animation; still under reduced motion). */
function PinchHint() {
    const finger = "absolute top-1/2 size-4 -translate-y-1/2 rounded-full border-2 border-primary bg-primary/20 animate-pinch-in";
    return (
        <span className="relative mx-auto block h-8 w-24" aria-hidden>
            <span className="absolute inset-x-3 top-1/2 h-px -translate-y-1/2 border-t border-dashed border-border" />
            <span className={`${finger} left-1/2 -ml-5`} style={{ "--pinch-from": "-1.75rem" } as React.CSSProperties} />
            <span className={`${finger} left-1/2 ml-1`} style={{ "--pinch-from": "1.75rem" } as React.CSSProperties} />
        </span>
    );
}

export function ZoomOverlay({ zoom }: { zoom: VisualViewportBox }) {
    const { t } = useI18n();
    const [folded, setFolded] = useState(false);
    const [resetting, setResetting] = useState(false);
    const [failed, setFailed] = useState(false);
    const percent = zoomPercent(zoom.scale);

    if (folded) {
        // 收起來：看得到的範圍左上角一個原本大小的小標籤，點了展開。/ Folded: a normal-sized tag at the visible area's top-left that opens it again.
        return (
            <div style={{ ...zoomBarStyle(zoom), width: undefined }} className="pointer-events-none fixed z-[100] p-2">
                <button
                    type="button"
                    onClick={() => setFolded(false)}
                    title={t("browser.zoom.pillTitle")}
                    className="pointer-events-auto inline-flex items-center gap-1.5 rounded-md border border-warning/50 bg-card px-2.5 py-1.5 text-xs text-foreground shadow-dialog"
                >
                    <ZoomIn size={14} className="text-warning" aria-hidden />
                    {t("browser.zoom.pill", { percent })}
                </button>
            </div>
        );
    }

    const map = minimapRect(zoom, document.documentElement.clientWidth, document.documentElement.clientHeight);
    const ratio = document.documentElement.clientWidth / Math.max(1, document.documentElement.clientHeight);
    return (
        <div style={zoomCoverStyle(zoom)} className="fixed z-[100] flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="false" aria-label={t("browser.zoom.title", { percent })}>
            <button
                type="button"
                onClick={() => setFolded(true)}
                aria-label={t("browser.zoom.hide")}
                title={t("browser.zoom.hide")}
                className="absolute right-3 top-3 grid size-9 place-items-center rounded-md border border-border bg-card text-foreground shadow-dialog"
            >
                <X size={18} />
            </button>
            <div className="w-full max-w-xs space-y-3 rounded-xl border border-border bg-card p-4 text-center shadow-dialog">
                <p className="flex items-center justify-center gap-1.5 text-sm font-medium text-foreground">
                    <ZoomIn size={16} className="text-warning" aria-hidden />
                    {t("browser.zoom.title", { percent })}
                </p>
                {/* 小地圖：外框 = 整個畫面，橘框 = 現在看得到的部分。/ Minimap: the outline is the whole screen, the orange box what is visible. */}
                <div className="mx-auto h-28 max-w-full rounded-sm border border-border bg-muted/60" style={{ aspectRatio: String(ratio) }}>
                    <div className="relative h-full w-full">
                        <span
                            className="absolute rounded-[2px] border-2 border-primary bg-primary/15"
                            style={{ left: `${map.left}%`, top: `${map.top}%`, width: `${map.width}%`, height: `${map.height}%`, minWidth: 4, minHeight: 4 }}
                        />
                    </div>
                </div>
                <p className="text-xs text-muted-foreground">{t("browser.zoom.where")}</p>
                <PinchHint />
                <p className="text-sm text-foreground">{t("browser.zoom.howTo")}</p>
                {failed ? (
                    <p className="text-xs text-warning">{t("browser.zoom.pinchOut")}</p>
                ) : (
                    <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        disabled={resetting}
                        onClick={async () => {
                            setResetting(true);
                            const back = await resetPageZoom();
                            setResetting(false);
                            if (!back) setFailed(true);
                        }}
                    >
                        <ZoomOut size={14} /> {t("browser.zoom.reset")}
                    </Button>
                )}
                <p className="text-xs text-muted-foreground">{t("browser.zoom.notice")}</p>
            </div>
        </div>
    );
}
