"use client";

/**
 * 內嵌的區網主機終端機：一個 xterm + 一條 `/ws/terminal/` 連線（auth 帶 `lan_host_id` / `lan_username`，
 * `username` 是裝置那一跳）。協定、關閉碼與終端機頁相同；隱藏時保留狀態，顯示時重新 fit。
 * An embedded LAN-host terminal: one xterm and one `/ws/terminal/` socket. Same protocol and close codes as
 * the terminal page; hidden sessions keep their state and refit when shown.
 * 外觀(字型 / 字級 / 配色)跟終端機頁一樣:個人預設 + 這台裝置(隧道)的覆寫,改了即時套用。
 * Appearance follows the terminal page: personal default + this device's (tunnel's) override, applied live.
 */
import React, { useCallback, useEffect, useRef } from "react";
import "xterm/css/xterm.css";
import { refreshAccessToken } from "@/lib/api";
import { getWsOrigin } from "@/lib/websocket";
import { loadXtermDeps, resolveCssVar, waitForFont } from "@/lib/xterm";
import { terminalFontFamily } from "@/lib/terminalAppearance";
import { useLiveTerminalLook, useTerminalAppearance } from "@/hooks/useTerminalAppearance";
import { translate } from "@/lib/translate";
import type { TranslationKey } from "@/locales/en";
import type { LanTerminalSession, LanTerminalStatus } from "@/hooks/useLanTerminals";

/** 關閉碼 → 寫進終端機的說明。/ Close code → the line written into the terminal. */
const CLOSE_MESSAGES: Record<number, TranslationKey> = {
    4002: "terminal.notFoundXterm",
    4003: "terminal.lanLoginInvalidXterm",
    4004: "terminal.lanHostMissingXterm",
    4006: "terminal.noUsersXterm",
    1000: "terminal.disconnectedXterm",
};

interface Props {
    session: LanTerminalSession;
    visible: boolean;
    onStatus: (key: number, status: LanTerminalStatus) => void;
}

