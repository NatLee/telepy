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
 *
 * 設定類的分頁對話框用 `nav`(桌面在內容左側的一欄、手機在內容上方的一列,不跟著內容捲)加 `fixedHeight`:
 * 切換分頁時對話框大小不變,內容多的分頁自己在內容區捲動。
 * Settings-style tabbed dialogs use `nav` (a rail left of the body from `sm` up, a row above it on phones;
 * it never scrolls with the body) plus `fixedHeight`, so switching tabs never resizes the dialog.
 */
import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { DialogOverlay, DialogPortal } from "./dialog";

export type ModalSize = "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl" | "5xl";
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
    /** 側欄導覽(見 NavTabs):桌面在內容左側、手機在內容上方。/ Side navigation: left rail on desktop, a row on phones. */
    nav?: React.ReactNode;
    /** 高度固定(不隨內容伸縮),分頁切換時不會跳動。/ Fixed height, so switching tabs doesn't resize the dialog. */
    fixedHeight?: boolean;
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
    "5xl": "sm:max-w-[min(64rem,calc(100%-2rem))]",
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
            {/* -mt-px:哨兵本身不佔高度,剛好放得下的內容才不會多出 1px 捲軸。/ -mt-px: the sentinel adds no height, so content that just fits gets no 1px scrollbar. */}
            <div ref={end} className="-mt-px h-px shrink-0" aria-hidden />
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
    nav,
    fixedHeight = false,
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
    const hasNav = nav !== undefined && nav !== null && nav !== false;

    const body = hasBody && (
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
    );

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
                        // 桌面:置中卡片,上下各留 2rem(不是 10% 視窗高:高視窗上那 10% 太多,內容只差一點就冒出捲軸)。
                        // Desktop: centred card with 2rem above and below (not 10% of the viewport, which wasted
                        // space on tall windows and left content that only just fit with a sliver of scrollbar).
                        "sm:top-1/2 sm:left-1/2 sm:w-full sm:max-w-[calc(100%-2rem)] sm:max-h-[min(calc(100dvh-4rem),64rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl",
                        "sm:data-[state=open]:animate-dialog-content-show sm:data-[state=closed]:animate-dialog-content-hide",
                        // 手機:底部 sheet。/ Phone: bottom sheet.
                        "max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[92dvh] max-sm:rounded-t-xl",
                        "max-sm:data-[state=open]:animate-sheet-up-show max-sm:data-[state=closed]:animate-sheet-up-hide",
                        SIZE_CLASS[size],
                        // 54rem:分頁對話框的一般內容(通道詳細資訊、金鑰詳細資訊、偏好設定…)在 1080p 上不用捲。
                        // 54rem: the usual tabs of the settings-style dialogs (tunnel / key details, preferences…) fit without scrolling at 1080p.
                        fixedHeight && "sm:h-[min(calc(100dvh-4rem),54rem)] max-sm:h-[92dvh]",
                    )}
                >
                    <div className="sm:hidden mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />

                    <div
                        className={cn(
                            "flex shrink-0 items-start gap-3.5 px-5 sm:px-6 pt-4 sm:pt-5",
                            hasToolbar || hasNav ? "pb-3" : "pb-4",
                            hasBody && !hasToolbar && !hasNav && "border-b border-border/70",
                            // 側欄:桌面上標題列和下面兩欄用細線分開;手機上導覽列自己有底線。/ Desktop: hairline above the rail + body.
                            hasNav && "sm:pb-4 sm:border-b sm:border-border/70",
                        )}
                    >
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
                            {/* min-w-0 + 換行:長的在地化標題(帶使用者名稱等)不會把關閉鈕擠出去，也不會被截成「…」(手機放大顯示時)。
                                min-w-0 + wrapping: long localized titles neither push out the close button nor end in "…" on phones. */}
                            <DialogPrimitive.Title className="text-lg leading-snug text-foreground [overflow-wrap:anywhere]">
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

                    {hasNav ? (
                        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
                            <div className="shrink-0 border-b border-border/70 px-5 pb-3 sm:w-52 sm:overflow-y-auto sm:border-b-0 sm:border-r sm:bg-surface sm:px-3 sm:py-4">
                                {/* 手機上橫向捲動,不會被壓扁。/ Scrolls sideways on phones instead of squashing. */}
                                <div className="-mx-1 overflow-x-auto px-1 py-0.5 sm:m-0 sm:overflow-visible sm:p-0">{nav}</div>
                            </div>
                            {body}
                        </div>
                    ) : (
                        body
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
