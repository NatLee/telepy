"use client";

/**
 * 站內通知偏好（`/api/notifications/preferences`）：一份模組層的資料，登入後第一個用到的人向後端拿一次，
 * 改了之後先改本機再寫後端（後端回的整份再蓋上去），登出時清掉。`shouldNotify` / `allowNotification` 是給
 * 通知處理函式用的同步檢查（還沒載入 = 照舊顯示）。
 * In-app notification preferences: one module-level copy, fetched once per sign-in by the first user; a change
 * updates it locally, then writes to the backend (whose full answer replaces it); cleared on sign-out.
 * `shouldNotify` / `allowNotification` are the synchronous checks the notification handlers use (not loaded
 * yet = shown as before).
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { apiFetch, readJson } from "@/lib/api";
import {
    applyMine,
    applyMute,
    notificationKind,
    notificationTunnel,
    parsePrefs,
    shouldShow,
    type MuteScope,
    type NotifyChannel,
    type NotifyPrefs,
} from "@/lib/notifyPrefs";

let current: NotifyPrefs | null = null;
let fetched = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: NotifyPrefs | null) {
    current = next;
    listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
}

function load(force = false): Promise<void> {
    if ((fetched && !force) || inflight) return inflight ?? Promise.resolve();
    let token: string | null = null;
    try { token = localStorage.getItem("accessToken"); } catch { /* no storage */ }
    if (!token) return Promise.resolve();
    inflight = apiFetch("/api/notifications/preferences")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
            const p = parsePrefs(data);
            if (p) { fetched = true; set(p); }
        })
        .catch(() => { })
        .finally(() => { inflight = null; });
    return inflight;
}

/** 登出 / 換帳號時清掉（AuthProvider 呼叫）。/ Forget them on sign-out (called by AuthProvider). */
export function resetNotifyPrefs() {
    fetched = false;
    set(null);
}

/** 這個事件 × 管道（這條隧道）要不要提示。/ Whether to show this event on this channel (for this tunnel). */
export function shouldNotify(kind: string | null, channel: NotifyChannel, tunnelId?: number | null): boolean {
    return shouldShow(current, kind, channel, tunnelId);
}

/** 用通知本身判斷（事件與隧道從 action / tunnel_id 來）。/ Decide from the notification itself. */
export function allowNotification(msg: { action?: string; [k: string]: unknown }, channel: NotifyChannel, tunnelId?: number | null): boolean {
    return shouldNotify(notificationKind(msg), channel, tunnelId ?? notificationTunnel(msg));
}

/** 掛在 AppLayout：登入後載入一次。/ Mounted in AppLayout: loads once after sign-in. */
export function useNotifyPrefsLoader(signedIn: boolean) {
    useEffect(() => {
        if (signedIn) void load();
    }, [signedIn]);
}

async function failure(r: Response): Promise<Error> {
    const body = (await readJson(r)) as { error?: string; code?: string } | null;
    return Object.assign(new Error(body?.error || `HTTP ${r.status}`), { code: body?.code });
}

export interface NotifyPrefsApi {
    prefs: NotifyPrefs | null;
    reload: () => Promise<void>;
    /** 我的值：true / false / null（跟全站）。/ My value: true / false / null (follow the site). */
    setMine: (changes: { event: string; channel: NotifyChannel; value: boolean | null }[]) => Promise<void>;
    setMute: (tunnelId: number, tunnelName: string, scope: MuteScope | null) => Promise<void>;
}

export function useNotifyPrefs(): NotifyPrefsApi {
    const prefs = useSyncExternalStore(subscribe, () => current, () => null);
    useEffect(() => { void load(); }, []);
    const reload = useCallback(() => load(true), []);
    const setMine = useCallback(async (changes: { event: string; channel: NotifyChannel; value: boolean | null }[]) => {
        const before = current;
        if (current) set(changes.reduce((p, c) => applyMine(p, c.event, c.channel, c.value), current));
        const r = await apiFetch("/api/notifications/preferences", {
            method: "PUT",
            body: JSON.stringify({ prefs: changes.map((c) => ({ event: c.event, channel: c.channel, value: c.value === null ? "inherit" : c.value ? "on" : "off" })) }),
        });
        if (!r.ok) {
            set(before);
            throw await failure(r);
        }
        const p = parsePrefs(await r.json());
        if (p) set(p);
    }, []);
    const setMute = useCallback(async (tunnelId: number, tunnelName: string, scope: MuteScope | null) => {
        const before = current;
        if (current) set(applyMute(current, tunnelId, tunnelName, scope));
        const r = scope
            ? await apiFetch(`/api/notifications/mute/${tunnelId}`, { method: "PUT", body: JSON.stringify({ scope }) })
            : await apiFetch(`/api/notifications/mute/${tunnelId}`, { method: "DELETE" });
        if (!r.ok) {
            set(before);
            throw await failure(r);
        }
        if (!current) void load(true);
    }, []);
    return { prefs, reload, setMine, setMute };
}
