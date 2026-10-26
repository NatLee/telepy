/**
 * 「已分享給 N 人」標籤：滑鼠移上去（或用鍵盤聚焦）就浮出分享對象名單，觸控裝置點一下也一樣；點一下（或按 Enter）
 * 會把浮層固定住，可以按「管理分享」。名單最多 8 人，多的收成「… 還有 N 人」。名單來自列表的 `shared_with`
 * （只給 owner / ADMIN）；沒有名單時就是原本不能點的標籤。
 * "Shared with N" chip: hovering it (or focusing it from the keyboard) shows who the tunnel is shared with, and a tap
 * does the same on touch screens; a click (or Enter) keeps the panel open so "Manage sharing" can be reached. At most
 * 8 names, the rest folded into "… and N more". The names come from the list's `shared_with` (owner / ADMIN only);
 * without them it stays the plain chip.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Users } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { shareePreview } from "@/lib/sharedWith";
import type { TranslationKey } from "@/locales/en";
import type { TunnelSharee } from "@/types/tunnel";

const PERM_LABEL: Record<string, TranslationKey> = { view: "share.permView", edit: "share.permEdit", admin: "share.permAdmin" };

/** 滑鼠移上去多久打開、移開多久關（移到浮層上不會關）。/ Hover open / close delays (moving onto the panel keeps it open). */
const OPEN_DELAY = 120;
const CLOSE_DELAY = 160;

export function SharedWithChip({
    count,
    sharees,
    onManage,
    className,
}: {
    count: number;
    /** null / undefined = 這位使用者拿不到名單。/ null = this viewer gets no names. */
    sharees?: TunnelSharee[] | null;
    onManage?: () => void;
    className?: string;
}) {
    const { t } = useI18n();
    // hover 也會打開的 Popover：滑鼠 hover / 鍵盤聚焦先「預覽」，點一下才固定；觸控只有點擊（觸控沒有 hover）。
    // A popover that also opens on hover: mouse hover / keyboard focus preview it, a click pins it; touch only taps.
    const [open, setOpen] = useState(false);
    const pinned = useRef(false);
    const timer = useRef<number | undefined>(undefined);
    // 關閉時要不要把焦點還給標籤（只有鍵盤把焦點移進浮層時）；還回去的那次 focus 不要又打開。
    // Return focus to the chip on close only when the keyboard moved it into the panel; that focus must not reopen it.
    const returnFocus = useRef(false);
    const skipFocus = useRef(false);
    const manageButton = useRef<HTMLButtonElement | null>(null);
    const clear = useCallback(() => {
        if (timer.current !== undefined) window.clearTimeout(timer.current);
        timer.current = undefined;
    }, []);
    useEffect(() => clear, [clear]);
    const label = t("tunnels.sharedWithCount", { count });

    if (!sharees) {
        return (
            <span className={className} title={label}>
                <Users /> {label}
            </span>
        );
    }

    const { shown, more } = shareePreview(sharees, count);
    const later = (next: boolean, ms: number) => {
        clear();
        timer.current = window.setTimeout(() => {
            timer.current = undefined;
            setOpen(next);
        }, ms);
    };
    const set = (next: boolean) => {
        clear();
        pinned.current = next;
        setOpen(next);
    };
    const mouse = (e: React.PointerEvent) => e.pointerType === "mouse";
    const leave = (e: React.PointerEvent) => {
        if (mouse(e) && !pinned.current) later(false, CLOSE_DELAY);
    };
    return (
        <Popover open={open} onOpenChange={set}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    aria-label={`${label} · ${t("tunnels.sharedWithShow")}`}
                    className={cn(
                        className,
                        "transition-colors hover:border-foreground/25 hover:text-foreground",
                        "data-[state=open]:border-foreground/25 data-[state=open]:text-foreground",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    )}
                    onPointerEnter={e => {
                        if (!mouse(e)) return;
                        if (open) clear();
                        else later(true, OPEN_DELAY);
                    }}
                    onPointerLeave={leave}
                    onFocus={e => {
                        if (skipFocus.current) {
                            skipFocus.current = false;
                            return;
                        }
                        if (e.currentTarget.matches(":focus-visible")) {
                            clear();
                            setOpen(true);
                        }
                    }}
                    onBlur={() => {
                        if (!pinned.current) {
                            clear();
                            setOpen(false);
                        }
                    }}
                    onClick={e => {
                        // 鍵盤（Enter / 空白鍵）打開時把焦點移到浮層裡的按鈕。/ Opened from the keyboard: move focus into the panel.
                        if (e.detail === 0 && onManage) {
                            returnFocus.current = true;
                            requestAnimationFrame(() => manageButton.current?.focus());
                        }
                        // hover 預覽中再點一下 = 固定住，而不是關掉。/ A click on a hover preview pins it instead of closing it.
                        if (open && !pinned.current) {
                            e.preventDefault();
                            clear();
                            pinned.current = true;
                        }
                    }}
                >
                    <Users /> {label}
                </button>
            </PopoverTrigger>
            <PopoverContent
                align="start"
                className="flex w-64 flex-col overflow-hidden"
                onPointerEnter={e => {
                    if (mouse(e)) clear();
                }}
                onPointerLeave={leave}
                // 焦點留在標籤上（浮層裡只有名單）；關掉時也不要把焦點搶回標籤（滑鼠移開時會捲動頁面）。
                // Keep focus on the chip, and don't pull it back on close (a hover-out would scroll the page).
                onOpenAutoFocus={e => e.preventDefault()}
                onCloseAutoFocus={e => {
                    if (returnFocus.current) {
                        // Radix 接著同步把焦點還給標籤（Tab 離開時不會），所以只擋這一輪。
                        // Radix refocuses the chip synchronously right after (not when Tab left the panel), so skip only this turn.
                        skipFocus.current = true;
                        window.setTimeout(() => (skipFocus.current = false), 0);
                    } else e.preventDefault();
                    returnFocus.current = false;
                }}
            >
                <p className="shrink-0 border-b border-border px-3 py-2 text-sm text-foreground">{label}</p>
                <ul className="min-h-0 overflow-y-auto overscroll-contain py-1">
                    {shown.map(s => (
                        <li key={s.id} className="flex items-center gap-2.5 px-3 py-1.5">
                            <span
                                className="grid size-6 shrink-0 place-items-center rounded-full bg-foreground text-background text-[0.6875rem] uppercase"
                                aria-hidden
                            >
                                {s.username.slice(0, 1)}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={s.username}>
                                {s.username}
                            </span>
                            <span className="shrink-0 rounded-sm bg-muted px-1.5 py-px text-[0.75rem] text-foreground/75">
                                {PERM_LABEL[s.permission] ? t(PERM_LABEL[s.permission]) : s.permission}
                            </span>
                        </li>
                    ))}
                    {more > 0 && <li className="px-3 py-1.5 text-xs text-muted-foreground">{t("tunnels.sharedWithMore", { count: more })}</li>}
                </ul>
                {onManage && (
                    <button
                        ref={manageButton}
                        type="button"
                        onClick={() => {
                            set(false);
                            onManage();
                        }}
                        className="shrink-0 border-t border-border px-3 py-2 text-left text-xs text-foreground/80 hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:outline-none"
                    >
                        {t("tunnels.sharedWithManage")}
                    </button>
                )}
            </PopoverContent>
        </Popover>
    );
}
