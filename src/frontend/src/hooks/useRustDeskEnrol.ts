"use client";

/**
 * 新增 RustDesk 裝置：發一次性登記指令（`rustdesk --deploy --token …`）、倒數、追進度（每 2 秒查一次 +
 * `RUSTDESK-DEVICES-UPDATED` 通知）：等指令 → 已登記 → 已連上。
 * Add a RustDesk device: mint a one-time enrolment command, count down its expiry and follow it
 * (a 2 s poll plus notifications): waiting → enrolled → online.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS, type NotificationPayload } from "@/lib/notificationActions";
import { useI18n } from "@/lib/i18n";
import type { RustDeskEnrolment, RustDeskEnrolmentCreated } from "@/lib/rustdeskDevices";

export function useRustDeskEnrol() {
    const { t } = useI18n();
    const [name, setName] = useState("");
    const [creating, setCreating] = useState(false);
    const [nameError, setNameError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [ticket, setTicket] = useState<RustDeskEnrolmentCreated | null>(null);
    const [gone, setGone] = useState(false);
    const [now, setNow] = useState(() => Date.now());

    const create = useCallback(async () => {
        setCreating(true);
        setError(null);
        setNameError(null);
        try {
            const res = await apiFetch("/api/rustdesk/enroll", { method: "POST", body: JSON.stringify({ name: name.trim() || undefined }) });
            const data = await readJson<RustDeskEnrolmentCreated & { name?: string[] | string | null; error?: string; code?: string }>(res);
            if (res.ok && data?.token) {
                setTicket(data);
                setGone(false);
                setNow(Date.now());
                return;
            }
            if (Array.isArray(data?.name)) setNameError(data.name[0]);
            else if (data?.code === "too_many_enrolments") setError(t("rustdesk.enrol.tooMany"));
            else if (data?.code === "rustdesk_server_disabled") setError(t("rustdesk.serverOff"));
            else setError(data?.error ?? t("api.unexpectedError"));
        } catch {
            setError(t("api.unexpectedError"));
        } finally {
            setCreating(false);
        }
    }, [name, t]);

    const refresh = useCallback(async (id: string) => {
        try {
            const res = await apiFetch(`/api/rustdesk/enroll/${id}`);
            if (res.status === 404) {
                setGone(true);
                return;
            }
            const data = await readJson<RustDeskEnrolment>(res);
            if (res.ok && data) setTicket((prev) => (prev && prev.id === data.id ? { ...prev, ...data } : prev));
        } catch { /* 下次再查 / next tick */ }
    }, []);

    const ticketId = ticket?.id ?? null;
    const finished = !ticket || gone || ticket.phase === "online";
    useEffect(() => {
        if (!ticketId || finished) return;
        const poll = setInterval(() => void refresh(ticketId), 2000);
        const tick = setInterval(() => setNow(Date.now()), 1000);
        return () => { clearInterval(poll); clearInterval(tick); };
    }, [ticketId, finished, refresh]);

    const handlers = useMemo(() => ({
        [NOTIFICATION_ACTIONS.RUSTDESK_DEVICES_UPDATED]: (msg: NotificationPayload) => {
            if (ticketId && msg.enroll_id === ticketId) void refresh(ticketId);
        },
    }), [ticketId, refresh]);
    useNotificationHandlers(handlers);

    const cancel = useCallback(async () => {
        if (ticket && ticket.phase === "waiting") await apiFetch(`/api/rustdesk/enroll/${ticket.id}`, { method: "DELETE" }).catch(() => undefined);
        setTicket(null);
        setGone(false);
    }, [ticket]);

    const reset = useCallback(() => {
        setTicket(null);
        setGone(false);
        setError(null);
        setName("");
    }, []);

    const msLeft = ticket ? new Date(ticket.expires_at).getTime() - now : 0;
    const expired = !!ticket && ticket.phase === "waiting" && (gone || msLeft <= 0);

    return {
        form: { name, setName, creating, nameError, error },
        ticket,
        expired,
        msLeft: Math.max(0, msLeft),
        actions: { create, cancel, reset },
    };
}

export type RustDeskEnrol = ReturnType<typeof useRustDeskEnrol>;
