/**
 * 虛擬鍵盤修飾鍵狀態機：Ctrl / Alt / Shift 三態（off / armed / locked），
 * 並提供 emit 系列函式把按鍵透過 terminalKeymap 編碼後送出。
 * Virtual-keyboard modifier state machine (three-state) + emit helpers.
 *
 * 修飾鍵行為（對齊 Termux / Blink）：
 *   off --tap--> armed --快速再點--> locked --tap--> off
 *   armed 在打出一個一般鍵後自動清除；locked 會保持直到再次點按。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { encodeChar, encodeSeq, type SeqName } from "@/lib/terminalKeymap";

export type ModState = "off" | "armed" | "locked";
export type ModName = "ctrl" | "alt" | "shift";

/** 手機鍵盤模式：accessory=原生鍵盤+特殊鍵列；full=完整自訂鍵盤；hidden=收起。 */
export type KeyboardMode = "accessory" | "full" | "hidden";

export interface ModifierState {
    ctrl: ModState;
    alt: ModState;
    shift: ModState;
}

const DOUBLE_TAP_MS = 350;

const INITIAL: ModifierState = { ctrl: "off", alt: "off", shift: "off" };

export function useKeyboardController(onInput: (data: string) => void) {
    const [mods, setMods] = useState<ModifierState>(INITIAL);
    const lastPress = useRef<Record<ModName, number>>({ ctrl: 0, alt: 0, shift: 0 });

    const press = useCallback((name: ModName) => {
        const now = Date.now();
        const withinDoubleTap = now - lastPress.current[name] < DOUBLE_TAP_MS;
        lastPress.current[name] = now;
        setMods((prev) => {
            const cur = prev[name];
            let next: ModState;
            if (cur === "off") next = "armed";
            else if (cur === "armed") next = withinDoubleTap ? "locked" : "off";
            else next = "off"; // locked -> off
            return { ...prev, [name]: next };
        });
    }, []);

    // 打出一般鍵後，清掉處於 armed（一次性）的修飾鍵；locked 保留。
    const consumeArmed = useCallback(() => {
        setMods((prev) => ({
            ctrl: prev.ctrl === "armed" ? "off" : prev.ctrl,
            alt: prev.alt === "armed" ? "off" : prev.alt,
            shift: prev.shift === "armed" ? "off" : prev.shift,
        }));
    }, []);

    const clearAll = useCallback(() => setMods(INITIAL), []);

    // 送出一個「可見字元」（UI 已依 shift/sym 決定好最終字元），套用 Ctrl / Alt 後送出。
    const emitChar = useCallback((char: string) => {
        onInput(encodeChar(char, { ctrl: mods.ctrl !== "off", alt: mods.alt !== "off" }));
        consumeArmed();
    }, [mods.ctrl, mods.alt, onInput, consumeArmed]);

    // 送出一個「命名特殊鍵」（方向、功能鍵、Esc、Tab…）。
    const emitSeq = useCallback((name: SeqName) => {
        onInput(encodeSeq(name, { ctrl: mods.ctrl !== "off", alt: mods.alt !== "off" }));
        consumeArmed();
    }, [mods.ctrl, mods.alt, onInput, consumeArmed]);

    // 直接送出原始字串（貼上等），不套用修飾鍵。
    const emitRaw = useCallback((data: string) => {
        if (data) onInput(data);
    }, [onInput]);

    return useMemo(() => ({
        mods,
        active: {
            ctrl: mods.ctrl !== "off",
            alt: mods.alt !== "off",
            shift: mods.shift !== "off",
        },
        press,
        emitChar,
        emitSeq,
        emitRaw,
        clearAll,
    }), [mods, press, emitChar, emitSeq, emitRaw, clearAll]);
}

export type KeyboardController = ReturnType<typeof useKeyboardController>;
