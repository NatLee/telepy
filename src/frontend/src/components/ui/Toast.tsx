"use client";

import React, { createContext, useContext, useState, ReactNode } from "react";
import { cn, uniqueID } from "@/lib/utils";
import { X } from "lucide-react";

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

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<ToastProps[]>([]);

    const addToast = (message: string, type: ToastType = "info") => {
        const id = uniqueID();
        setToasts((prev) => [...prev, { id, message, type }]);

        setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id));
        }, 3000);
    };

    const removeToast = (id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    };

    return (
        <ToastContext.Provider
            value={{
                showToast: addToast,
                showError: (msg) => addToast(msg, "error"),
                showSuccess: (msg) => addToast(msg, "success"),
            }}
        >
            {children}
            <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2">
                {toasts.map((t) => (
                    <div
                        key={t.id}
                        className={cn(
                            "flex items-center justify-between p-4 rounded-lg shadow-lg min-w-[250px] transition-all transform duration-300 animate-in slide-in-from-right-full fade-in",
                            t.type === "success" && "bg-success text-success-foreground",
                            t.type === "error" && "bg-destructive text-destructive-foreground",
                            t.type === "warning" && "bg-warning text-warning-foreground",
                            t.type === "info" && "bg-primary text-primary-foreground"
                        )}
                        role="alert"
                    >
                        <div className="text-sm font-medium">{t.message}</div>
                        <button
                            onClick={() => removeToast(t.id)}
                            className="ml-4 opacity-70 hover:opacity-100 hover:rotate-90 hover:scale-110 transition-all duration-200 focus:outline-none"
                        >
                            <X size={16} />
                        </button>
                    </div>
                ))}
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
