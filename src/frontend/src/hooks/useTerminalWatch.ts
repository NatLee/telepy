/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 看別人的網頁終端機：`/ws/terminal-watch/{shell}/`。第一個 binary frame 給大小與狀態（建 xterm），接著一個 text frame
 * 是現在的畫面，之後是即時輸出。xterm 照那個 session 的大小（不跟著這個視窗縮放）；有控制權時按鍵才送出去。
 * 敏感隧道（4008）先確認是你再連；其他關閉就停在說明，不自己重連（人家的 session 結束了就是結束了）。
 * Watching a web terminal: the first binary frame carries the size and state (the xterm is built then), the next
 * text frame is the current screen, then live output. The xterm keeps the session's size; keys go out only with
 * control. A sensitive tunnel (4008) asks for a step-up and reconnects; any other close stays closed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getWsOrigin } from "@/lib/websocket";
import { requestStepUp, STEP_UP_CLOSE_CODE, stepUpToken } from "@/lib/stepUp";
import { loadXtermDeps, waitForFont, xtermLookOptions, applyLigatures } from "@/lib/xterm";
import { useTerminalAppearance } from "@/hooks/useTerminalAppearance";
import { controlState, parseWatchEvent, type WatchersFrame, type WatchStart } from "@/lib/terminalWatch";

export interface WatchClose {
    code: number;
    reason: string;
}

export function useTerminalWatch(shellId: string | null) {
    const [start, setStart] = useState<WatchStart | null>(null);
    const [watchers, setWatchers] = useState<WatchersFrame | null>(null);
    const [detached, setDetached] = useState(false);
    const [open, setOpen] = useState(false);
    const [closed, setClosed] = useState<WatchClose | null>(null);
    const [command, setCommand] = useState<{ state: string; command?: string } | null>(null);
    const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
    const [attempt, setAttempt] = useState(0);
    const appearance = useTerminalAppearance(start ? String(start.tunnel.id) : null);
    const lookRef = useRef(appearance.resolved);
    useEffect(() => { lookRef.current = appearance.resolved; }, [appearance.resolved]);

    const hostRef = useRef<HTMLDivElement | null>(null);
    const termRef = useRef<any>(null);
    const wsRef = useRef<WebSocket | null>(null);
    /** 建 xterm 之前收到的輸出。/ Output received before the xterm exists. */
    const queueRef = useRef<string[]>([]);
    const controlRef = useRef(false);

    const send = useCallback((v: unknown) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(v));
    }, []);

    useEffect(() => {
        if (!shellId) return;
        let disposed = false;
        let creating = false;
        const ws = new WebSocket(`${getWsOrigin()}/ws/terminal-watch/${encodeURIComponent(shellId)}/`);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;

        const write = (text: string) => {
            if (termRef.current) termRef.current.write(text);
            else queueRef.current.push(text);
        };

        const ensureTerm = async (s: WatchStart) => {
            if (termRef.current) {
                if (s.reset) termRef.current.reset();
                termRef.current.resize(s.size.cols, s.size.rows);
                return;
            }
            if (creating) return;
            creating = true;
            const look = lookRef.current;
            const [{ Terminal }] = await Promise.all([loadXtermDeps(), waitForFont(look.font, look.bold !== "bright")]);
            if (disposed || !hostRef.current) return;
            const term = new Terminal({ cols: s.size.cols, rows: s.size.rows, cursorBlink: false, scrollback: 2000, ...xtermLookOptions(look) });
            term.open(hostRef.current);
            applyLigatures(term, look.ligatures);
            // 只有拿到控制權時按鍵才送出去。/ Keys go out only while you have control.
            term.onData((data: string) => {
                if (controlRef.current) send({ action: "pty_input", payload: { input: data } });
            });
            termRef.current = term;
            for (const chunk of queueRef.current.splice(0)) term.write(chunk);
        };

        ws.onopen = () => {
            ws.send(JSON.stringify({ type: "auth", token: localStorage.getItem("accessToken"), step_up: stepUpToken() ?? undefined }));
        };
        ws.onmessage = (event) => {
            if (disposed) return;
            if (typeof event.data === "string") {
                write(event.data);
                return;
            }
            const ev = parseWatchEvent(new TextDecoder().decode(event.data as ArrayBuffer));
            if (!ev) return;
            switch (ev.type) {
                case "watch":
                    setStart(ev);
                    setWatchers(ev.watchers);
                    setDetached(ev.detached);
                    setSize(ev.size);
                    setOpen(true);
                    if (ev.reset) queueRef.current = [];
                    void ensureTerm(ev);
                    break;
                case "watchers":
                    setWatchers(ev);
                    break;
                case "resize":
                    setSize({ cols: ev.cols, rows: ev.rows });
                    try { termRef.current?.resize(ev.cols, ev.rows); } catch { /* noop */ }
                    break;
                case "detached":
                    setDetached(ev.detached);
                    break;
                case "command":
                    setCommand(ev.state === "pending" ? ev : null);
                    break;
            }
        };
        ws.onclose = (event) => {
            if (disposed) return;
            setOpen(false);
            if (event.code === STEP_UP_CLOSE_CODE) {
                requestStepUp().then((ok) => {
                    if (!disposed && ok) setAttempt((n) => n + 1);
                    else if (!disposed) setClosed({ code: event.code, reason: event.reason });
                });
                return;
            }
            setClosed({ code: event.code, reason: event.reason });
        };
        return () => {
            disposed = true;
            ws.onclose = null;
            ws.onmessage = null;
            try { ws.close(); } catch { /* noop */ }
            wsRef.current = null;
            try { termRef.current?.dispose(); } catch { /* noop */ }
            termRef.current = null;
            queueRef.current = [];
        };
    }, [shellId, attempt, send]);

    const control = controlState(watchers, start?.you ?? null);
    useEffect(() => {
        controlRef.current = control === "granted";
        if (control === "granted") {
            try { termRef.current?.focus(); } catch { /* noop */ }
        }
    }, [control]);

    const reconnect = useCallback(() => {
        setClosed(null);
        setStart(null);
        setWatchers(null);
        setAttempt((n) => n + 1);
    }, []);

    return {
        hostRef,
        start,
        watchers,
        detached,
        open,
        closed,
        command,
        size,
        control,
        look: appearance.resolved,
        actions: {
            request: () => send({ type: "control", want: true }),
            release: () => send({ type: "control", want: false }),
            force: () => send({ type: "control", force: true }),
            reconnect,
        },
    };
}
