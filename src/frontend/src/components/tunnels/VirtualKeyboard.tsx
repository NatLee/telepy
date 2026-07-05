/**
 * 模式 B：完整自訂虛擬鍵盤（QWERTY）。只負責鍵盤面板內容，定位/可見性由 MobileKeyboard 管理。
 * 修飾鍵（Ctrl / Alt / Shift）與送出邏輯共用 useKeyboardController；Sym 為純顯示層的符號切換。
 */
import React, { useState } from "react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { KeyboardController, ModState } from "@/hooks/useKeyboardController";

function triggerHaptic() {
    navigator.vibrate?.(10);
}

function modClass(state: ModState): string {
    if (state === "locked") return "bg-primary text-primary-foreground ring-2 ring-primary-foreground/60";
    if (state === "armed") return "bg-primary/80 text-primary-foreground";
    return "bg-secondary active:bg-secondary/80 text-secondary-foreground";
}

interface VirtualKeyboardProps {
    controller: KeyboardController;
    isExpanded?: boolean;
    onToggleExpand?: () => void;
}

export function VirtualKeyboard({ controller, isExpanded = true, onToggleExpand }: VirtualKeyboardProps) {
    const { t } = useI18n();
    const [isSym, setIsSym] = useState(false);
    const { mods, active, press, emitChar, emitSeq } = controller;

    const handleChar = (char: string) => {
        triggerHaptic();
        emitChar(char);
    };

    const handleSeq = (fn: () => void) => (e: React.PointerEvent) => {
        e.preventDefault();
        triggerHaptic();
        fn();
    };

    const renderKey = (normal: string, shifted: string, sym: string, widthClass = "flex-1") => {
        let display = normal;
        let output = normal;
        if (isSym) {
            display = sym; output = sym;
        } else if (active.shift) {
            display = shifted; output = shifted;
        }

        if (!display) {
            return <div className={cn("m-0.5", widthClass)} style={{ visibility: "hidden" }} />;
        }

        return (
            <button
                aria-label={t("kbd.keyChar", { char: display })}
                className={cn(
                    "h-9 px-0 min-w-0 bg-secondary active:bg-secondary/80 active:scale-[0.95] active:opacity-90 text-secondary-foreground",
                    "rounded shadow-[0_1px_1px_rgba(0,0,0,0.5)] select-none flex items-center justify-center m-0.5 text-[17px] transition-all duration-75 font-sans",
                    widthClass
                )}
                onPointerDown={(e) => { e.preventDefault(); handleChar(output); }}
            >
                {display}
            </button>
        );
    };

    return (
        <div className="p-1.5 pb-2 w-full flex flex-col max-w-[100vw]">
            {/* 展開/收合 QWERTY 的把手 */}
            {onToggleExpand && (
                <div className="flex justify-center w-full mb-1.5">
                    <button
                        onPointerDown={(e) => { e.preventDefault(); triggerHaptic(); onToggleExpand(); }}
                        className="bg-muted border border-border w-16 h-1.5 rounded-full shadow-inner active:bg-muted/80 active:scale-[0.95] transition-colors"
                        aria-label={isExpanded ? t("kbd.collapseRows") : t("kbd.expandRows")}
                    />
                </div>
            )}

            {/* 常駐列：修飾鍵 + 方向鍵 */}
            <div className="flex w-full justify-between items-center mb-1 gap-1 px-0.5">
                <div className="flex gap-1 flex-1 bg-muted/50 p-1 rounded-lg shadow-inner">
                    <button aria-label={t("kbd.controlKey")} aria-pressed={active.ctrl}
                        className={cn("h-8 flex-1 rounded text-xs font-bold select-none transition-all duration-75 active:scale-[0.95] active:opacity-90", modClass(mods.ctrl))}
                        onPointerDown={handleSeq(() => press("ctrl"))}>CTRL</button>
                    <button aria-label={t("kbd.altKey")} aria-pressed={active.alt}
                        className={cn("h-8 flex-1 rounded text-xs font-bold select-none transition-all duration-75 active:scale-[0.95] active:opacity-90", modClass(mods.alt))}
                        onPointerDown={handleSeq(() => press("alt"))}>ALT</button>
                    <button aria-label={t("kbd.escapeKey")}
                        className="h-8 flex-1 rounded text-xs font-bold select-none bg-secondary active:bg-secondary/80 active:scale-[0.95] active:opacity-90 transition-all duration-75 text-secondary-foreground"
                        onPointerDown={handleSeq(() => emitSeq("esc"))}>ESC</button>
                    <button aria-label={t("kbd.tabKey")}
                        className="h-8 flex-1 rounded text-xs font-bold select-none bg-secondary active:bg-secondary/80 active:scale-[0.95] active:opacity-90 transition-all duration-75 text-secondary-foreground"
                        onPointerDown={handleSeq(() => emitSeq("tab"))}>TAB</button>
                </div>
                <div className="flex gap-1 flex-1 bg-muted/50 p-1 rounded-lg justify-center shadow-inner">
                    <button aria-label={t("kbd.upArrow")} className="h-8 flex-1 rounded font-bold select-none bg-secondary active:bg-secondary/80 active:scale-[0.95] active:opacity-90 transition-all duration-75 text-secondary-foreground" onPointerDown={handleSeq(() => emitSeq("up"))}>↑</button>
                    <button aria-label={t("kbd.downArrow")} className="h-8 flex-1 rounded font-bold select-none bg-secondary active:bg-secondary/80 active:scale-[0.95] active:opacity-90 transition-all duration-75 text-secondary-foreground" onPointerDown={handleSeq(() => emitSeq("down"))}>↓</button>
                    <button aria-label={t("kbd.leftArrow")} className="h-8 flex-1 rounded font-bold select-none bg-secondary active:bg-secondary/80 active:scale-[0.95] active:opacity-90 transition-all duration-75 text-secondary-foreground" onPointerDown={handleSeq(() => emitSeq("left"))}>←</button>
                    <button aria-label={t("kbd.rightArrow")} className="h-8 flex-1 rounded font-bold select-none bg-secondary active:bg-secondary/80 active:scale-[0.95] active:opacity-90 transition-all duration-75 text-secondary-foreground" onPointerDown={handleSeq(() => emitSeq("right"))}>→</button>
                </div>
            </div>

            {/* QWERTY（可展開/收合） */}
            <div className={cn("grid transition-all duration-300 ease-in-out", isExpanded ? "grid-rows-[1fr] opacity-100 mt-1" : "grid-rows-[0fr] opacity-0 mt-0 pointer-events-none")}>
                <div className="flex flex-col gap-1 overflow-hidden min-h-0">
                    <div className="flex w-full">
                        {renderKey("1", "!", "1")} {renderKey("2", "@", "2")} {renderKey("3", "#", "3")} {renderKey("4", "$", "4")} {renderKey("5", "%", "5")} {renderKey("6", "^", "6")} {renderKey("7", "&", "7")} {renderKey("8", "*", "8")} {renderKey("9", "(", "9")} {renderKey("0", ")", "0")}
                    </div>
                    <div className="flex w-full">
                        {renderKey("q", "Q", "-")} {renderKey("w", "W", "/")} {renderKey("e", "E", ":")} {renderKey("r", "R", ";")} {renderKey("t", "T", "(")} {renderKey("y", "Y", ")")} {renderKey("u", "U", "$")} {renderKey("i", "I", "&")} {renderKey("o", "O", "@")} {renderKey("p", "P", '"')}
                    </div>
                    <div className="flex w-full px-[4%]">
                        {renderKey("a", "A", "[")} {renderKey("s", "S", "]")} {renderKey("d", "D", "{")} {renderKey("f", "F", "}")} {renderKey("g", "G", "#")} {renderKey("h", "H", "%")} {renderKey("j", "J", "^")} {renderKey("k", "K", "*")} {renderKey("l", "L", "+")}
                    </div>
                    <div className="flex w-full">
                        <button aria-label={t("kbd.shiftKey")} aria-pressed={active.shift}
                            className={cn("h-9 px-0 flex-[1.2] rounded text-lg font-medium select-none m-0.5 shadow-[0_1px_1px_rgba(0,0,0,0.5)] flex items-center justify-center transition-all duration-75 active:scale-[0.95] active:opacity-90", modClass(mods.shift))}
                            onPointerDown={handleSeq(() => press("shift"))}>⇧</button>
                        {renderKey("z", "Z", "_")} {renderKey("x", "X", "=")} {renderKey("c", "C", "|")} {renderKey("v", "V", "~")} {renderKey("b", "B", "\\")} {renderKey("n", "N", "?")} {renderKey("m", "M", "!")} {renderKey(",", "<", ",")} {renderKey(".", ">", ".")}
                        <button aria-label={t("kbd.backspaceKey")} className="h-9 px-0 flex-[1.2] rounded text-lg font-medium select-none bg-secondary active:bg-secondary/80 active:scale-[0.95] active:opacity-90 transition-all duration-75 text-secondary-foreground m-0.5 shadow-[0_1px_1px_rgba(0,0,0,0.5)] flex items-center justify-center" onPointerDown={handleSeq(() => emitSeq("backspace"))}>⌫</button>
                    </div>
                    <div className="flex w-full">
                        <button aria-label={t("kbd.symbolKeyboard")} aria-pressed={isSym}
                            className={cn("h-9 px-0 flex-[1.5] rounded text-sm font-bold select-none m-0.5 shadow-[0_1px_1px_rgba(0,0,0,0.5)] transition-all duration-75 active:scale-[0.95] active:opacity-90", isSym ? "bg-primary text-primary-foreground" : "bg-secondary active:bg-secondary/80 text-secondary-foreground")}
                            onPointerDown={(e) => { e.preventDefault(); triggerHaptic(); setIsSym((v) => !v); }}>#+=</button>
                        <button aria-label={t("kbd.spaceKey")} className="h-9 px-0 flex-grow-[4] rounded text-lg select-none bg-secondary active:bg-secondary/80 active:scale-[0.95] active:opacity-90 transition-all duration-75 text-secondary-foreground m-0.5 shadow-[0_1px_1px_rgba(0,0,0,0.5)]" onPointerDown={handleSeq(() => emitChar(" "))}>{t("kbd.space")}</button>
                        <button aria-label={t("kbd.returnKey")} className="h-9 px-0 flex-[1.5] rounded text-sm font-bold select-none bg-primary hover:bg-primary/90 active:bg-primary/80 active:scale-[0.95] active:opacity-90 transition-all duration-75 text-primary-foreground m-0.5 shadow-[0_1px_1px_rgba(0,0,0,0.5)]" onPointerDown={handleSeq(() => emitSeq("enter"))}>{t("kbd.return")}</button>
                    </div>
                </div>
            </div>
        </div>
    );
}
