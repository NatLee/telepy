/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 終端機頁邏輯：多 shell 分頁、xterm 初始化、WebSocket PTY、Service Keys 載入。
 * Terminal page logic: multi shell tabs, xterm init, WebSocket PTY, service keys loading.
 *
 * 多分頁架構 / Multi-tab architecture:
 * - 每個分頁 = 一個獨立 session（自己的 xterm 實例 + 自己的 /ws/terminal/ WebSocket + 後端一個
 *   全新 PTY/ssh shell）。後端無需任何協定變更；分頁互不影響，關分頁（或關頁面）即關 WS，
 *   後端 disconnect 隨即殺掉該 shell —— 符合「每次都是新 shell、斷線就殺舊 shell」的語意。
 *   Each tab = one session (own xterm + own WebSocket + a fresh PTY/ssh shell on the backend).
 *   No backend protocol change; closing a tab closes its WS and the backend kills that shell.
 * - session 物件存在 ref Map（xterm/WebSocket 不可序列化）；React state 只放渲染用的
 *   tabs metadata（id/title/username/status）與 activeTabId。
 *   Sessions live in a ref Map; React state holds only render metadata.
 * - xtermRef / wsRef 永遠指向「作用中分頁」的 term/ws，讓 MobileKeyboard、AccessoryBar 等
 *   既有元件無需改動。/ xtermRef & wsRef always track the ACTIVE tab so existing consumers work as-is.
 * - 隱藏分頁以 display:none 保留完整終端狀態；切換分頁時 refit + 送 pty_resize。
 *   Hidden tabs keep full terminal state via display:none; refit + pty_resize on activation.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, refreshAccessToken } from "@/lib/api";
import { requestStepUp, STEP_UP_CLOSE_CODE, stepUpToken } from "@/lib/stepUp";
import { getWsOrigin } from "@/lib/websocket";
import { TerminalMainView } from "@/lib/tunnelUrls";
import type { KeyboardMode } from "@/hooks/useKeyboardController";
import { useI18n } from "@/lib/i18n";
import { loadXtermDeps, resolveCssVar, waitForFont } from "@/lib/xterm";
import { terminalFontFamily, type ResolvedTerminalAppearance } from "@/lib/terminalAppearance";
import { useLiveTerminalLook, useTerminalAppearance } from "@/hooks/useTerminalAppearance";

const KEYBOARD_MODE_KEY = "telepy.keyboardMode";

// 分頁上限：每個分頁在後端是一條 mux session（共用 ControlMaster 連線），遠端 sshd 預設
// MaxSessions=10，保守取 6 留餘裕給 File Manager / 其他工具的連線。
// Tab cap: each tab is one mux session on the shared ControlMaster connection; remote sshd
// defaults to MaxSessions=10, so 6 leaves headroom for the file manager etc.
export const MAX_SHELL_TABS = 6;

export interface TerminalUsername {
    id: number;
    username: string;
    created_by?: string;
    created_by_id?: number;
}

/** 經裝置跳到區網主機（#20）。/ A LAN host reached through the device. */
export interface TerminalLanTarget {
    hostId: string;
    /** 覆寫主機記錄的預設帳號。/ Overrides the host's default login. */
    username?: string | null;
}

/** 區網主機資訊（顯示用）。/ LAN host details for display. */
export interface TerminalLanHost {
    id: number;
    address: string;
    label: string | null;
    username: string | null;
    ssh_port: number;
}

export type ShellTabStatus = "connecting" | "connected" | "closed";

export interface ShellTab {
    id: number;
    /** 顯示用序號（"1"、"2"…，頁面存續期間遞增不重用）。/ Display ordinal, never reused. */
    title: string;
    username: string;
    status: ShellTabStatus;
}

type Session = {
    id: number;
    title: string;
    username: string;
    el: HTMLDivElement;
    term: any;
    fit: any;
    ws: WebSocket | null;
    pingInterval: ReturnType<typeof setInterval> | null;
    pingSentAt: number;
    lastLatency: number | null;
    /** 4001 時每個 session 只 refresh 重連一次；收到真正 PTY 輸出即歸零。 */
    authRetried: boolean;
    disposed: boolean;
};

