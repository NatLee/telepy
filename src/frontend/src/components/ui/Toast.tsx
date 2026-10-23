"use client";

import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, useSyncExternalStore, ReactNode } from "react";
import { cn, uniqueID } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { CircleCheck, CircleX, Info, TriangleAlert, X } from "lucide-react";

export type ToastType = "success" | "error" | "warning" | "info";

interface ToastProps {
    id: string;
    message: string;
    type: ToastType;
    /** 停留多久（毫秒）。/ How long it stays, in ms. */
    duration: number;
}

interface ToastContextType {
    showToast: (message: string, type?: ToastType) => void;
    showError: (message: string) => void;
    showSuccess: (message: string) => void;
}

const TOAST_ICON: Record<ToastType, typeof Info> = {
    success: CircleCheck,
    error: CircleX,
    warning: TriangleAlert,
    info: Info,
};

const TOAST_TONE: Record<ToastType, string> = {
    success: "text-success",
    error: "text-destructive",
    warning: "text-warning",
    info: "text-info",
};

const TOAST_BAR: Record<ToastType, string> = {
    success: "bg-success/60",
    error: "bg-destructive/60",
    warning: "bg-warning/60",
    info: "bg-info/60",
};

// 停留時間：依類型給底（錯誤要讀、可能要照著做，給最久），長訊息再多給閱讀時間，最長 12 秒。
// Time on screen: a base per type (errors get the longest — they are read and often acted on), plus reading
// time for long messages, capped at 12 s.
const BASE_DURATION_MS: Record<ToastType, number> = { success: 4000, info: 5000, warning: 6000, error: 7000 };
const MAX_DURATION_MS = 12000;

function toastDuration(type: ToastType, message: string): number {
    return Math.min(MAX_DURATION_MS, BASE_DURATION_MS[type] + Math.max(0, message.length - 40) * 50);
}

function subscribeVisibility(onChange: () => void) {
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
}

/** 分頁是否在背景（看不到的通知不該倒數）。/ Whether the tab is hidden (unseen toasts shouldn't count down). */
function useTabHidden(): boolean {
    return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "hidden", () => false);
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<ToastProps[]>([]);
    const toastsRef = useRef<ToastProps[]>([]);
    // 滑鼠停在任一則、鍵盤焦點在裡面、或分頁在背景時，全部暫停倒數（只停那一則的話，其他則消失會讓整疊在游標下位移）。
    // 記的是「哪一則」：那則被關掉時不會有 leave / blur，但它不在清單裡了就自然不算。
    // Pause every countdown while the pointer is on a toast, focus is inside one, or the tab is hidden (pausing only
    // that one would let the others vanish and shift the stack under the pointer). We remember *which* toast: closing
    // it fires no leave / blur, but once it's gone from the list it simply stops counting.
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const [focusedId, setFocusedId] = useState<string | null>(null);
    const tabHidden = useTabHidden();
    const paused = tabHidden || toasts.some((t) => t.id === hoveredId || t.id === focusedId);

    // Keep ref in sync so addToast can read current toasts without being a dependency
    const updateToasts = useCallback((updater: (prev: ToastProps[]) => ToastProps[]) => {
        setToasts((prev) => {
            const next = updater(prev);
            toastsRef.current = next;
            return next;
        });
    }, []);

    const removeToast = useCallback((id: string) => {
        updateToasts((prev) => prev.filter((t) => t.id !== id));
    }, [updateToasts]);

    const addToast = useCallback((message: string, type: ToastType = "info") => {
        // Deduplicate error toasts: skip if an identical error message is already visible
        if (type === "error") {
            const isDuplicate = toastsRef.current.some(
                (t: ToastProps) => t.type === "error" && t.message === message
            );
            if (isDuplicate) return;
        }

        const id = uniqueID();
        updateToasts((prev) => [...prev, { id, message, type, duration: toastDuration(type, message) }]);
    }, [updateToasts]);

    const contextValue = useMemo<ToastContextType>(() => ({
        showToast: addToast,
        showError: (msg: string) => addToast(msg, "error"),
        showSuccess: (msg: string) => addToast(msg, "success"),
    }), [addToast]);

    return (
        <ToastContext.Provider value={contextValue}
        >
            {children}
            <div className="pointer-events-none fixed top-4 right-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
                {toasts.map((t) => (
                    <ToastItem
                        key={t.id}
                        toast={t}
                        paused={paused}
                        onDismiss={removeToast}
                        onHover={setHoveredId}
                        onFocusChange={setFocusedId}
                    />
                ))}
            </div>
        </ToastContext.Provider>
    );
}

