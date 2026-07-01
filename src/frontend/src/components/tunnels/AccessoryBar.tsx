/**
 * 模式 A：特殊鍵列（accessory bar）。浮在手機原生鍵盤上方，只補原生鍵盤沒有的鍵：
 * Esc / Tab / Ctrl / Alt / 方向 / Home-End / PgUp-Dn / Del / 常用符號 / F 鍵 / 貼上。
 * 原生鍵盤負責打字（含中文、滑動輸入、自動完成），本列不搶焦點（onPointerDown + preventDefault）。
 */
import React, { useState } from "react";
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, ClipboardPaste, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { KeyboardController } from "@/hooks/useKeyboardController";
import type { ModState } from "@/hooks/useKeyboardController";
import type { SeqName } from "@/lib/terminalKeymap";

function triggerHaptic() {
    navigator.vibrate?.(10);
}

const KEY_BASE =
    "shrink-0 h-9 min-w-9 px-2.5 rounded-md text-[13px] font-medium select-none " +
    "flex items-center justify-center transition-all duration-75 active:scale-[0.94] active:opacity-90 " +
    "shadow-[0_1px_1px_rgba(0,0,0,0.4)]";

// 隱藏橫向捲軸（Tailwind 無內建 no-scrollbar）。
const SCROLL_HIDE = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

function modClass(state: ModState): string {
    if (state === "locked") return "bg-primary text-primary-foreground ring-2 ring-primary-foreground/60";
    if (state === "armed") return "bg-primary/80 text-primary-foreground";
    return "bg-secondary text-secondary-foreground active:bg-secondary/80";
}

interface AccessoryBarProps {
    controller: KeyboardController;
}

export function AccessoryBar({ controller }: AccessoryBarProps) {
    const [showFn, setShowFn] = useState(false);
    const { mods, active, press, emitSeq, emitChar, emitRaw } = controller;

    const fire = (fn: () => void) => (e: React.PointerEvent) => {
        e.preventDefault();
        triggerHaptic();
        fn();
    };

    // 元素工廠（非元件）：避免在 render 中宣告元件。
    const seqKey = (name: SeqName, label: string, children: React.ReactNode) => (
        <button key={name} aria-label={label} className={cn(KEY_BASE, "bg-secondary text-secondary-foreground active:bg-secondary/80")}
            onPointerDown={fire(() => emitSeq(name))}>
            {children}
        </button>
    );

    const charKey = (char: string) => (
        <button key={char} aria-label={`Key ${char}`} className={cn(KEY_BASE, "bg-secondary text-secondary-foreground active:bg-secondary/80 font-mono")}
            onPointerDown={fire(() => emitChar(char))}>
            {char}
        </button>
    );

    const paste = async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text) emitRaw(text);
        } catch { /* 剪貼簿權限不足時忽略 */ }
    };

    const fnKeys: SeqName[] = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12"];

    return (
        <div className="w-full bg-background">
            {/* F 鍵抽屜（可展開） */}
            {showFn && (
                <div className={cn("flex gap-1 overflow-x-auto px-2 py-1.5 border-b border-border/60", SCROLL_HIDE)}
                    style={{ touchAction: "pan-x" }}>
                    {fnKeys.map((f) => (
                        <button key={f} aria-label={f.toUpperCase()}
                            className={cn(KEY_BASE, "bg-secondary text-secondary-foreground active:bg-secondary/80 uppercase")}
                            onPointerDown={fire(() => emitSeq(f))}>
                            {f}
                        </button>
                    ))}
                </div>
            )}

            {/* 主特殊鍵列（橫向可捲） */}
            <div className={cn("flex gap-1 overflow-x-auto px-2 py-1.5 items-center", SCROLL_HIDE)}
                style={{ touchAction: "pan-x" }}>
                <button aria-label="Escape" className={cn(KEY_BASE, "bg-secondary text-secondary-foreground active:bg-secondary/80 font-semibold")}
                    onPointerDown={fire(() => emitSeq("esc"))}>Esc</button>
                <button aria-label="Tab" className={cn(KEY_BASE, "bg-secondary text-secondary-foreground active:bg-secondary/80 font-semibold")}
                    onPointerDown={fire(() => emitSeq("tab"))}>Tab</button>

                <span className="shrink-0 w-px h-6 bg-border/70 mx-0.5" />

                <button aria-label="Control" aria-pressed={active.ctrl} className={cn(KEY_BASE, "font-semibold", modClass(mods.ctrl))}
                    onPointerDown={fire(() => press("ctrl"))}>Ctrl</button>
                <button aria-label="Alt" aria-pressed={active.alt} className={cn(KEY_BASE, "font-semibold", modClass(mods.alt))}
                    onPointerDown={fire(() => press("alt"))}>Alt</button>

                <span className="shrink-0 w-px h-6 bg-border/70 mx-0.5" />

                {seqKey("left", "Left", <ArrowLeft size={16} />)}
                {seqKey("up", "Up", <ArrowUp size={16} />)}
                {seqKey("down", "Down", <ArrowDown size={16} />)}
                {seqKey("right", "Right", <ArrowRight size={16} />)}

                <span className="shrink-0 w-px h-6 bg-border/70 mx-0.5" />

                {seqKey("home", "Home", "Home")}
                {seqKey("end", "End", "End")}
                {seqKey("pageUp", "Page Up", "PgUp")}
                {seqKey("pageDown", "Page Down", "PgDn")}
                {seqKey("delete", "Delete", "Del")}

                <span className="shrink-0 w-px h-6 bg-border/70 mx-0.5" />

                {charKey("/")}
                {charKey("-")}
                {charKey("|")}
                {charKey("~")}
                {charKey(":")}
                {charKey("_")}

                <span className="shrink-0 w-px h-6 bg-border/70 mx-0.5" />

                <button aria-label="Function keys" aria-pressed={showFn}
                    className={cn(KEY_BASE, "font-semibold", showFn ? "bg-primary/80 text-primary-foreground" : "bg-secondary text-secondary-foreground active:bg-secondary/80")}
                    onPointerDown={(e) => { e.preventDefault(); triggerHaptic(); setShowFn((v) => !v); }}>
                    <span className="flex items-center gap-0.5">F<ChevronUp size={13} className={cn("transition-transform", showFn ? "" : "rotate-180")} /></span>
                </button>
                <button aria-label="Paste" className={cn(KEY_BASE, "bg-secondary text-secondary-foreground active:bg-secondary/80")}
                    onPointerDown={(e) => { e.preventDefault(); triggerHaptic(); paste(); }}>
                    <ClipboardPaste size={16} />
                </button>
            </div>
        </div>
    );
}
