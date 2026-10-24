"use client";

/**
 * 一行指令加入裝置（#14）：發 join 指令、顯示倒數、追進度（每 2 秒查一次 + `JOIN-UPDATED` 通知）。
 * One-command device join: mint the command, count down its expiry and follow the progress
 * (a 2 s poll plus `JOIN-UPDATED` notifications).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { useNotificationHandlers, useTunnelConnectionWebSocket } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS, type NotificationPayload } from "@/lib/notificationActions";
import { useI18n } from "@/lib/i18n";

export type JoinPhase = "waiting" | "registered" | "connected" | "verified" | "failed";

export interface JoinTicket {
    id: string;
    name: string | null;
    key_list_mine: boolean;
    phase: JoinPhase;
    detail: string | null;
    tunnel_id: number | null;
    tunnel_name: string | null;
    reverse_port: number | null;
    username: string | null;
    ssh_port: number | null;
    hostname: string | null;
    os: string | null;
    /** 這台機器已經是我的另一條隧道（同一組 SSH host key）。/ My other tunnel on this very machine (same host key). */
    same_machine_as: { id: number; name: string } | null;
    created_at: string;
    expires_at: string;
}

export interface JoinCommand extends JoinTicket {
    token: string;
    install_url: string;
    command: string;
    command_no_sudo: string;
}

const DONE: JoinPhase[] = ["verified", "failed"];

export function useDeviceJoin() {
    const { t } = useI18n();
    const [name, setName] = useState("");
    const [keyList, setKeyList] = useState<"mine" | "empty">("mine");
    const [myKeyCount, setMyKeyCount] = useState<number | null>(null);
    const [creating, setCreating] = useState(false);
    const [nameError, setNameError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [ticket, setTicket] = useState<JoinCommand | null>(null);
    const [expired, setExpired] = useState(false);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        let cancelled = false;
        apiFetch("/api/reverse/user/keys")
            .then((r) => (r.ok ? readJson<unknown[]>(r) : null))
            .then((list) => { if (!cancelled) setMyKeyCount(Array.isArray(list) ? list.length : 0); })
            .catch(() => { if (!cancelled) setMyKeyCount(0); });
        return () => { cancelled = true; };
    }, []);

    const create = useCallback(async () => {
        setCreating(true);
        setError(null);
        setNameError(null);
        try {
            const res = await apiFetch("/api/reverse/join", {
                method: "POST",
                body: JSON.stringify({ name: name.trim() || undefined, key_list: keyList === "mine" && (myKeyCount ?? 0) > 0 ? "mine" : "empty" }),
            });
            const data = await readJson<JoinCommand & { name?: string[] | string | null; error?: string; code?: string }>(res);
            if (res.ok && data?.token) {
                setTicket(data);
                setExpired(false);
                setNow(Date.now());
                return;
            }
            if (Array.isArray(data?.name)) setNameError(data.name[0]);
            else if (data?.code === "too_many_join_tokens") setError(t("join.tooMany"));
            else setError(data?.error ?? t("api.unexpectedError"));
        } catch {
            setError(t("api.unexpectedError"));
        } finally {
            setCreating(false);
        }
    }, [name, keyList, myKeyCount, t]);

    const refresh = useCallback(async (id: string) => {
        try {
            const res = await apiFetch(`/api/reverse/join/${id}`);
            if (res.status === 404) {
                setExpired(true);
                return;
            }
            const data = await readJson<JoinTicket>(res);
            if (res.ok && data) setTicket((prev) => (prev && prev.id === data.id ? { ...prev, ...data } : prev));
        } catch { /* 下次再查 / next tick */ }
    }, []);

    // 進行中：每 2 秒查一次，倒數每秒更新。/ While in progress: poll every 2 s and tick the countdown.
    const ticketId = ticket?.id ?? null;
    const finished = !ticket || expired || DONE.includes(ticket.phase);
    useEffect(() => {
        if (!ticketId || finished) return;
        const poll = setInterval(() => void refresh(ticketId), 2000);
        const tick = setInterval(() => setNow(Date.now()), 1000);
        return () => { clearInterval(poll); clearInterval(tick); };
    }, [ticketId, finished, refresh]);

    const handlers = useMemo(() => ({
        [NOTIFICATION_ACTIONS.JOIN_UPDATED]: (msg: NotificationPayload) => {
            if (ticketId && msg.join_id === ticketId) void refresh(ticketId);
        },
    }), [ticketId, refresh]);
    useNotificationHandlers(handlers);

    const cancel = useCallback(async () => {
        if (ticket) await apiFetch(`/api/reverse/join/${ticket.id}`, { method: "DELETE" }).catch(() => undefined);
        setTicket(null);
        setExpired(false);
    }, [ticket]);

    /** 再來一台（保留選項）。/ Start over, keeping the options. */
    const reset = useCallback(() => {
        setTicket(null);
        setExpired(false);
        setError(null);
    }, []);

    const msLeft = ticket ? new Date(ticket.expires_at).getTime() - now : 0;
    const waitingExpired = !!ticket && ticket.phase === "waiting" && msLeft <= 0;

    // 連上後的即時延遲（給拓撲圖）。/ Live RTT once the tunnel exists (for the diagram).
    const { status } = useTunnelConnectionWebSocket(ticket?.tunnel_id ? String(ticket.tunnel_id) : null);
    const rttMs: number | null = typeof status?.rtt_ms === "number" ? status.rtt_ms : null;

    return {
        form: { name, setName, keyList, setKeyList, myKeyCount, creating, nameError, error },
        ticket,
        expired: expired || waitingExpired,
        msLeft: Math.max(0, msLeft),
        rttMs,
        actions: { create, cancel, reset },
    };
}

export type DeviceJoin = ReturnType<typeof useDeviceJoin>;
