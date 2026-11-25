"use client";

/**
 * 手機鍵盤彈起時，遠端畫面（VNC）維持原本大小、往上推到剛剛點的地方在鍵盤上方；收起就滑回原位。直接改 DOM（不經 React
 * 一輪算繪），才趕得上 noVNC 自己在視窗變大小時的處理。只在觸控裝置、焦點在輸入元素上時算數（桌機把視窗拉矮不算）。
 * While a phone keyboard is up the remote screen (VNC) keeps its size and is pushed up until the spot just tapped sits
 * above the keyboard; it slides back when the keyboard closes. The DOM is changed directly (no React render in between)
 * to keep up with noVNC's own handling of window resizes. Only counts on touch devices with focus in an editable element
 * (a desktop window made shorter doesn't).
 * 也一樣只在觸控裝置上：平常就不讓 noVNC 跟著視窗改遠端大小，只有寬度變了（轉向）或高度差很多才改一次（`needsRemoteResize`），
 * 網址列伸縮不會讓遠端重排而閃爍。
 * Also touch devices only: noVNC no longer resizes the remote on every window resize; only a new width (rotation) or a big
 * height change asks once (`needsRemoteResize`), so the address bar sliding in and out no longer makes the remote flicker.
 */
import { useEffect, type RefObject } from "react";
import { isKeyboardOpen, keyboardShift, needsRemoteResize, nextBaseline } from "@/lib/keyboardSteady";

interface ResizableRfb {
    resizeSession: boolean;
    scaleViewport: boolean;
}

function editableFocused(): boolean {
    const el = document.activeElement as HTMLElement | null;
    return !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable);
}

export function useKeyboardSteady(
    enabled: boolean,
    frameRef: RefObject<HTMLElement | null>,
    screenRef: RefObject<HTMLElement | null>,
    rfbRef: RefObject<ResizableRfb | null>,
    /** 指標模式：用游標的位置代替手指點的位置。/ Pointer mode: the cursor's spot instead of where the finger landed. */
    pointYRef?: RefObject<number | null>,
) {
    useEffect(() => {
        const vv = typeof window !== "undefined" ? window.visualViewport : null;
        const frame = frameRef.current;
        const screen = screenRef.current;
        if (!enabled || !vv || !frame || !screen || !window.matchMedia("(pointer: coarse)").matches) return;

        let baseline: { width: number; height: number } | null = null;
        let stableHeight = frame.clientHeight;
        let tapY: number | null = null;
        let frozen: number | null = null;
        let resumeTimer: ReturnType<typeof setTimeout> | undefined;
        // 清理時要的是當下那個 RFB（可能已換過），所以刻意讀 ref。/ Cleanup wants the RFB of that moment (it may have changed), so the ref is read on purpose.
        const restoreResize = () => { const r = rfbRef.current; if (r) r.resizeSession = true; };
        // 遠端最近一次被要求的大小（畫面元素的大小）。連上時那次由 noVNC 自己送，稍後再關掉自動改大小。
        // The size the remote was last asked for (the screen element's). noVNC sends the one on connect; auto-resize goes off shortly after.
        let asked: { width: number; height: number } | null = { width: frame.clientWidth, height: frame.clientHeight };
        const askTimer = setTimeout(() => { const r = rfbRef.current; if (r) r.resizeSession = false; }, 800);
        const askRemote = () => {
            const r = rfbRef.current;
            if (!r) return;
            asked = { width: frame.clientWidth, height: frame.clientHeight };
            r.resizeSession = true; // 設成 true 會立刻送一次 / setting it sends one right away
            clearTimeout(resumeTimer);
            resumeTimer = setTimeout(() => { const x = rfbRef.current; if (x) x.resizeSession = false; }, 800);
        };
        const open = () => isKeyboardOpen(baseline, vv.height) && editableFocused();

        // 點的位置（相對於沒推移的畫面頂端；畫面推上去時 rect.top 也跟著上去）。/ Where the tap was, from the unpushed top.
        const onTap = (e: TouchEvent) => {
            const y = e.touches[0]?.clientY;
            if (y !== undefined) tapY = y - screen.getBoundingClientRect().top;
        };

        const update = () => {
            baseline = nextBaseline(baseline, vv.width, vv.height);
            const rfb = rfbRef.current;
            if (open()) {
                if (frozen === null) {
                    frozen = stableHeight;
                    clearTimeout(resumeTimer);
                    if (rfb) rfb.resizeSession = false; // noVNC 0.5 秒後那次改大小不會送出 / noVNC's pending resize won't be sent
                    screen.style.bottom = "auto";
                    screen.style.height = `${frozen}px`;
                    screen.style.transition = "transform 150ms ease-out";
                }
                const box = frame.getBoundingClientRect();
                const visibleHeight = Math.max(40, Math.min(box.bottom, vv.offsetTop + vv.height) - box.top);
                const shift = keyboardShift({ tapY: pointYRef?.current ?? tapY, frozenHeight: frozen, visibleHeight });
                screen.style.transform = shift ? `translateY(${-shift}px)` : "";
                if (rfb) rfb.scaleViewport = true; // 依固定的大小重算縮放 / rescale against the frozen size
            } else {
                if (frozen !== null) {
                    frozen = null;
                    screen.style.transform = "";
                    screen.style.height = "";
                    screen.style.bottom = "";
                    // 等版面長回來重算縮放；遠端大小沒變，不必再要求。/ Rescale once the layout has grown back; the remote size is unchanged.
                    resumeTimer = setTimeout(() => { const r = rfbRef.current; if (frozen === null && r) r.scaleViewport = true; }, 600);
                }
                stableHeight = frame.clientHeight;
                if (needsRemoteResize(asked, { width: frame.clientWidth, height: frame.clientHeight })) askRemote();
            }
        };
        // focusout 當下焦點還沒換走，晚一拍再看。/ On focusout the focus hasn't moved yet; look a tick later.
        const onFocusOut = () => setTimeout(update, 0);
        const ro = new ResizeObserver(() => {
            if (frozen !== null || open()) return;
            stableHeight = frame.clientHeight;
            if (needsRemoteResize(asked, { width: frame.clientWidth, height: frame.clientHeight })) askRemote();
        });
        ro.observe(frame);
        frame.addEventListener("touchstart", onTap, { passive: true, capture: true });
        vv.addEventListener("resize", update);
        vv.addEventListener("scroll", update);
        document.addEventListener("focusout", onFocusOut);
        update();
        return () => {
            ro.disconnect();
            frame.removeEventListener("touchstart", onTap, { capture: true });
            vv.removeEventListener("resize", update);
            vv.removeEventListener("scroll", update);
            document.removeEventListener("focusout", onFocusOut);
            clearTimeout(resumeTimer);
            clearTimeout(askTimer);
            restoreResize(); // 離開時恢復原本的行為 / back to the default on the way out
            screen.style.transform = "";
            screen.style.height = "";
            screen.style.bottom = "";
            screen.style.transition = "";
        };
    }, [enabled, frameRef, screenRef, rfbRef, pointYRef]);
}
