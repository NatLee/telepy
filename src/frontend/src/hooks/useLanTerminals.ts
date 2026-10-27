/**
 * 網路頁底部終端機 dock 的 session 清單：每台區網主機（+ 登入帳號 + 經過的裝置帳號）一個分頁，換主機也不會斷。
 * 斷線保留（lib/terminalDetach）：每個分頁記住後端給的 shell id，清單存在 sessionStorage `telepy.lanDock`，
 * 重新整理後 dock 帶著同樣的分頁回來並接回各自的 shell。關分頁（dock 的 ×、全部關閉）= 明確結束那個 shell。
 * Session list for the network page's terminal dock: one tab per LAN host login, kept while you browse. Each tab
 * remembers its shell id; the list lives in sessionStorage so a reload brings the dock back and re-attaches the
 * shells. Closing a tab (× / close all) ends its shell explicitly.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { TELEPY_AUTH, type LanAuth } from "@/lib/lanAuth";

export const MAX_LAN_TERMINALS = 6;
const DOCK_KEY = "telepy.lanDock";

export type LanTerminalStatus = "connecting" | "connected" | "closed";
export type DockSize = "min" | "normal" | "max";

export interface LanTerminalSession {
    key: number;
    tunnelId: number;
    tunnelName: string;
    /** 隧道的埠（開到終端機頁的連結要帶）。/ The tunnel's port (for the link to the terminal page). */
    reversePort: number;
    hostId: number;
    hostName: string;
    /** 區網主機上的帳號（空 = 用主機預設）。/ Login on the LAN host (empty = the host's default). */
    login: string;
    /** 裝置那一跳的帳號。/ The device hop's account. */
    deviceUser: string;
    /** 區網那一跳怎麼登入。/ How the LAN hop logs in. */
    auth: LanAuth;
    status: LanTerminalStatus;
    /** 每次重連 +1，讓終端機元件重開連線（全新 shell）。/ Bumped on reconnect so the terminal reopens (a fresh shell). */
    attempt: number;
    /** 後端保留中的 shell（重新整理後接回）。/ The server's kept shell, re-attached after a reload. */
    shellId?: string | null;
}

/**
 * 每個開著的分頁登記一個「結束這個 shell」的函式；關分頁時先叫它（元件接著就卸載了，卸載本身不算結束）。
 * Each open tab registers how to end its shell; closing a tab calls it first (unmounting alone is not an end).
 */
export const lanShellEnders = new Map<number, () => void>();

type Stored = Omit<LanTerminalSession, "status" | "attempt">;

/** sessionStorage 裡的 dock（只留有保留中 shell 的分頁）。/ The stored dock: only tabs with a kept shell. */
function loadDock(): LanTerminalSession[] {
    try {
        const v = JSON.parse(sessionStorage.getItem(DOCK_KEY) ?? "[]") as Stored[];
        if (!Array.isArray(v)) return [];
        return v
            .filter((s) => s && typeof s.key === "number" && typeof s.tunnelId === "number" && typeof s.hostId === "number" && typeof s.shellId === "string")
            .slice(0, MAX_LAN_TERMINALS)
            .map((s) => ({ ...s, auth: s.auth ?? TELEPY_AUTH, status: "connecting" as const, attempt: 0 }));
    } catch {
        return [];
    }
}

function saveDock(list: LanTerminalSession[]) {
    try {
        const keep: Stored[] = list.filter((s) => s.shellId).map((s) => {
            const rest: Partial<LanTerminalSession> = { ...s };
            delete rest.status;
            delete rest.attempt;
            return rest as Stored;
        });
        if (keep.length) sessionStorage.setItem(DOCK_KEY, JSON.stringify(keep));
        else sessionStorage.removeItem(DOCK_KEY);
    } catch { /* 不可用 / unavailable */ }
}

export function useLanTerminals() {
    const [sessions, setSessions] = useState<LanTerminalSession[]>([]);
    const [activeKey, setActiveKey] = useState<number | null>(null);
    const [size, setSize] = useState<DockSize>("normal");
    const [nextKey, setNextKey] = useState(1);
    const restored = useRef(false);

    // 重新整理後把 dock 帶回來（掛載後才讀 sessionStorage，SSR 安全）。/ Bring the dock back after a reload.
    // 讀完之前不寫回，免得空清單把存著的蓋掉。/ Nothing is written back before the restore, so an empty list can't wipe it.
    useEffect(() => {
        const id = setTimeout(() => {
            if (restored.current) return;
            restored.current = true;
            const list = loadDock();
            if (!list.length) return;
            setSessions(list);
            setActiveKey(list[list.length - 1].key);
            setNextKey(Math.max(...list.map((s) => s.key)) + 1);
        }, 0);
        return () => clearTimeout(id);
    }, []);
    useEffect(() => {
        if (restored.current) saveDock(sessions);
    }, [sessions]);

    const open = useCallback((s: Omit<LanTerminalSession, "key" | "status" | "attempt">): boolean => {
        if (sessions.length >= MAX_LAN_TERMINALS) return false;
        const key = nextKey;
        setNextKey(key + 1);
        setSessions((prev) => [...prev, { ...s, key, status: "connecting", attempt: 0, shellId: null }]);
        setActiveKey(key);
        setSize((v) => (v === "min" ? "normal" : v));
        return true;
    }, [sessions.length, nextKey]);

    /** 同一台機器再開一個 shell（dock 的「+」）。/ Another shell on the same machine (the dock's "+"). */
    const duplicate = useCallback((key: number): boolean => {
        const src = sessions.find((s) => s.key === key);
        if (!src) return false;
        const { tunnelId, tunnelName, reversePort, hostId, hostName, login, deviceUser, auth } = src;
        return open({ tunnelId, tunnelName, reversePort, hostId, hostName, login, deviceUser, auth });
    }, [sessions, open]);

    const close = useCallback((key: number) => {
        lanShellEnders.get(key)?.();
        setSessions((prev) => {
            const rest = prev.filter((s) => s.key !== key);
            setActiveKey((cur) => (cur === key ? rest[rest.length - 1]?.key ?? null : cur));
            return rest;
        });
    }, []);

    const closeAll = useCallback(() => {
        lanShellEnders.forEach((end) => end());
        setSessions([]);
        setActiveKey(null);
    }, []);

    const setStatus = useCallback((key: number, status: LanTerminalStatus) => {
        setSessions((prev) => prev.map((s) => (s.key === key && s.status !== status ? { ...s, status } : s)));
    }, []);

    /** 這個分頁的 shell id（null = 不再保留）。/ This tab's shell id (null = no longer kept). */
    const setShell = useCallback((key: number, shellId: string | null) => {
        setSessions((prev) => prev.map((s) => (s.key === key && (s.shellId ?? null) !== shellId ? { ...s, shellId } : s)));
    }, []);

    const reconnect = useCallback((key: number) => {
        lanShellEnders.get(key)?.();
        setSessions((prev) => prev.map((s) => (s.key === key ? { ...s, status: "connecting", attempt: s.attempt + 1, shellId: null } : s)));
    }, []);

    const select = useCallback((key: number) => {
        setActiveKey(key);
        setSize((v) => (v === "min" ? "normal" : v));
    }, []);

    return { sessions, activeKey, size, open, duplicate, close, closeAll, setStatus, setShell, reconnect, select, setSize };
}
