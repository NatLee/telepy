"use client";

import React, { createContext, useContext, useState, useCallback, useMemo, useRef, ReactNode } from "react";
import { cn, uniqueID } from "@/lib/utils";
import { CircleCheck, CircleX, Info, TriangleAlert, X } from "lucide-react";

export type ToastType = "success" | "error" | "warning" | "info";

interface ToastProps {
    id: string;
    message: string;
    type: ToastType;
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
    success: "bg-success/12 text-success",
    error: "bg-destructive/12 text-destructive",
    warning: "bg-warning/15 text-warning",
    info: "bg-info/12 text-info",
};

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<ToastProps[]>([]);
    const toastsRef = useRef<ToastProps[]>([]);

    // Keep ref in sync so addToast can read current toasts without being a dependency
    const updateToasts = useCallback((updater: (prev: ToastProps[]) => ToastProps[]) => {
        setToasts((prev) => {
            const next = updater(prev);
            toastsRef.current = next;
            return next;
        });
    }, []);

    const addToast = useCallback((message: string, type: ToastType = "info") => {
        // Deduplicate error toasts: skip if an identical error message is already visible
        if (type === "error") {
            const isDuplicate = toastsRef.current.some(
                (t: ToastProps) => t.type === "error" && t.message === message
            );
            if (isDuplicate) return;
        }

        const id = uniqueID();
        updateToasts((prev) => [...prev, { id, message, type }]);

        setTimeout(() => {
            updateToasts((prev) => prev.filter((t) => t.id !== id));
        }, 3000);
    }, [updateToasts]);

    const removeToast = (id: string) => {
        updateToasts((prev) => prev.filter((t) => t.id !== id));
    };

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
                {toasts.map((t) => {
                    const Icon = TOAST_ICON[t.type];
                    return (
                        <div
                            key={t.id}
                            className="pointer-events-auto flex items-start gap-3 rounded-xl bg-popover py-3 pr-2.5 pl-3.5 text-popover-foreground shadow-pop animate-toast-in"
                            role="alert"
                        >
                            <span className={cn("mt-px grid size-6 shrink-0 place-items-center rounded-full", TOAST_TONE[t.type])}>
                                <Icon size={15} aria-hidden />
                            </span>
                            <div className="min-w-0 flex-1 pt-0.5 text-sm leading-relaxed break-words">{t.message}</div>
                            <button
                                onClick={() => removeToast(t.id)}
                                className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                            >
                                <X size={15} />
                            </button>
                        </div>
                    );
                })}
            </div>
        </ToastContext.Provider>
    );
}

export const useToast = () => {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error("useToast must be used within a ToastProvider");
    }
    return context;
};