export function useTerminalPage(serverId: string | null, accessToken: string | null, lan: TerminalLanTarget | null = null) {
    const { t } = useI18n();
    const appearance = useTerminalAppearance(serverId);
    const { resolved, ready: appearanceReady } = appearance;
    // createSession 是 async,要讀「建立當下」最新的外觀。/ createSession is async and needs the latest look.
    const resolvedRef = useRef<ResolvedTerminalAppearance>(resolved);
    useEffect(() => { resolvedRef.current = resolved; }, [resolved]);
    const lanHostId = lan?.hostId ?? null;
    const lanUsername = lan?.username ?? null;
    const terminalRef = useRef<HTMLDivElement>(null);
    /** 永遠指向作用中分頁的 xterm / WebSocket（供鍵盤等元件使用）。 */
    const xtermRef = useRef<any>(null);
    const wsRef = useRef<WebSocket | null>(null);

    const sessionsRef = useRef<Map<number, Session>>(new Map());
    const activeIdRef = useRef<number | null>(null);
    const nextIdRef = useRef(1);
    // 世代計數：unmount / server 切換時 +1，讓仍在 await 的 createSession 自我作廢。
    // Generation counter: bumped on unmount so in-flight async creates abort themselves.
    const generationRef = useRef(0);
    // 正在建立、還在 await 字型 / xterm、尚未進 sessionsRef 的分頁數。沒有它的話,這段期間任何讓「開第一個分頁」
    // effect 重跑的變更(例如語言同步換了 t)都會再開一個 shell。
    // Tabs being created that are still awaiting xterm / the font and not yet in sessionsRef. Without it, any
    // re-run of the first-tab effect during that wait (e.g. the language sync changing t) opened a second shell.
    const pendingCreatesRef = useRef(0);
    const usernameRef = useRef<string | null>(null);

    const [tabs, setTabs] = useState<ShellTab[]>([]);
    const tabsRef = useRef<ShellTab[]>([]);
    useEffect(() => { tabsRef.current = tabs; }, [tabs]);
    const [activeTabId, setActiveTabId] = useState<number | null>(null);

    // 「你↔伺服器」RTT（毫秒）：作用中分頁的 ping/pong 量測。/ Active tab's WS RTT.
    const [latencyMs, setLatencyMs] = useState<number | null>(null);
    const [permissionDenied, setPermissionDenied] = useState<string | null>(null);
    const [noUsers, setNoUsers] = useState(false);
    const [showFiles, setShowFiles] = useState(false);
    const [isBrowserActive, setIsBrowserActive] = useState(false);
    const [keyboardExpanded, setKeyboardExpanded] = useState(true);
    const [keyboardMode, setKeyboardModeState] = useState<KeyboardMode>("accessory");
    const [headerExpanded, setHeaderExpanded] = useState(false);
    const [mainView, setMainView] = useState<TerminalMainView>("terminal");
    const [syncedPath, setSyncedPath] = useState<string | undefined>();

    const [serviceKeyModalOpen, setServiceKeyModalOpen] = useState(false);
    const [serviceKeys, setServiceKeys] = useState<any[]>([]);
    const [loadingServiceKeys, setLoadingServiceKeys] = useState(false);

    const [username, setUsername] = useState<string | null>(null);
    const [availableUsernames, setAvailableUsernames] = useState<TerminalUsername[]>([]);

    // 讀取上次選擇的鍵盤模式（SSR 安全：在 effect 內存取 localStorage）。
    useEffect(() => {
        try {
            const saved = localStorage.getItem(KEYBOARD_MODE_KEY);
            if (saved === "accessory" || saved === "full" || saved === "hidden") {
                setKeyboardModeState(saved);
            }
        } catch { /* localStorage 不可用時忽略 */ }
    }, []);

    const setKeyboardMode = (m: KeyboardMode) => {
        setKeyboardModeState(m);
        try { localStorage.setItem(KEYBOARD_MODE_KEY, m); } catch { /* 忽略 */ }
    };

    const updateTab = useCallback((id: number, patch: Partial<ShellTab>) => {
        setTabs(prev => prev.map(t => (t.id === id ? { ...t, ...patch } : t)));
    }, []);

    // ────────────────────────────────────────────────────────────────────
    // Session 基礎操作 / Session primitives
    // ────────────────────────────────────────────────────────────────────

    const stopPing = (s: Session) => {
        if (s.pingInterval) { clearInterval(s.pingInterval); s.pingInterval = null; }
    };

    /** 靜默拆掉 ws（不觸發 onclose 的狀態更新）。/ Detach handlers and close the ws silently. */
    const detachWs = (s: Session) => {
        stopPing(s);
        if (s.ws) {
            s.ws.onopen = null;
            s.ws.onmessage = null;
            s.ws.onerror = null;
            s.ws.onclose = null;
            try { s.ws.close(); } catch { /* noop */ }
            s.ws = null;
        }
    };

    /** fit + 送 pty_resize（僅在該 session 可見時有效）。/ Fit and push pty_resize (visible only). */
    const fitAndResize = useCallback((s: Session) => {
        if (s.disposed || s.el.style.display === "none") return;
        try {
            s.fit.fit();
            s.term.scrollToBottom();
        } catch { /* noop */ }
        if (s.ws && s.ws.readyState === WebSocket.OPEN) {
            s.ws.send(JSON.stringify({
                action: "pty_resize",
                payload: {
                    size: {
                        rows: s.term.rows,
                        cols: s.term.cols,
                        height: s.term.rows * 20,
                        width: s.term.cols * 9,
                    },
                },
            }));
        }
    }, []);

    /** 切換作用中分頁：顯示/隱藏容器、更新 refs、refit、聚焦。/ Activate a tab. */
    const activateSession = useCallback((id: number) => {
        const target = sessionsRef.current.get(id);
        if (!target || target.disposed) return;
        activeIdRef.current = id;
        setActiveTabId(id);
        sessionsRef.current.forEach((s) => {
            s.el.style.display = s.id === id ? "" : "none";
        });
        xtermRef.current = target.term;
        wsRef.current = target.ws;
        setLatencyMs(target.lastLatency);
        // 等 display 生效後再量尺寸；手機不自動聚焦（避免切分頁就彈出原生鍵盤）。
        // Measure after the display change lands; skip autofocus on mobile (no surprise keyboard).
        requestAnimationFrame(() => {
            fitAndResize(target);
            if (typeof window !== "undefined" && window.innerWidth >= 768) {
                try { target.term.focus(); } catch { /* noop */ }
            }
        });
    }, [fitAndResize]);

    /** 為 session 建立（或重建）WebSocket 連線。/ (Re)connect a session's WebSocket. */
    const connectSession = useCallback((s: Session) => {
        if (s.disposed || !serverId) return;
        detachWs(s);

        const ws = new WebSocket(`${getWsOrigin()}/ws/terminal/`);
        // pong 走二進位 frame（與 PTY 文字輸出區分）。/ Binary pongs, distinct from PTY text.
        ws.binaryType = "arraybuffer";
        s.ws = ws;
        if (activeIdRef.current === s.id) wsRef.current = ws;

        const sendPing = () => {
            if (ws.readyState !== WebSocket.OPEN) return;
            s.pingSentAt = Date.now();
            ws.send(JSON.stringify({ action: "ping" }));
        };

        ws.onopen = () => {
            if (s.disposed) return;
            // 第一則訊息即認證：{type:'auth', token, server_id, username}。token 從 localStorage 取
            // 「最新」值（若剛因 4001 refresh 過，外層 accessToken prop 可能還是舊值）。
            ws.send(JSON.stringify({
                type: "auth",
                token: typeof window !== "undefined" ? localStorage.getItem("accessToken") : null,
                server_id: serverId,
                username: s.username,
                // 敏感隧道的 step-up（這個分頁有才帶）。/ This tab's step-up token for sensitive tunnels.
                step_up: stepUpToken() ?? undefined,
                // 區網主機：username 是裝置那一跳的帳號。/ LAN host: `username` is the device hop.
                ...(lanHostId ? { lan_host_id: lanHostId, ...(lanUsername ? { lan_username: lanUsername } : {}) } : {}),
            }));
            updateTab(s.id, { status: "connected" });
            // WS 已開，但後端仍在建立到裝置的 SSH 連線；先給回饋，首個 PTY 輸出會覆蓋此行。
            s.term.write(`\x1b[90m${t("terminal.connectingToServer")}\x1b[0m\r\n`);
            if (activeIdRef.current === s.id) fitAndResize(s);
            sendPing();
            stopPing(s);
            s.pingInterval = setInterval(sendPing, 5000);
        };

        ws.onmessage = (event) => {
            if (s.disposed) return;
            // 二進位 frame = pong 控制訊息（量 RTT），不可寫進畫面。/ Binary frame = pong (RTT only).
            if (typeof event.data !== "string") {
                s.lastLatency = Math.max(0, Date.now() - s.pingSentAt);
                if (activeIdRef.current === s.id) setLatencyMs(s.lastLatency);
                return;
            }
            // 收到真正的 PTY 輸出 = 認證成功，歸零 4001 refresh 重試旗標。
            s.authRetried = false;
            s.term.write(event.data);
        };

        ws.onerror = () => { /* onclose 隨後處理 / onclose follows */ };

        ws.onclose = (event) => {
            if (s.disposed) return;
            stopPing(s);
            if (s.ws === ws) s.ws = null;
            if (activeIdRef.current === s.id) {
                setLatencyMs(null);
                if (wsRef.current === ws) wsRef.current = null;
            }
            updateTab(s.id, { status: "closed" });

            const code = event.code;
            if (lanHostId && code === 4004) {
                setPermissionDenied(t("terminal.lanHostMissingCard"));
                s.term.write(`\r\n\x1b[31m${t("terminal.lanHostMissingXterm")}\x1b[0m\r\n`);
            } else if (lanHostId && code === 4003) {
                setPermissionDenied(t("terminal.lanLoginInvalidCard"));
                s.term.write(`\r\n\x1b[31m${t("terminal.lanLoginInvalidXterm")}\x1b[0m\r\n`);
            } else if (code === 4004) {
                setPermissionDenied(t("terminal.permissionDeniedCard"));
                s.term.write(`\r\n\x1b[31m${t("terminal.permissionDeniedXterm")}\x1b[0m\r\n`);
            } else if (code === 4003) {
                setPermissionDenied(t("terminal.invalidUsernameCard"));
                s.term.write(`\r\n\x1b[31m${t("terminal.invalidUsernameXterm")}\x1b[0m\r\n`);
            } else if (code === 4001) {
                // token 過期/無效：每個 session 只 refresh 重連一次。
                if (!s.authRetried) {
                    s.authRetried = true;
                    refreshAccessToken().then((ok) => {
                        if (s.disposed) return;
                        if (ok) {
                            updateTab(s.id, { status: "connecting" });
                            connectSession(s);
                        } else {
                            setPermissionDenied(t("terminal.authFailedCard"));
                            s.term.write(`\r\n\x1b[31m${t("terminal.authFailedXterm")}\x1b[0m\r\n`);
                        }
                    });
                } else {
                    setPermissionDenied(t("terminal.authFailedCard"));
                    s.term.write(`\r\n\x1b[31m${t("terminal.authFailedXterm")}\x1b[0m\r\n`);
                }
            } else if (code === 4002) {
                setPermissionDenied(t("terminal.notFoundCard"));
                s.term.write(`\r\n\x1b[31m${t("terminal.notFoundXterm")}\x1b[0m\r\n`);
            } else if (code === STEP_UP_CLOSE_CODE) {
                // 敏感隧道：先確認是你（同時好幾個分頁也只問一次），成功就重連這個分頁。
                // Sensitive tunnel: confirm it's you (asked once for every tab), then reconnect this tab.
                s.term.write(`\r\n\x1b[33m${t("stepUp.neededXterm")}\x1b[0m\r\n`);
                requestStepUp().then((ok) => {
                    if (s.disposed) return;
                    if (ok) {
                        updateTab(s.id, { status: "connecting" });
                        connectSession(s);
                    } else {
                        setPermissionDenied(t("stepUp.deniedCard"));
                    }
                });
            } else if (code === 4009) {
                // 有人從即時 session 頁結束了它（原因 = 是誰）。/ Ended from the live sessions page (reason = who).
                s.term.write(`\r\n\x1b[33m${t("sessions.endedXterm", { by: event.reason || "?" })}\x1b[0m\r\n`);
            } else if (code === 4006) {
                setNoUsers(true);
                s.term.write(`\r\n\x1b[31m${t("terminal.noUsersXterm")}\x1b[0m\r\n`);
            } else if (code === 1000) {
                s.term.write(`\r\n\x1b[31m${t("terminal.disconnectedXterm")}\x1b[0m\r\n`);
            } else {
                // 非正常關閉：顯示 close code 以利排查（1006 = 網路/代理層異常斷線，非後端主動關閉）。
                // Abnormal close: surface the code (1006 = network/proxy layer drop, not the backend).
                s.term.write(`\r\n\x1b[31m${t("terminal.disconnectedCodeXterm", { code })}\x1b[0m\r\n`);
            }
        };
    }, [serverId, lanHostId, lanUsername, updateTab, fitAndResize, t]);

    /** 建立新分頁（含 xterm 實例與 WS 連線），並切換為作用中。/ Create + activate a new tab. */
    const createSession = useCallback(async (sessionUsername: string) => {
        if (!serverId || sessionsRef.current.size + pendingCreatesRef.current >= MAX_SHELL_TABS) return;
        const generation = generationRef.current;

        pendingCreatesRef.current += 1;
        let deps: { Terminal: any; FitAddon: any };
        try {
            [deps] = await Promise.all([loadXtermDeps(), waitForFont(resolvedRef.current.font)]);
        } finally {
            // 卸載時計數已歸零,作廢的建立不再扣。/ Unmount already reset the count; an aborted create doesn't subtract.
            if (generation === generationRef.current) pendingCreatesRef.current -= 1;
        }
        const { Terminal, FitAddon } = deps;

        // async 期間可能已 unmount / 換 server。/ May have unmounted while awaiting.
        if (generation !== generationRef.current) return;
        const host = terminalRef.current;
        if (!host) return;

        const id = nextIdRef.current++;
        const el = document.createElement("div");
        el.className = "absolute inset-0";
        host.appendChild(el);

        // 等待期間外觀可能變了,用最新的;之後的變更由下方的外觀 effect 即時套用到所有分頁。
        // Use the latest look (it may have changed while awaiting); later changes reach every tab via the effects below.
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
        term.open(el);

        const s: Session = {
            id,
            title: String(id),
            username: sessionUsername,
            el,
            term,
            fit,
            ws: null,
            pingInterval: null,
            pingSentAt: 0,
            lastLatency: null,
            authRetried: false,
            disposed: false,
        };

        // OSC 7 同步當前路徑（僅作用中分頁，避免背景分頁改動檔案面板路徑）。
        // OSC 7 path sync (active tab only, so background shells don't steer the file panel).
        term.parser.registerOscHandler(7, (data: string) => {
            try {
                const url = new URL(data);
                if (url.protocol === "file:") {
                    if (activeIdRef.current === s.id) {
                        setSyncedPath(decodeURIComponent(url.pathname));
                    }
                    return true;
                }
            } catch { /* noop */ }
            return false;
        });

        term.onData((data: string) => {
            if (s.ws && s.ws.readyState === WebSocket.OPEN) {
                s.ws.send(JSON.stringify({ action: "pty_input", payload: { input: data } }));
            }
        });

        sessionsRef.current.set(id, s);
        setTabs(prev => [...prev, { id, title: s.title, username: sessionUsername, status: "connecting" }]);
        activateSession(id);
        connectSession(s);
    }, [serverId, activateSession, connectSession]);

    /** 徹底銷毀 session（關 WS → 後端殺 shell；釋放 xterm 與 DOM）。/ Fully dispose a session. */
    const destroySession = useCallback((id: number) => {
        const s = sessionsRef.current.get(id);
        if (!s) return;
        s.disposed = true;
        detachWs(s); // 關 WS → 後端 disconnect() 殺掉該 shell / closing the WS kills the shell server-side
        try { s.term.dispose(); } catch { /* noop */ }
        try { s.el.remove(); } catch { /* noop */ }
        sessionsRef.current.delete(id);
    }, []);

    /** 同一分頁重新連線（全新 shell）：清空畫面、開新 WS。/ Reconnect a tab with a fresh shell. */
    const respawnSession = useCallback((id: number, newUsername?: string) => {
        const s = sessionsRef.current.get(id);
        if (!s || s.disposed) return;
        detachWs(s);
        if (newUsername) s.username = newUsername;
        s.authRetried = false;
        try { s.term.reset(); } catch { /* noop */ }
        updateTab(id, { status: "connecting", username: s.username });
        connectSession(s);
    }, [connectSession, updateTab]);

    // ────────────────────────────────────────────────────────────────────
    // 分頁對外操作 / Public tab actions
    // ────────────────────────────────────────────────────────────────────

    const addTab = useCallback(() => {
        const u = usernameRef.current;
        if (!u) return;
        void createSession(u);
    }, [createSession]);

    const selectTab = useCallback((id: number) => {
        if (id !== activeIdRef.current) activateSession(id);
    }, [activateSession]);

    const closeTab = useCallback((id: number) => {
        if (!sessionsRef.current.has(id)) return; // 已關閉（防連點）/ already closed (double-click guard)
        const order = tabsRef.current;
        const idx = order.findIndex(t => t.id === id);
        const wasActive = activeIdRef.current === id;

        destroySession(id);
        setTabs(prev => prev.filter(t => t.id !== id));

        // 以 sessionsRef（真實存活狀態）為準挑選倖存分頁，避免 state 尚未 flush 時的過期清單。
        // Pick survivors from sessionsRef (ground truth), not possibly-stale React state.
        const survivors = order.filter(t => t.id !== id && sessionsRef.current.has(t.id));

        if (sessionsRef.current.size === 0) {
            // 關掉最後一個分頁 = 換一個全新 shell（頁面保持可用）。
            // Closing the last tab spawns a fresh shell (the page stays usable).
            activeIdRef.current = null;
            setActiveTabId(null);
            xtermRef.current = null;
            wsRef.current = null;
            const u = usernameRef.current;
            if (u) void createSession(u);
        } else if (wasActive && survivors.length > 0) {
            const neighbor = survivors[Math.min(Math.max(idx, 0), survivors.length - 1)];
            activateSession(neighbor.id);
        }
    }, [destroySession, createSession, activateSession]);

    // ────────────────────────────────────────────────────────────────────
    // 生命週期 / Lifecycle effects
    // ────────────────────────────────────────────────────────────────────

    // 使用者列表載入。/ Load available usernames.
    useEffect(() => {
        if (!serverId || !accessToken) return;

        apiFetch(`/api/reverse/server/${serverId}/usernames`)
            .then(r => (r.ok ? r.json() : null))
            .then(data => {
                const list = data?.usernames ?? (Array.isArray(data) ? data : []);
                const defaultId = data?.default_username_id;
                setAvailableUsernames(list);
                if (list.length > 0) {
                    const defaultItem = defaultId ? list.find((u: any) => u.id === defaultId) : null;
                    setUsername(defaultItem ? defaultItem.username : (list[0].username ?? list[0]));
                    setNoUsers(false);
                } else {
                    setNoUsers(true);
                }
            })
            .catch(() => {
                setNoUsers(true);
            });
    }, [serverId, accessToken]);

    // 區網主機資訊（標頭顯示用；連線本身只靠 id）。/ LAN host details for the header.
    const [lanHostState, setLanHost] = useState<TerminalLanHost | null>(null);
    const lanHost = lanHostId && lanHostState && String(lanHostState.id) === lanHostId ? lanHostState : null;
    useEffect(() => {
        if (!serverId || !accessToken || !lanHostId) return;
        let cancelled = false;
        apiFetch(`/api/reverse/server/${serverId}/lan/hosts`)
            .then(r => (r.ok ? r.json() : null))
            .then(data => {
                if (cancelled) return;
                const hosts: TerminalLanHost[] = data?.hosts ?? [];
                setLanHost(hosts.find(h => String(h.id) === lanHostId) ?? null);
            })
            .catch(() => { /* 只影響標頭顯示 / header only */ });
        return () => { cancelled = true; };
    }, [serverId, accessToken, lanHostId]);

    // 卸載 / 換 server：銷毀所有 session（所有 WS 關閉 → 後端殺掉所有 shell）。
    // Unmount / server switch: destroy every session (all shells killed server-side).
    useEffect(() => {
        if (!serverId || !accessToken) return;
        return () => {
            generationRef.current += 1;
            pendingCreatesRef.current = 0;
            const ids = Array.from(sessionsRef.current.keys());
            ids.forEach(id => {
                const s = sessionsRef.current.get(id);
                if (!s) return;
                s.disposed = true;
                detachWs(s);
                try { s.term.dispose(); } catch { /* noop */ }
                try { s.el.remove(); } catch { /* noop */ }
            });
            sessionsRef.current.clear();
            activeIdRef.current = null;
            xtermRef.current = null;
            wsRef.current = null;
            setTabs([]);
            setActiveTabId(null);
            setLatencyMs(null);
        };
    }, [serverId, accessToken]);

    // username 就緒 → 開第一個分頁；之後切換 username → 只重連「作用中」分頁（其他分頁保留原 user）。
    // Username ready → first tab; switching username later reconnects only the ACTIVE tab.
    useEffect(() => {
        // 等外觀(這台裝置的覆寫)就緒,第一個 shell 才不會先用預設字型再換一次。
        // Wait for the appearance (device override) so the first shell doesn't open in the default font and switch.
        if (!serverId || !accessToken || username === null || !appearanceReady) return;
        usernameRef.current = username;
        if (sessionsRef.current.size === 0) {
            if (pendingCreatesRef.current === 0) void createSession(username);
            return;
        }
        const activeId = activeIdRef.current;
        const active = activeId !== null ? sessionsRef.current.get(activeId) : undefined;
        if (active && active.username !== username) {
            respawnSession(active.id, username);
        }
    }, [serverId, accessToken, username, appearanceReady, createSession, respawnSession]);

    // 視窗 / 容器尺寸變化 → refit 作用中分頁。/ Window & container resize → refit the active tab.
    useEffect(() => {
        const fitActive = () => {
            const id = activeIdRef.current;
            const s = id !== null ? sessionsRef.current.get(id) : undefined;
            if (s) fitAndResize(s);
        };

        window.addEventListener("resize", fitActive);

        let resizeObserver: ResizeObserver | null = null;
        let resizeTimeout: ReturnType<typeof setTimeout> | undefined;
        if (terminalRef.current) {
            resizeObserver = new ResizeObserver(() => {
                const id = activeIdRef.current;
                const s = id !== null ? sessionsRef.current.get(id) : undefined;
                if (!s) return;
                try {
                    s.fit.fit();
                    s.term.scrollToBottom();
                } catch { /* noop */ }
                clearTimeout(resizeTimeout);
                resizeTimeout = setTimeout(() => fitAndResize(s), 100);
            });
            resizeObserver.observe(terminalRef.current);
        }

        return () => {
            window.removeEventListener("resize", fitActive);
            clearTimeout(resizeTimeout);
            resizeObserver?.disconnect();
        };
    }, [fitAndResize]);

    // 版面切換（檔案面板開合 / 主視圖切換）後補一次 refit。/ Refit after layout toggles.
    useEffect(() => {
        const timer = setTimeout(() => {
            const id = activeIdRef.current;
            const s = id !== null ? sessionsRef.current.get(id) : undefined;
            if (s) fitAndResize(s);
        }, 200);
        return () => clearTimeout(timer);
    }, [showFiles, mainView, fitAndResize]);

    // 外觀變更(偏好設定 modal、終端機的外觀對話框、別的分頁、登入同步)即時套用到所有開著的分頁。
    // Appearance changes (preferences, the terminal's appearance dialog, other tabs, login sync) reach every open tab.
    const refitActive = useCallback(() => {
        const id = activeIdRef.current;
        const active = id !== null ? sessionsRef.current.get(id) : undefined;
        if (active) fitAndResize(active);
    }, [fitAndResize]);

    const forEachTerm = useCallback((fn: (term: any) => void) => {
        for (const s of sessionsRef.current.values()) fn(s.term);
    }, []);
    useLiveTerminalLook(resolved, forEachTerm, refitActive);

    // 僅在「完整虛擬鍵盤」模式抑制原生鍵盤；套用到所有分頁的 helper textarea。
    // Suppress the native keyboard only in "full" mode; applied to every tab's helper textarea.
    const activeTab = tabs.find(t => t.id === activeTabId) ?? null;
    const connected = activeTab?.status === "connected";
    const connecting = activeTab
        ? activeTab.status === "connecting"
        : (!noUsers && !permissionDenied);

    useEffect(() => {
        const suppressNative = keyboardMode === "full";
        const applyToTextareas = (fn: (ta: HTMLTextAreaElement) => void) => {
            if (!terminalRef.current) return;
            terminalRef.current
                .querySelectorAll<HTMLTextAreaElement>(".xterm-helper-textarea")
                .forEach(fn);
        };

        const manageNativeKeyboard = () => {
            if (window.innerWidth < 768) {
                applyToTextareas((textarea) => {
                    if (suppressNative) {
                        textarea.setAttribute("readonly", "true");
                        textarea.blur();
                    } else {
                        textarea.removeAttribute("readonly");
                    }
                });
            }
        };

        const handleFocus = (e: Event) => {
            if (window.innerWidth < 768 && suppressNative) {
                (e.target as HTMLTextAreaElement).blur();
            }
        };

        const t = setTimeout(() => {
            manageNativeKeyboard();
            applyToTextareas((ta) => {
                ta.removeEventListener("focus", handleFocus);
                ta.addEventListener("focus", handleFocus);
            });
        }, 100);

        return () => {
            clearTimeout(t);
            applyToTextareas((ta) => ta.removeEventListener("focus", handleFocus));
        };
    }, [keyboardMode, connected, activeTabId, tabs.length]);

    useEffect(() => {
        if (keyboardExpanded && xtermRef.current) {
            setTimeout(() => {
                try { xtermRef.current.scrollToBottom(); } catch { /* noop */ }
            }, 150);
        }
    }, [keyboardExpanded]);

    // Service Keys：開啟彈窗並呼叫 API。/ Service keys: open modal and call API.
    const fetchServiceKeys = async () => {
        setServiceKeyModalOpen(true);
        setLoadingServiceKeys(true);
        try {
            const res = await apiFetch("/api/reverse/service/keys");
            if (res.ok) {
                const data = await res.json();
                setServiceKeys(Array.isArray(data) ? data : []);
            } else {
                setServiceKeys([]);
            }
        } catch {
            setServiceKeys([]);
        } finally {
            setLoadingServiceKeys(false);
        }
    };

    return {
        refs: { terminalRef, xtermRef, wsRef },
        state: {
            tabs, activeTabId,
            connected,
            connecting,
            latencyMs,
            permissionDenied, setPermissionDenied,
            noUsers, setNoUsers,
            showFiles, setShowFiles,
            isBrowserActive, setIsBrowserActive,
            keyboardExpanded, setKeyboardExpanded,
            keyboardMode, setKeyboardMode,
            headerExpanded, setHeaderExpanded,
            mainView, setMainView,
            syncedPath, setSyncedPath,
            serviceKeyModalOpen, setServiceKeyModalOpen,
            serviceKeys, setServiceKeys,
            loadingServiceKeys, setLoadingServiceKeys,
            username, setUsername,
            availableUsernames, setAvailableUsernames,
            lanHost,
            appearance,
        },
        actions: {
            fetchServiceKeys,
            reconnect: () => {
                const id = activeIdRef.current;
                if (id !== null) respawnSession(id);
            },
            addTab,
            closeTab,
            selectTab,
        },
    };
}
