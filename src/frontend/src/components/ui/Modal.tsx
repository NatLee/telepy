import React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { Dialog, DialogContent, DialogTitle } from "./dialog";

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: React.ReactNode;
    footer?: React.ReactNode;
    size?: "sm" | "md" | "lg" | "2xl" | "3xl" | "4xl";
    isLoading?: boolean;
}

export function Modal({ isOpen, onClose, title, children, footer, size = "md", isLoading = false }: ModalProps) {
    const { t } = useI18n();
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
                    // 大尺寸用 min() 夾住:sm:max-w-* 會蓋掉基底的 calc(100%-2rem),
                    // 不夾的話在 640px~ 的窄視窗(iPad 直立)會貼齊螢幕邊緣。
                    // Large sizes keep the 1rem gutter via min() — the sm:max-w-* rule overrides the
                    // base calc(100%-2rem) clamp, so without it these go edge-to-edge on ~640-928px viewports.
                    size === "2xl" && "sm:max-w-[min(42rem,calc(100%-2rem))]",
                    size === "3xl" && "sm:max-w-[min(48rem,calc(100%-2rem))]",
                    size === "4xl" && "sm:max-w-[min(56rem,calc(100%-2rem))]"
                )}
                showCloseButton={false}
            >
                <div className="flex items-center justify-between gap-3 px-6 py-5 border-b border-border/40 bg-muted/30">
                    {/* min-w-0 + truncate:長的在地化標題(帶使用者名稱等)才不會把關閉鈕擠出邊界。
                        min-w-0 + truncate so long localized titles (with usernames, etc.) don't push out the close button. */}
                    <DialogTitle className="min-w-0 truncate text-xl font-semibold leading-tight tracking-tight">
                        {title}
                    </DialogTitle>
                    <button
                        type="button"
                        onClick={onClose}
                        className="shrink-0 text-muted-foreground hover:bg-muted hover:rotate-90 hover:scale-110 p-1.5 rounded-full transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <X size={18} />
                        <span className="sr-only">{t("common.close")}</span>
                    </button>
                </div>
                <div className="flex flex-col flex-1 min-h-0 p-6 overflow-y-auto relative">
                    {isLoading && (
                        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-background/50 backdrop-blur-[2px] min-h-[150px]">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                            <span className="sr-only">{t("common.loading")}</span>
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

