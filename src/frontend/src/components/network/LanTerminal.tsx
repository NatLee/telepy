"use client";

/**
 * 內嵌的區網主機終端機：一個 xterm + 一條 `/ws/terminal/` 連線（auth 帶 `lan_host_id` / `lan_username`，
 * `username` 是裝置那一跳）。協定、關閉碼與終端機頁相同；隱藏時保留狀態，顯示時重新 fit。
 * An embedded LAN-host terminal: one xterm and one `/ws/terminal/` socket. Same protocol and close codes as
 * the terminal page; hidden sessions keep their state and refit when shown.
 * 外觀(字型 / 字級 / 配色)跟終端機頁一樣:個人預設 + 這台裝置(隧道)的覆寫,改了即時套用。
 * Appearance follows the terminal page: personal default + this device's (tunnel's) override, applied live.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Wrench } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { ToolboxPanel } from "@/components/toolbox/ToolboxPanel";
import { useI18n } from "@/lib/i18n";
import type { ToolboxTarget } from "@/lib/snippets";
import "xterm/css/xterm.css";
import { refreshAccessToken } from "@/lib/api";
import { getWsOrigin } from "@/lib/websocket";
import { applyLigatures, loadXtermDeps, waitForFont, xtermLookOptions } from "@/lib/xterm";
import { useLiveTerminalLook, useTerminalAppearance } from "@/hooks/useTerminalAppearance";
import { translate } from "@/lib/translate";
import { requestStepUp, STEP_UP_CLOSE_CODE, stepUpToken } from "@/lib/stepUp";
import type { TranslationKey } from "@/locales/en";
import { CommandHoldBanner } from "@/components/commands/CommandHoldBanner";
import { nextBanner, parseTerminalFrame, type HoldBanner } from "@/lib/commandRules";
import { lanShellEnders, type LanTerminalSession, type LanTerminalStatus } from "@/hooks/useLanTerminals";
import { canResume, detachLayers, isDropCode, parseShellFrame, reconnectDelay, SHELL_GONE_CLOSE_CODE, SHELL_TAKEN_CLOSE_CODE, type DetachGrace } from "@/lib/terminalDetach";
import { endKeptShell } from "@/lib/terminalShellSocket";
import { ReconnectBanner, type ReconnectState } from "@/components/tunnels/ReconnectBanner";
import { ReconnectWhy } from "@/components/tunnels/ReconnectWhy";
import { useTerminalDetach } from "@/hooks/useTerminalDetach";

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
    onShell?: (key: number, shellId: string | null) => void;
}

export function LanTerminal({ session, visible, onStatus, onShell }: Props) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const termRef = useRef<{ term: any; fit: any } | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    /** 指令規則的提示列。/ The command-rule banner. */
    const [banner, setBanner] = useState<HoldBanner | null>(null);
    /** 斷線、shell 還留著：重新連線中。/ Dropped with the shell kept: reconnecting. */
    const [reconnect, setReconnect] = useState<ReconnectState | null>(null);
    const retryNow = useRef<() => void>(() => {});
    const detachPref = useTerminalDetach();
    const [whyOpen, setWhyOpen] = useState(false);
    /** 接回時伺服器說的保留時間是誰決定的（說明圖用）。/ Who decided the grace, for the explainer. */
    const [decidedBy, setDecidedBy] = useState<string | null>(null);
    const { key, tunnelId, hostId, login, deviceUser, attempt } = session;
    const { resolved, ready: appearanceReady } = useTerminalAppearance(String(tunnelId));
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

    // xterm 一個 session 只建一次；等這台裝置的外觀覆寫載好再建，才不會先用預設字型再換一次（和終端機頁一樣）。
    // One xterm per session, created once this device's appearance override is known (like the terminal page), so
    // it never opens in the default font and switches.
    useEffect(() => {
        if (!appearanceReady) return;
        let disposed = false;
        let cleanup = () => {};
        (async () => {
            const [{ Terminal, FitAddon }] = await Promise.all([loadXtermDeps(), waitForFont(resolvedRef.current.font, resolvedRef.current.bold !== "bright")]);
            if (disposed || !hostRef.current) return;
            const look = resolvedRef.current;
            const term = new Terminal({ cursorBlink: true, ...xtermLookOptions(look) });
            const fit = new FitAddon();
            term.loadAddon(fit);
            term.open(hostRef.current);
            applyLigatures(term, look.ligatures);
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
    }, [sendResize, appearanceReady]);

    // 連線（attempt 變了就重連，全新 shell）。斷線時 shell 還留著就帶 resume 接回（lib/terminalDetach）。
    // (Re)connect whenever `attempt` changes (a fresh shell). A drop with the shell kept resumes it (lib/terminalDetach).
    const initialShell = useRef(session.shellId ?? null);
    useEffect(() => {
        let closedByUs = false;
        let authRetried = false;
        let ping: ReturnType<typeof setInterval> | null = null;
        let waitTerm: ReturnType<typeof setInterval> | null = null;
        let retry: ReturnType<typeof setTimeout> | null = null;
        // 重新整理後的第一次連線接回存著的 shell；之後的 attempt 是全新的。/ Only the first connect re-attaches a stored shell.
        let shellId: string | null = attempt === 0 ? initialShell.current : null;
        let offset: number | null = null;
        let grace: DetachGrace | null = null;
        let droppedAt: number | null = null;
        let tries = 0;
        const auth = { server_id: String(tunnelId), username: deviceUser, lan_host_id: String(hostId), ...(login ? { lan_username: login } : {}) };

        const write = (line: string) => termRef.current?.term.write(line);
        const forget = () => {
            shellId = null;
            offset = null;
            grace = null;
            droppedAt = null;
            setReconnect(null);
            onShell?.(key, null);
        };
        // 關分頁：明確結束這個 shell。/ Closing the tab ends the shell explicitly.
        lanShellEnders.set(key, () => {
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
                try { ws.send(JSON.stringify({ action: "end" })); } catch { /* noop */ }
            } else if (shellId) {
                endKeptShell(auth, shellId);
            }
            shellId = null;
        });
        const connect = () => {
            const ws = new WebSocket(`${getWsOrigin()}/ws/terminal/`);
            ws.binaryType = "arraybuffer";
            wsRef.current = ws;
            ws.onopen = () => {
                ws.send(JSON.stringify({
                    type: "auth",
                    token: localStorage.getItem("accessToken"),
                    ...auth,
                    step_up: stepUpToken() ?? undefined,
                    ...(shellId ? { resume: shellId, ...(offset !== null ? { offset } : {}) } : {}),
                }));
                if (!shellId) write(`\x1b[90m${translate("terminal.connectingToServer")}\x1b[0m\r\n`);
                onStatus(key, "connected");
                sendResize();
                ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ action: "ping" })), 5000);
            };
            ws.onmessage = (ev) => {
                if (typeof ev.data === "string") {
                    authRetried = false;
                    if (offset !== null) offset += ev.data.length;
                    write(ev.data);
                    return;
                }
                // 二進位 frame：pong、指令規則通知或 shell frame。/ Binary frames: pongs, command notices or the shell frame.
                const frame = parseTerminalFrame(ev.data as ArrayBuffer);
                if (frame && frame !== "pong") setBanner((prev) => nextBanner(prev, frame));
                else if (!frame) {
                    const sh = parseShellFrame(new TextDecoder().decode(ev.data as ArrayBuffer));
                    if (!sh) return;
                    if (sh.reset) {
                        try { termRef.current?.term.reset(); } catch { /* noop */ }
                    }
                    shellId = sh.id;
                    offset = sh.offset;
                    grace = sh.detach;
                    setDecidedBy(sh.detach.by);
                    droppedAt = null;
                    tries = 0;
                    setReconnect(null);
                    onShell?.(key, sh.detach.secs > 0 ? sh.id : null);
                }
            };
            ws.onclose = (ev) => {
                if (ping) clearInterval(ping);
                // 伺服器已撤回等核准的指令。/ The server already withdrew a pending command.
                setBanner((prev) => (prev?.state === "pending" ? null : prev));
                if (wsRef.current === ws) wsRef.current = null;
                if (closedByUs) return;
                // 斷線、shell 還留著：重新連線中，退避後接回。/ A drop with the shell kept: reconnect after a backoff.
                const now = Date.now();
                if (shellId && canResume(ev.code, grace, droppedAt ?? now, now)) {
                    droppedAt ??= now;
                    if (grace) setReconnect({ droppedAt, grace });
                    onStatus(key, "connecting");
                    retry = setTimeout(() => {
                        retry = null;
                        if (!closedByUs) connect();
                    }, reconnectDelay(tries++));
                    return;
                }
                if (ev.code === SHELL_GONE_CLOSE_CODE) {
                    forget();
                    write(`\r\n\x1b[33m${translate("detach.goneXterm")}\x1b[0m\r\n`);
                    connect();
                    return;
                }
                const wasReconnecting = droppedAt !== null;
                if (ev.code !== 4001 && ev.code !== STEP_UP_CLOSE_CODE) forget();
                if (ev.code === SHELL_TAKEN_CLOSE_CODE) {
                    write(`\r\n\x1b[33m${translate("detach.takenXterm")}\x1b[0m\r\n`);
                    onStatus(key, "closed");
                    return;
                }
                if (wasReconnecting && isDropCode(ev.code)) {
                    write(`\r\n\x1b[31m${translate("detach.expiredXterm")}\x1b[0m\r\n`);
                    onStatus(key, "closed");
                    return;
                }
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
                // 敏感隧道：確認是你之後重連。/ Sensitive tunnel: reconnect after the step-up.
                if (ev.code === STEP_UP_CLOSE_CODE) {
                    write(`\r\n\x1b[33m${translate("stepUp.neededXterm")}\x1b[0m\r\n`);
                    requestStepUp().then((ok) => {
                        if (closedByUs) return;
                        if (ok) connect();
                        else onStatus(key, "closed");
                    });
                    return;
                }
                if (ev.code === 4010) {
                    write(`\r\n\x1b[33m${translate("security.signedOutXterm")}\x1b[0m\r\n`);
                    onStatus(key, "closed");
                    return;
                }
                if (ev.code === 4009) {
                    write(`\r\n\x1b[33m${translate("sessions.endedXterm", { by: ev.reason || "?" })}\x1b[0m\r\n`);
                    onStatus(key, "closed");
                    return;
                }
                const msg = ev.code === 4001 ? "terminal.authFailedXterm" : CLOSE_MESSAGES[ev.code];
                write(`\r\n\x1b[31m${msg ? translate(msg) : translate("terminal.disconnectedCodeXterm", { code: ev.code })}\x1b[0m\r\n`);
                onStatus(key, "closed");
            };
        };
        retryNow.current = () => {
            if (droppedAt === null || !retry) return;
            clearTimeout(retry);
            retry = null;
            tries = 0;
            connect();
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
            lanShellEnders.delete(key);
            retryNow.current = () => {};
            if (waitTerm) clearInterval(waitTerm);
            if (ping) clearInterval(ping);
            if (retry) clearTimeout(retry);
            // 卸載（關分頁之外：離開頁面）不算結束：shell 照保留時間留著。/ Unmounting (leaving the page) is not an end.
            try { wsRef.current?.close(); } catch { /* noop */ }
            wsRef.current = null;
        };
    }, [attempt, key, tunnelId, hostId, login, deviceUser, onStatus, onShell, sendResize]);

    // 顯示時 fit + 聚焦（桌機）。/ Refit (and focus on desktop) when shown.
    useEffect(() => {
        if (!visible) return;
        requestAnimationFrame(() => {
            sendResize();
            if (window.innerWidth >= 768) termRef.current?.term.focus();
        });
    }, [visible, sendResize]);

    const withdraw = useCallback(() => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: "command_cancel" }));
    }, []);
    const dismiss = useCallback(() => setBanner(null), []);

    // 工具箱：送進這個區網終端機（同一條 pty_input，指令規則照樣檢查）。/ The toolbox types into this LAN terminal.
    const { t } = useI18n();
    const [toolboxOpen, setToolboxOpen] = useState(false);
    const bannerRef = useRef(banner);
    useEffect(() => { bannerRef.current = banner; }, [banner]);
    const toolboxTarget: ToolboxTarget = useMemo(() => ({
        tunnelId,
        send: (input: string) => {
            const ws = wsRef.current;
            if (!ws || ws.readyState !== WebSocket.OPEN) return false;
            ws.send(JSON.stringify({ action: "pty_input", payload: { input } }));
            return true;
        },
        onOutput: (cb: () => void) => {
            const sub = termRef.current?.term?.onWriteParsed?.(cb) as { dispose: () => void } | undefined;
            return () => sub?.dispose();
        },
        connected: session.status === "connected",
        banner: () => bannerRef.current,
        where: `${login || "?"}@${session.hostName}`,
    }), [tunnelId, session.status, session.hostName, login]);
    const afterSend = useCallback(() => {
        setToolboxOpen(false);
        setTimeout(() => termRef.current?.term?.focus(), 50);
    }, []);

    // 外框跟著配色的背景色(淺色配色不會留一圈黑邊)。/ The padding follows the scheme background (no black ring on light schemes).
    return (
        <div className="absolute inset-0" style={{ display: visible ? "block" : "none" }}>
            <div ref={hostRef} className="absolute inset-0 p-1.5" style={{ background: resolved.scheme.theme.background }} />
            <button
                type="button"
                onClick={() => setToolboxOpen(true)}
                title={t("toolbox.show")}
                aria-label={t("toolbox.show")}
                className="absolute bottom-2 right-3 z-10 grid size-8 place-items-center rounded-md border border-border bg-card/90 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
                <Wrench size={15} />
            </button>
            <Modal isOpen={toolboxOpen} onClose={() => setToolboxOpen(false)} title={t("toolbox.title")} icon={<Wrench />} size="lg" bodyClassName="px-2 py-2 sm:px-3">
                <ToolboxPanel target={toolboxTarget} tunnelName={session.tunnelName} onSent={afterSend} embedded />
            </Modal>
            {(banner || reconnect) && (
                <div className="pointer-events-none absolute inset-x-2 top-2 z-10 flex justify-end">
                    <div className="pointer-events-auto w-full max-w-md space-y-2">
                        {reconnect && (
                            <ReconnectBanner state={reconnect} onWhy={() => setWhyOpen(true)} onRetry={() => retryNow.current()} />
                        )}
                        {banner && <CommandHoldBanner banner={banner} onWithdraw={withdraw} onDismiss={dismiss} />}
                    </div>
                </div>
            )}
            <ReconnectWhy
                isOpen={whyOpen}
                onClose={() => setWhyOpen(false)}
                reconnecting={reconnect}
                ended={session.status === "closed"}
                layers={detachLayers(detachPref.choice, detachPref.limit, decidedBy === "tunnel" ? "never" : null)}
            />
        </div>
    );
}
