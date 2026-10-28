"use client";

/**
 * 推動打字機（lib/typewriter.ts 的純函式）：每一步排一個 setTimeout。句子或被釘住的那句一變，就在 render 時
 * 接著打（React 允許的「依 props 調整 state」寫法），所以畫面不會先閃一下舊的字。`enabled` = false（減少動態）
 * 時直接整句顯示、沒有游標。
 * Drives the typewriter (pure helpers in lib/typewriter.ts) with one setTimeout per step. When the lines or the
 * pinned line change, the state is adjusted during render (React's "adjust state on prop change" pattern), so the old
 * text never flashes. With `enabled` false (reduced motion) the whole line shows at once, without a caret.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { START, TIMING, caretMode, graphemes, reconcile, shownText, step, type CaretMode, type TypeState } from "@/lib/typewriter";

export function useTypewriter(lines: string[], pin: number | null, enabled: boolean): { text: string; caret: CaretMode | null } {
    const key = lines.join("\n");
    const split = useMemo(() => (key ? key.split("\n") : []).map(graphemes), [key]);
    const [state, setState] = useState<TypeState>(() => (pin !== null && pin < split.length ? { ...START, line: pin } : START));
    const [seen, setSeen] = useState({ split, pin });
    if (seen.split !== split || seen.pin !== pin) {
        setSeen({ split, pin });
        setState((s) => reconcile(s, seen.split, split, pin));
    }

    const loop = pin === null && split.length > 1;
    const first = useRef(true);
    useEffect(() => {
        if (!enabled) return;
        const next = step(state, split, loop);
        if (!next) return;
        const delay = first.current ? Math.max(TIMING.start, next.delay) : next.delay;
        const id = setTimeout(() => {
            first.current = false;
            setState(next.next);
        }, delay);
        return () => clearTimeout(id);
    }, [state, split, loop, enabled]);

    if (!enabled) return { text: lines[pin ?? 0] ?? "", caret: null };
    return { text: shownText(split[state.line] ?? [], state.shown), caret: caretMode(state.phase, pin !== null) };
}