export function LanTerminal({ session, visible, onStatus }: Props) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const termRef = useRef<{ term: any; fit: any } | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const { key, tunnelId, hostId, login, deviceUser, attempt } = session;
    const { resolved } = useTerminalAppearance(String(tunnelId));
    // xterm 是 async 建的,要讀建立當下最新的外觀。/ The xterm is created asynchronously; read the latest look.
    const resolvedRef = useRef(resolved);
    useEffect(() => { resolvedRef.current = resolved; }, [resolved]);

    const sendResize = useCallback(() => {
        const x = termRef.current;
        const ws = wsRef.current;
        if (!x) return;
        try { x.fit.fit(); } catch { /* not laid out yet */ }
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: "pty_resize", payload: { size: { rows: x.term.rows, cols: x.term.cols, height: x.term.rows * 20, width: x.term.cols * 9 } } }));
        }
    }, []);

    // 外觀變更即時套用。/ Apply appearance changes live.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const forEachTerm = useCallback((fn: (term: any) => void) => {
        if (termRef.current) fn(termRef.current.term);
    }, []);
    useLiveTerminalLook(resolved, forEachTerm, sendResize);

    // xterm 一個 session 只建一次。/ One xterm per session.
    useEffect(() => {
        let disposed = false;
        let cleanup = () => {};
        (async () => {
            const [{ Terminal, FitAddon }] = await Promise.all([loadXtermDeps(), waitForFont(resolvedRef.current.font)]);
            if (disposed || !hostRef.current) return;
            const look = resolvedRef.current;
            const term = new Terminal({
                cursorBlink: true,
                theme: look.scheme.theme,
                fontFamily: terminalFontFamily(look.font, resolveCssVar),
                fontSize: look.fontSize,
                lineHeight: 1.2,
            });
            const fit = new FitAddon();
            term.loadAddon(fit);
            term.open(hostRef.current);
            termRef.current = { term, fit };
            term.onData((data: string) => {
                const ws = wsRef.current;
                if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: "pty_input", payload: { input: data } }));
            });
            const ro = new ResizeObserver(() => sendResize());
            ro.observe(hostRef.current);
            cleanup = () => {
                ro.disconnect();
                try { term.dispose(); } catch { /* noop */ }
                termRef.current = null;
            };
            requestAnimationFrame(sendResize);
        })();
        return () => {
            disposed = true;
            cleanup();
        };
    }, [sendResize]);

    // 連線（attempt 變了就重連）。/ (Re)connect whenever `attempt` changes.
    useEffect(() => {
        let closedByUs = false;
        let authRetried = false;
        let ping: ReturnType<typeof setInterval> | null = null;
        let waitTerm: ReturnType<typeof setInterval> | null = null;

        const write = (line: string) => termRef.current?.term.write(line);
        const connect = () => {
            const ws = new WebSocket(`${getWsOrigin()}/ws/terminal/`);
            ws.binaryType = "arraybuffer";
            wsRef.current = ws;
            ws.onopen = () => {
                ws.send(JSON.stringify({
                    type: "auth",
                    token: localStorage.getItem("accessToken"),
                    server_id: String(tunnelId),
                    username: deviceUser,
                    lan_host_id: String(hostId),
                    ...(login ? { lan_username: login } : {}),
                }));
                write(`\x1b[90m${translate("terminal.connectingToServer")}\x1b[0m\r\n`);
                onStatus(key, "connected");
                sendResize();
                ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ action: "ping" })), 5000);
            };
            ws.onmessage = (ev) => {
                // 二進位 frame 是 pong。/ Binary frames are pongs.
                if (typeof ev.data === "string") {
                    authRetried = false;
                    write(ev.data);
                }
            };
            ws.onclose = (ev) => {
                if (ping) clearInterval(ping);
                if (wsRef.current === ws) wsRef.current = null;
                if (closedByUs) return;
                if (ev.code === 4001 && !authRetried) {
                    authRetried = true;
                    refreshAccessToken().then((ok) => {
                        if (closedByUs) return;
                        if (ok) connect();
                        else {
                            write(`\r\n\x1b[31m${translate("terminal.authFailedXterm")}\x1b[0m\r\n`);
                            onStatus(key, "closed");
                        }
                    });
                    return;
                }
                const msg = ev.code === 4001 ? "terminal.authFailedXterm" : CLOSE_MESSAGES[ev.code];
                write(`\r\n\x1b[31m${msg ? translate(msg) : translate("terminal.disconnectedCodeXterm", { code: ev.code })}\x1b[0m\r\n`);
                onStatus(key, "closed");
            };
        };

        // 等 xterm 建好再連（第一次掛載時是非同步的）。/ Wait for the xterm before connecting.
        if (termRef.current) connect();
        else waitTerm = setInterval(() => {
            if (termRef.current) {
                if (waitTerm) clearInterval(waitTerm);
                waitTerm = null;
                connect();
            }
        }, 50);

        return () => {
            closedByUs = true;
            if (waitTerm) clearInterval(waitTerm);
            if (ping) clearInterval(ping);
            // 關掉 WS = 後端結束那個 shell。/ Closing the socket ends the shell on the server.
            try { wsRef.current?.close(); } catch { /* noop */ }
            wsRef.current = null;
        };
    }, [attempt, key, tunnelId, hostId, login, deviceUser, onStatus, sendResize]);

    // 顯示時 fit + 聚焦（桌機）。/ Refit (and focus on desktop) when shown.
    useEffect(() => {
        if (!visible) return;
        requestAnimationFrame(() => {
            sendResize();
            if (window.innerWidth >= 768) termRef.current?.term.focus();
        });
    }, [visible, sendResize]);

    // 外框跟著配色的背景色(淺色配色不會留一圈黑邊)。/ The padding follows the scheme background (no black ring on light schemes).
    return <div ref={hostRef} className="absolute inset-0 p-1.5" style={{ display: visible ? "block" : "none", background: resolved.scheme.theme.background }} />;
}
