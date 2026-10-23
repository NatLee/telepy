"use client";

/**
 * 全站對話框外殼:標題列(可選圖示與副標)、可選的工具列(分頁 / 篩選,固定不捲動)、可捲動內容、底部按鈕列。
 * 手機上變成從底部滑出的 sheet。
 * App-wide dialog shell: header (optional icon tile + description), an optional non-scrolling toolbar
 * row (tabs / filters), scrolling body, footer bar. On phones it becomes a bottom sheet.
 *
 * 工具列獨立成一列而不是放在內容裡:內容區是 flex 子項且會捲動,分頁放在裡面時會被擠扁或捲出視野
 * (「目標主機連線腳本」的分頁就是這樣消失的)。
 * The toolbar is its own row rather than part of the body: the body is a shrinking, scrolling flex
 * child, and tabs placed inside it got squashed or scrolled away (how the script dialog lost its tabs).
 *
 * 開啟時焦點放在對話框本身而不是第一個按鈕(關閉鈕):不會一打開就亮出焦點框,Tab 仍可依序進入;
 * 需要直接打字的表單在欄位上加 autoFocus 即可(Radix 看到內部已有焦點就不再搶)。
 * On open, focus lands on the panel itself instead of the first tabbable (the close button), so no
 * focus ring flashes on open; Tab still walks in order. Forms that want typing right away put
 * autoFocus on the field — Radix leaves an already-focused descendant alone.
 *
 * 內容區是對話框裡唯一會捲動的地方:不要在裡面再放固定高度的捲動框(看不出來能捲,內容像被切掉)。
 * 內容超出時,底部會浮出「往下還有」提示,點一下捲到底。
 * The body is the only scrolling area in a dialog: never nest a fixed-height scroll box inside it (it
 * doesn't read as scrollable and the content looks cut off). When the body overflows, a "More below"
 * cue floats at the bottom; clicking it scrolls to the end.
 */
import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { DialogOverlay, DialogPortal } from "./dialog";

export type ModalSize = "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl";
export type ModalTone = "default" | "danger";

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: React.ReactNode;
    /** 標題下的一行說明。/ One-line description under the title. */
    description?: React.ReactNode;
    /** 標題左側的圖示(lucide 元件實例)。/ Icon shown in a tile left of the title (a lucide element). */
    icon?: React.ReactNode;
    tone?: ModalTone;
    /** 標題列下方、內容上方的固定列(分頁、篩選)。/ Fixed row between header and body (tabs, filters). */
    toolbar?: React.ReactNode;
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
    xl: "sm:max-w-[min(36rem,calc(100%-2rem))]",
    // 大尺寸用 min() 夾住:sm:max-w-* 會蓋掉基底的 calc(100%-2rem),不夾的話在 640px~ 的窄視窗會貼齊螢幕邊緣。
    // Large sizes keep the 1rem gutter via min() — sm:max-w-* overrides the base calc(100%-2rem) clamp.
    "2xl": "sm:max-w-[min(42rem,calc(100%-2rem))]",
    "3xl": "sm:max-w-[min(48rem,calc(100%-2rem))]",
    "4xl": "sm:max-w-[min(56rem,calc(100%-2rem))]",
};

/**
 * 內容區底部的哨兵:看不到它(內容還沒捲到底)時顯示淡出遮罩 + 「往下還有」。sticky 的 -bottom-5 抵銷內容區的 py-5。
 * A sentinel at the end of the body: while it is out of view, show a fade and a "More below" pill.
 * The sticky -bottom-5 offsets the body's py-5. 其他捲動區（例如浮層）用 className 改位置與底色。
 * Other scroll areas (e.g. a popover) pass `className` to change the offset and the fade colour.
 */
