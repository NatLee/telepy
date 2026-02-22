import React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "./dialog";

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: React.ReactNode;
    footer?: React.ReactNode;
    size?: "sm" | "md" | "lg" | "xl";
    isLoading?: boolean;
}

export function Modal({ isOpen, onClose, title, children, footer, size = "md", isLoading = false }: ModalProps) {
    return (
        <Dialog open={isOpen} onOpenChange={(open) => {
            if (!open) onClose();
        }}>
            <DialogContent
                className={cn(
                    "flex flex-col max-h-[90vh] p-0 gap-0 overflow-hidden outline-none bg-background text-foreground shadow-2xl border-border/60 sm:rounded-2xl",
                    size === "sm" && "sm:max-w-sm",
                    size === "md" && "sm:max-w-md",
                    size === "lg" && "sm:max-w-lg",
                    size === "xl" && "sm:max-w-4xl"
                )}
                showCloseButton={false}
            >
                <div className="flex items-center justify-between px-6 py-5 border-b border-border/40 bg-muted/30">
                    <DialogTitle className="text-xl font-semibold leading-tight tracking-tight">
                        {title}
                    </DialogTitle>
                    <button
                        onClick={onClose}
                        className="text-muted-foreground hover:bg-muted hover:rotate-90 hover:scale-110 p-1.5 rounded-full transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                        <X size={18} />
                        <span className="sr-only">Close</span>
                    </button>
                </div>
                <div className="flex flex-col flex-1 min-h-0 p-6 overflow-y-auto relative">
                    {isLoading && (
                        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-background/50 backdrop-blur-[2px] min-h-[150px]">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                            <span className="sr-only">Loading...</span>
                        </div>
                    )}
                    {children}
                </div>
                {footer && (
                    <div className="flex items-center justify-end px-6 py-4 border-t border-border/40 bg-muted/10 gap-3">
                        {footer}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