/**
 * 一則通知。底部的細條從滿格縮到零 = 還剩多久自動關閉；暫停時細條停住。
 * 計時與細條由同一個 effect 管：暫停時記下剩餘時間，細條用 Web Animations 跳到同一個位置再播 / 停，所以不會走散
 * （CSS 的 animation-play-state 在背景分頁不會套用，切回來時細條會比計時快）。減少動態時細條每秒跳一格。
 * One toast. The thin bar along the bottom shrinks from full to empty = time left before it closes itself; it
 * freezes while paused. One effect owns both the timer and the bar: on pause it records what's left, and the bar
 * (Web Animations) is seeked to the same point before it plays / pauses, so the two can't drift (a CSS
 * animation-play-state change isn't applied in a background tab, which left the bar ahead of the timer).
 * With reduced motion the bar moves in one-second steps.
 */
function ToastItem({
    toast,
    paused,
    onDismiss,
    onHover,
    onFocusChange,
}: {
    toast: ToastProps;
    paused: boolean;
    onDismiss: (id: string) => void;
    onHover: React.Dispatch<React.SetStateAction<string | null>>;
    onFocusChange: React.Dispatch<React.SetStateAction<string | null>>;
}) {
    const { t } = useI18n();
    const reducedMotion = useReducedMotion();
    const remainingRef = useRef(toast.duration);
    const barRef = useRef<HTMLSpanElement>(null);
    const barAnimRef = useRef<Animation | null>(null);
    const { id, duration } = toast;

    useEffect(() => {
        if (paused) return;
        const startedAt = Date.now();
        const timer = setTimeout(() => onDismiss(id), remainingRef.current);

        barAnimRef.current?.cancel();
        const bar = barRef.current?.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], {
            duration,
            fill: "forwards",
            easing: reducedMotion ? `steps(${Math.ceil(duration / 1000)}, end)` : "linear",
        });
        if (bar) bar.currentTime = duration - remainingRef.current;
        barAnimRef.current = bar ?? null;

        return () => {
            clearTimeout(timer);
            remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAt));
            if (bar) {
                bar.pause();
                bar.currentTime = duration - remainingRef.current;
            }
        };
    }, [paused, reducedMotion, id, duration, onDismiss]);

    const Icon = TOAST_ICON[toast.type];
    const urgent = toast.type === "error" || toast.type === "warning";
    return (
        <div
            className="pointer-events-auto relative flex items-start gap-3 overflow-hidden rounded-lg border border-border bg-popover py-3 pr-2.5 pl-3.5 text-popover-foreground shadow-pop animate-toast-in"
            role={urgent ? "alert" : "status"}
            onPointerEnter={() => onHover(id)}
            onPointerLeave={() => onHover((cur) => (cur === id ? null : cur))}
            onFocus={() => onFocusChange(id)}
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onFocusChange((cur) => (cur === id ? null : cur));
            }}
        >
            <span className={cn("mt-0.5 shrink-0", TOAST_TONE[toast.type])}>
                <Icon size={17} aria-hidden />
            </span>
            <div className="min-w-0 flex-1 pt-0.5 text-sm leading-relaxed break-words">{toast.message}</div>
            <button
                onClick={() => onDismiss(id)}
                aria-label={t("common.close")}
                className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
                <X size={15} />
            </button>
            <span
                ref={barRef}
                aria-hidden
                className={cn("absolute inset-x-0 bottom-0 h-0.5 origin-left", TOAST_BAR[toast.type])}
            />
        </div>
    );
}

export const useToast = () => {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error("useToast must be used within a ToastProvider");
    }
    return context;
};