export function MoreBelow({ className }: { className?: string }) {
    const { t } = useI18n();
    const end = useRef<HTMLDivElement>(null);
    const [cut, setCut] = useState(false);
    useEffect(() => {
        const el = end.current;
        if (!el || typeof IntersectionObserver === "undefined") return;
        const io = new IntersectionObserver(([e]) => setCut(!e.isIntersecting));
        io.observe(el);
        return () => io.disconnect();
    }, []);
    return (
        <>
            <div ref={end} className="h-px shrink-0" aria-hidden />
            <div
                aria-hidden
                className={cn(
                    "pointer-events-none sticky -bottom-5 z-20 -mt-16 flex h-16 shrink-0 items-end justify-center bg-gradient-to-t from-card via-card/85 to-transparent pb-1 transition-opacity duration-200",
                    cut ? "opacity-100" : "opacity-0",
                    className,
                )}
            >
                <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => end.current?.scrollIntoView({ behavior: "smooth", block: "end" })}
                    className={cn(
                        "inline-flex items-center gap-1 rounded-md bg-card px-3 py-1 text-xs text-muted-foreground shadow-pop ring-1 ring-border hover:text-foreground",
                        cut && "pointer-events-auto",
                    )}
                >
                    <ChevronDown size={13} className="animate-bounce" aria-hidden />
                    {t("ui.moreBelow")}
                </button>
            </div>
        </>
    );
}

export function Modal({
    isOpen,
    onClose,
    title,
    description,
    icon,
    tone = "default",
    toolbar,
    children,
    footer,
    size = "md",
    isLoading = false,
    bodyClassName,
}: ModalProps) {
    const { t } = useI18n();
    const contentRef = useRef<HTMLDivElement>(null);
    const hasBody = children !== undefined && children !== null && children !== false;
    const hasToolbar = toolbar !== undefined && toolbar !== null && toolbar !== false;

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
                        "sm:top-1/2 sm:left-1/2 sm:w-full sm:max-w-[calc(100%-2rem)] sm:max-h-[min(90dvh,64rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl",
                        "sm:data-[state=open]:animate-dialog-content-show sm:data-[state=closed]:animate-dialog-content-hide",
                        // 手機:底部 sheet。/ Phone: bottom sheet.
                        "max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[92dvh] max-sm:rounded-t-xl",
                        "max-sm:data-[state=open]:animate-sheet-up-show max-sm:data-[state=closed]:animate-sheet-up-hide",
                        SIZE_CLASS[size],
                    )}
                >
                    <div className="sm:hidden mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />

                    <div className={cn("flex shrink-0 items-start gap-3.5 px-5 sm:px-6 pt-4 sm:pt-5", hasToolbar ? "pb-3" : "pb-4", hasBody && !hasToolbar && "border-b border-border/70")}>
                        {icon && (
                            <span
                                aria-hidden
                                className={cn(
                                    // 圖示方塊是中性的；只有危險操作才上色，免得每個對話框都一片橘。
                                    // The icon tile is neutral; only dangerous actions get colour, so dialogs aren't all orange.
                                    "grid size-9 shrink-0 place-items-center rounded-md border [&_svg]:size-[18px]",
                                    tone === "danger"
                                        ? "border-destructive/20 bg-destructive/10 text-destructive"
                                        : "border-border bg-surface text-foreground/70",
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
                            className="-mr-1.5 -mt-0.5 grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        >
                            <X size={18} />
                            <span className="sr-only">{t("common.close")}</span>
                        </DialogPrimitive.Close>
                    </div>

                    {hasToolbar && (
                        <div className={cn("shrink-0 px-5 sm:px-6 pb-3.5", hasBody && "border-b border-border/70")}>
                            {/* 窄視窗時分頁橫向捲動,不會被壓扁。/ Scrolls sideways when narrow instead of squashing. */}
                            <div className="-mx-1 overflow-x-auto px-1 py-0.5">{toolbar}</div>
                        </div>
                    )}

                    {hasBody && (
                        <div className={cn("relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-5 sm:px-6 py-5", isLoading && "min-h-40", bodyClassName)}>
                            {isLoading && (
                                <div className="absolute inset-0 z-10 flex items-center justify-center bg-card/70">
                                    <Loader2 className="size-6 animate-spin text-primary" />
                                    <span className="sr-only">{t("common.loading")}</span>
                                </div>
                            )}
                            {children}
                            <MoreBelow />
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
