/**
 * 網路頁底部終端機 dock 的 session 清單：每台區網主機（+ 登入帳號 + 經過的裝置帳號）一個分頁，換主機也不會斷。
 * Session list for the network page's terminal dock: one tab per LAN host login, kept while you browse.
 */
import { useCallback, useState } from "react";

export const MAX_LAN_TERMINALS = 6;

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
    status: LanTerminalStatus;
    /** 每次重連 +1，讓終端機元件重開連線。/ Bumped on reconnect so the terminal reopens. */
    attempt: number;
}

export function useLanTerminals() {
    const [sessions, setSessions] = useState<LanTerminalSession[]>([]);
    const [activeKey, setActiveKey] = useState<number | null>(null);
    const [size, setSize] = useState<DockSize>("normal");
    const [nextKey, setNextKey] = useState(1);

    const open = useCallback((s: Omit<LanTerminalSession, "key" | "status" | "attempt">): boolean => {
        if (sessions.length >= MAX_LAN_TERMINALS) return false;
        const key = nextKey;
        setNextKey(key + 1);
        setSessions((prev) => [...prev, { ...s, key, status: "connecting", attempt: 0 }]);
        setActiveKey(key);
        setSize((v) => (v === "min" ? "normal" : v));
        return true;
    }, [sessions.length, nextKey]);

    /** 同一台機器再開一個 shell（dock 的「+」）。/ Another shell on the same machine (the dock's "+"). */
    const duplicate = useCallback((key: number): boolean => {
        const src = sessions.find((s) => s.key === key);
        if (!src) return false;
        const { tunnelId, tunnelName, reversePort, hostId, hostName, login, deviceUser } = src;
        return open({ tunnelId, tunnelName, reversePort, hostId, hostName, login, deviceUser });
    }, [sessions, open]);

    const close = useCallback((key: number) => {
        setSessions((prev) => {
            const rest = prev.filter((s) => s.key !== key);
            setActiveKey((cur) => (cur === key ? rest[rest.length - 1]?.key ?? null : cur));
            return rest;
        });
    }, []);

    const closeAll = useCallback(() => {
        setSessions([]);
        setActiveKey(null);
    }, []);

    const setStatus = useCallback((key: number, status: LanTerminalStatus) => {
        setSessions((prev) => prev.map((s) => (s.key === key && s.status !== status ? { ...s, status } : s)));
    }, []);

    const reconnect = useCallback((key: number) => {
        setSessions((prev) => prev.map((s) => (s.key === key ? { ...s, status: "connecting", attempt: s.attempt + 1 } : s)));
    }, []);

    const select = useCallback((key: number) => {
        setActiveKey(key);
        setSize((v) => (v === "min" ? "normal" : v));
    }, []);

    return { sessions, activeKey, size, open, duplicate, close, closeAll, setStatus, reconnect, select, setSize };
}
