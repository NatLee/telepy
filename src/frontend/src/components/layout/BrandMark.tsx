"use client";

/**
 * Telepy 品牌標誌：漸層圖示 + 字標，側邊欄與手機選單共用。全站唯一保留品牌漸層的地方（logo 方塊），不加光暈。
 * `playful`（只有登入後的側邊欄 / 手機頂列）才有彩蛋：連點 7 次 logo 會沿著折返線重畫、Tapi 跳出來打招呼；
 * 農曆新年方塊長出柿蒂（柿柿如意）、Telepy 生日戴派對帽（lib/festivals）。登入、兩步驟設定等頁面不給。
 * Telepy brand mark (gradient tile + wordmark), shared by the sidebar and the mobile menu. The logo tile is the
 * one place that keeps the brand gradient — no glow. Only `playful` marks (the signed-in sidebar / mobile bar) carry
 * the easter eggs: seven clicks redraw the glyph and Tapi pops up; at Lunar New Year the tile grows a persimmon
 * calyx, on Telepy's birthday it wears a party hat. Sign-in and enrolment screens never get them.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { useFestival, useTapi } from "@/hooks/useTapi";
import { TelepyGlyph, TelepyGlyphDrawing } from "@/components/brand/TelepyGlyph";
import { Tapi } from "@/components/brand/Tapi";

const CLICKS = 7;
const WINDOW_MS = 4000;
const CARD_MS = 7000;

/** 柿蒂：讓橘色方塊變成一顆柿子。/ A persimmon calyx that turns the orange tile into a persimmon. */
function PersimmonCalyx({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 16 10" width={16} height={10} className={className} aria-hidden>
            <rect x={7.2} y={0} width={1.6} height={3.5} rx={0.8} fill="#3f6b2a" />
            <ellipse cx={4.6} cy={6.2} rx={4.2} ry={1.9} transform="rotate(-14 4.6 6.2)" fill="#4f7f33" />
            <ellipse cx={11.4} cy={6.2} rx={4.2} ry={1.9} transform="rotate(14 11.4 6.2)" fill="#4f7f33" />
            <ellipse cx={8} cy={6.8} rx={2.6} ry={2.4} fill="#3f6b2a" />
        </svg>
    );
}

/** 生日派對帽。/ A birthday party hat. */
function PartyHat({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 12 16" width={12} height={16} className={className} aria-hidden>
            <path d="M6 2.5 11 15H1Z" fill="#fff4e0" stroke="#1f1a17" strokeWidth={0.9} strokeLinejoin="round" />
            <path d="M4.3 6.8 7.7 6.8M3.1 10 8.9 10M1.9 13.2 10.1 13.2" stroke="#e3770e" strokeWidth={1.3} />
            <circle cx={6} cy={2.2} r={1.8} fill="#ffe08a" stroke="#1f1a17" strokeWidth={0.8} />
        </svg>
    );
}

/** Tapi 跳出來的小卡（portal 到 body：logo 在連結裡，卡片裡的按鈕不能放進 <a>）。 */
/** Tapi's card, portalled to body: the mark sits inside a link and a button cannot live in an <a>. */
function FoundCard({ at, onClose }: { at: { left: number; top: number; first: boolean }; onClose: () => void }) {
    const { t } = useI18n();
    useEffect(() => {
        const timer = setTimeout(onClose, CARD_MS);
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        window.addEventListener("keydown", onKey);
        return () => {
            clearTimeout(timer);
            window.removeEventListener("keydown", onKey);
        };
    }, [onClose]);
    return createPortal(
        <div
            role="status"
            // React 的事件會沿著元件樹冒泡：不擋的話會點到外面的連結。/ React events bubble through the portal to the link.
            onClick={(e) => e.stopPropagation()}
            className="fixed z-[60] flex w-64 items-end gap-3 rounded-xl border border-border bg-card p-3 shadow-pop animate-pop-in"
            style={{ left: at.left, top: at.top }}
        >
            <Tapi pose="happy" size={52} className="shrink-0 animate-tapi-bob" />
            <div className="min-w-0 flex-1 pb-0.5">
                <p className="text-sm text-foreground">{t("eggs.found.title")}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("eggs.found.body")}</p>
                {at.first && <p className="mt-1.5 text-xs leading-relaxed text-foreground">{t("eggs.found.unlocked")}</p>}
            </div>
            <button
                type="button"
                onClick={onClose}
                aria-label={t("common.close")}
                className="absolute right-1.5 top-1.5 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
                <X size={14} />
            </button>
        </div>,
        document.body,
    );
}

export function BrandMark({ collapsed = false, className, playful = false }: { collapsed?: boolean; className?: string; playful?: boolean }) {
    const { t } = useI18n();
    const festival = useFestival(playful);
    const tapi = useTapi();
    const tileRef = useRef<HTMLSpanElement | null>(null);
    const clicks = useRef<number[]>([]);
    const [drawing, setDrawing] = useState(0);
    const [card, setCard] = useState<{ left: number; top: number; first: boolean } | null>(null);
    const closeCard = useCallback(() => setCard(null), []);

    const onClick = useCallback(() => {
        if (!playful) return;
        const now = Date.now();
        clicks.current = [...clicks.current.filter((at) => now - at < WINDOW_MS), now];
        if (clicks.current.length < CLICKS) return;
        clicks.current = [];
        setDrawing((n) => n + 1);
        const r = tileRef.current?.getBoundingClientRect();
        // 第一次找到：解鎖「關於 Telepy」裡的「你的 Tapi」（存在帳號上）。/ The first find unlocks "Your Tapi" (on the account).
        const first = !tapi.unlocked;
        if (first) void tapi.save({ tapi_color: "teal" });
        if (r) setCard({ left: Math.max(8, Math.min(r.left, window.innerWidth - 264)), top: r.bottom + 10, first });
    }, [playful, tapi]);

    const title = festival?.kind === "lunarNewYear" ? t("eggs.lunarNewYear") : festival?.kind === "birthday" ? t("eggs.birthday", { age: festival.age }) : undefined;

    return (
        <span className={cn("flex items-center gap-2.5 min-w-0", className)}>
            <span ref={tileRef} onClick={onClick} title={title} className="relative grid place-items-center size-8 rounded-lg bg-brand-gradient shrink-0">
                {drawing > 0 ? <TelepyGlyphDrawing key={drawing} size={18} className="text-white" /> : <TelepyGlyph size={18} className="text-white" />}
                {festival?.kind === "lunarNewYear" && <PersimmonCalyx className="pointer-events-none absolute -top-[7px] left-1/2 -translate-x-1/2" />}
                {festival?.kind === "birthday" && <PartyHat className="pointer-events-none absolute -right-1.5 -top-3 rotate-[18deg]" />}
            </span>
            {!collapsed && (
                <span className="flex flex-col min-w-0 leading-none">
                    <span className="text-base tracking-tight text-foreground truncate">Telepy</span>
                    <span className="mt-0.5 text-[0.75rem] text-muted-foreground truncate">Reverse SSH</span>
                </span>
            )}
            {card && <FoundCard at={card} onClose={closeCard} />}
        </span>
    );
}
