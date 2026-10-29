"use client";

/**
 * 重新整理按鈕：點下去圖示至少轉滿一圈、只在一圈轉完時停，成功後換成一個彈出來的勾勾。請求常常幾十毫秒就回來，
 * 舊的「載入中才轉」只閃一下，看起來像沒反應。`busy` = 頁面自己在背景載入（通知觸發）時也轉，但不打勾；
 * 轉的時候不 disable（disabled 會把按鈕變淡，動畫跟著看不清楚），重複點會被忽略。減少動態時不轉，直接打勾。
 * Refresh button: on click the icon turns at least once and stops only where a turn ends, then a check pops in on
 * success. A request often answers in tens of milliseconds, so the old "spin while loading" was a flicker that read
 * as nothing happening. `busy` = the page loading on its own (a notification) also turns it, without the check. It
 * is not disabled while turning (disabled fades the button and the motion with it); repeated clicks are ignored.
 * With reduced motion it doesn't turn and shows the check at once.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useI18n } from "@/lib/i18n";
import { DONE_MS, keepSpinning, RIPPLE_MAX_ITEMS, rippleDelay } from "@/lib/refreshMotion";
import { cn } from "@/lib/utils";

type Props = Omit<React.ComponentProps<typeof Button>, "onClick" | "children"> & {
    /** 做重新整理；回傳 false = 失敗（不打勾，錯誤由呼叫端自己說）。/ Does the refresh; false = failed (no check). */
    onRefresh: () => Promise<boolean | void> | boolean | void;
    /** 頁面在背景載入中（也轉，不打勾）。/ The page is loading on its own (turns too, no check). */
    busy?: boolean;
    /** 按鈕文字；不給 = 只有圖示。/ Button text; none = icon only. */
    label?: React.ReactNode;
    iconSize?: number;
};

export function RefreshButton({ onRefresh, busy = false, label, iconSize = 16, variant = "outline", className, ...rest }: Props) {
    const { t } = useI18n();
    const reduced = useReducedMotion();
    const [spinning, setSpinning] = useState(busy);
    const [done, setDone] = useState(false);
    // 事件處理器讀「現在」的值。/ Handlers read the current values.
    const working = useRef(false);
    const succeeded = useRef(false);
    const busyRef = useRef(busy);
    const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => {
        if (doneTimer.current) clearTimeout(doneTimer.current);
    }, []);

    const showDone = useCallback(() => {
        setDone(true);
        if (doneTimer.current) clearTimeout(doneTimer.current);
        doneTimer.current = setTimeout(() => setDone(false), DONE_MS);
    }, []);

    // 一圈轉完：還在忙就再轉一圈，不然停；這次是點的而且成功就打勾。
    // A turn ended: keep going while busy, else stop and, after a successful click, show the check.
    const settle = useCallback(() => {
        if (keepSpinning({ working: working.current, busy: busyRef.current })) return;
        setSpinning(false);
        if (!succeeded.current) return;
        succeeded.current = false;
        showDone();
    }, [showDone]);

    // 背景載入一開始就轉（render 時依前一個值調整，不在 effect 裡 setState）；減少動態時沒有「一圈」可等，不轉。
    // A background load starts the turning (adjusted during render from the previous value, not set in an effect);
    // with reduced motion there is no turn to wait for, so it doesn't.
    const [prevBusy, setPrevBusy] = useState(busy);
    if (busy !== prevBusy) {
        setPrevBusy(busy);
        if (busy && !reduced) setSpinning(true);
        if (!busy && reduced) setSpinning(false);
    }
    useEffect(() => {
        busyRef.current = busy;
    }, [busy]);

    const click = async () => {
        if (working.current) return;
        working.current = true;
        succeeded.current = false;
        if (doneTimer.current) clearTimeout(doneTimer.current);
        setDone(false);
        setSpinning(true);
        let ok = true;
        try {
            ok = (await onRefresh()) !== false;
        } catch {
            ok = false;
        }
        working.current = false;
        if (reduced) {
            setSpinning(false);
            if (ok) showDone();
        } else {
            succeeded.current = ok;
        }
    };

    const turning = spinning && !reduced;
    return (
        <Button {...rest} variant={variant} className={className} onClick={() => void click()} aria-busy={spinning || busy || undefined}>
            {done ? (
                <Check key="done" size={iconSize} className="animate-refresh-done text-success" aria-hidden />
            ) : (
                <RefreshCw
                    key="icon"
                    size={iconSize}
                    className={cn(turning && "animate-refresh-turn")}
                    onAnimationIteration={settle}
                    aria-hidden
                />
            )}
            {label}
            <span className="sr-only" aria-live="polite">{done ? t("common.updated") : ""}</span>
        </Button>
    );
}

/**
 * 重新整理後讓列表項目（`data-refresh-item`）由淡到實、一項接一項浮回原位，表示「這是剛拿到的」；只動畫面內的項目，
 * 不重新掛載（卡片裡打開的選單不會掉）。減少動態時呼叫端不要叫它（Web Animations 不受 globals.css 的規則影響）。
 * After a refresh, list items (`data-refresh-item`) fade up into place one after another — "this just arrived". Only
 * items on screen move, nothing remounts (a card's open menu stays). Callers skip it under reduced motion (Web
 * Animations ignore the globals.css rule).
 */
export function rippleIn(root: HTMLElement | null, selector = "[data-refresh-item]") {
    if (!root || typeof root.animate !== "function") return;
    const height = window.innerHeight;
    const onScreen = Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < height && r.height > 0;
    });
    onScreen.slice(0, RIPPLE_MAX_ITEMS).forEach((el, i) => {
        el.animate(
            [
                { opacity: 0.35, transform: "translateY(6px)" },
                { opacity: 1, transform: "translateY(0)" },
            ],
            { duration: 360, delay: rippleDelay(i), easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "backwards" },
        );
    });
}
