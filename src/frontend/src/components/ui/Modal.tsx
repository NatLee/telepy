"use client";

/**
 * 全站對話框外殼：標題列(可選圖示與副標)、可捲動內容、底部按鈕列。手機上變成從底部滑出的 sheet。
 * App-wide dialog shell: header (optional icon tile + description), scrolling body, footer bar.
 * On phones it becomes a bottom sheet.
 *
 * 開啟時焦點放在對話框本身而不是第一個按鈕(關閉鈕):不會一打開就亮出焦點框,Tab 仍可依序進入;
 * 需要直接打字的表單在欄位上加 autoFocus 即可(Radix 看到內部已有焦點就不再搶)。
 * On open, focus lands on the panel itself instead of the first tabbable (the close button), so no
 * focus ring flashes on open; Tab still walks in order. Forms that want typing right away put
 * autoFocus on the field — Radix leaves an already-focused descendant alone.
 */
import React, { useRef } from "react";
import { Loader2, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { DialogOverlay, DialogPortal } from "./dialog";

export type ModalSize = "sm" | "md" | "lg" | "2xl" | "3xl" | "4xl";
export type ModalTone = "default" | "danger";

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    /** 標題下的一行說明。/ One-line description under the title. */
    description?: React.ReactNode;
    /** 標題左側的圖示(lucide 元件實例)。/ Icon shown in a tile left of the title (a lucide element). */
    icon?: React.ReactNode;
    tone?: ModalTone;
    children?: React.ReactNode;
    footer?: React.ReactNode;
    size?: ModalSize;
    isLoading?: boolean;
    /** 內容區額外 class(例如改掉預設內距)。/ Extra classes for the body (e.g. to change the padding). */
    bodyClassName?: string;
}

const SIZE_CLASS: Record<ModalSize, string> = {
    sm: "sm:max-w-sm",
    md: "sm:max-w-md",
    lg: "sm:max-w-lg",
    // 大尺寸用 min() 夾住:sm:max-w-* 會蓋掉基底的 calc(100%-2rem),不夾的話在 640px~ 的窄視窗會貼齊螢幕邊緣。
    // Large sizes keep the 1rem gutter via min() — sm:max-w-* overrides the base calc(100%-2rem) clamp.
    "2xl": "sm:max-w-[min(42rem,calc(100%-2rem))]",
    "3xl": "sm:max-w-[min(48rem,calc(100%-2rem))]",
    "4xl": "sm:max-w-[min(56rem,calc(100%-2rem))]",
};

export function Modal({
    isOpen,
    onClose,
    title,
    description,
    icon,
    tone = "default",
    children,
    footer,
    size = "md",
    isLoading = false,
    bodyClassName,
}: ModalProps) {
    const { t } = useI18n();
    const contentRef = useRef<HTMLDivElement>(null);
    const hasBody = children !== undefined && children !== null && children !== false;

    return (
        <DialogPrimitive.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogPortal>
                <DialogOverlay />
                <DialogPrimitive.Content
                    ref={contentRef}
                    data-slot="dialog-content"
                    {...(description ? {} : { "aria-describedby": undefined })}
                    onOpenAutoFocus={(e) => {
                        e.preventDefault();
                        contentRef.current?.focus({ preventScroll: true });
                    }}
                    className={cn(
                        "fixed z-50 flex flex-col overflow-hidden bg-card text-card-foreground shadow-dialog outline-none",
                        // 桌面:置中卡片。/ Desktop: centred card.
                        "sm:top-1/2 sm:left-1/2 sm:w-full sm:max-w-[calc(100%-2rem)] sm:max-h-[min(88dvh,60rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[1.25rem]",
                        "sm:data-[state=open]:animate-dialog-content-show sm:data-[state=closed]:animate-dialog-content-hide",
                        // 手機:底部 sheet。/ Phone: bottom sheet.
                        "max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[92dvh] max-sm:rounded-t-[1.5rem]",
                        "max-sm:data-[state=open]:animate-sheet-up-show max-sm:data-[state=closed]:animate-sheet-up-hide",
                        SIZE_CLASS[size],
                    )}
                >
                    <div className="sm:hidden mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />

                    <div className={cn("flex items-start gap-3.5 px-5 sm:px-6 pt-4 sm:pt-5 pb-4", hasBody && "border-b border-border/70")}>
                        {icon && (
                            <span
                                aria-hidden
                                className={cn(
                                    "grid size-10 shrink-0 place-items-center rounded-xl ring-1 ring-inset [&_svg]:size-5",
                                    tone === "danger"
                                        ? "bg-destructive/10 text-destructive ring-destructive/15"
                                        : "bg-primary/10 text-primary ring-primary/15",
                                )}
                            >
                                {icon}
                            </span>
                        )}
                        <div className={cn("min-w-0 flex-1", icon && "pt-0.5")}>
                            {/* min-w-0 + truncate:長的在地化標題(帶使用者名稱等)才不會把關閉鈕擠出去。
                                min-w-0 + truncate so long localized titles don't push out the close button. */}
                            <DialogPrimitive.Title className="truncate text-lg leading-snug text-foreground">
                                {title}
                            </DialogPrimitive.Title>
                            {description && (
                                <DialogPrimitive.Description asChild>
                                    <div className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{description}</div>
                                </DialogPrimitive.Description>
                            )}
                        </div>
                        <DialogPrimitive.Close
                            className="-mr-1.5 -mt-0.5 grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        >
                            <X size={18} />
                            <span className="sr-only">{t("common.close")}</span>
                        </DialogPrimitive.Close>
                    </div>

                    {hasBody && (
                        <div className={cn("relative flex min-h-0 flex-1 flex-col overflow-y-auto px-5 sm:px-6 py-5", isLoading && "min-h-40", bodyClassName)}>
                            {isLoading && (
                                <div className="absolute inset-0 z-10 flex items-center justify-center bg-card/70 backdrop-blur-[2px]">
                                    <Loader2 className="size-6 animate-spin text-primary" />
                                    <span className="sr-only">{t("common.loading")}</span>
                                </div>
                            )}
                            {children}
                        </div>
                    )}

                    {footer && (
                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border/70 bg-surface px-5 sm:px-6 py-3.5 max-sm:pb-[max(0.875rem,env(safe-area-inset-bottom))]">
                            {footer}
                        </div>
                    )}
                </DialogPrimitive.Content>
            </DialogPortal>
        </DialogPrimitive.Root>
    );
}
