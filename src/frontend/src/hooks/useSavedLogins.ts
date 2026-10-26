"use client";

/**
 * 憑證庫（遠端桌面的登入）：列出自己存的（可依桌面篩選）、新增、刪除。密碼只送出、從不取回 —— 例外是 RustDesk：
 * `…/rustdesk/start` 帶 `credential_id` 時後端解開後交給瀏覽器裡的核心（挑戰回應在瀏覽器做）。經 Telepy RustDesk
 * 伺服器的裝置沒有隧道，存的密碼綁 `rustdesk_device_id`（`tunnel_id` = 0）。
 * RustDesk-server devices have no tunnel: their saved passwords are bound to `rustdesk_device_id` instead.
 * The credential vault: list your saved desktop logins (optionally for one desktop), add, delete.
 * Passwords are only ever sent, never read back.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import type { DesktopMode } from "@/lib/desktop";

export interface SavedLogin {
    id: number;
    label: string;
    /** rdp / vnc（guacd）或 rustdesk（瀏覽器裡的核心）。/ rdp / vnc (guacd) or rustdesk (the in-browser core). */
    protocol: DesktopMode;
    tunnel_id: number;
    tunnel_name: string | null;
    lan_host_id: number | null;
    lan_host: string | null;
    /** Telepy RustDesk 伺服器上的裝置（沒有隧道）。/ A RustDesk-server device (no tunnel). */
    rustdesk_device_id: number | null;
    rustdesk_device: string | null;
    port: number | null;
    login: string;
    domain: string;
    has_password: boolean;
    created_at: string;
    last_used_at: string | null;
}

/** 隧道上的桌面（隧道 + 主機 + 協定），或 RustDesk 伺服器上的一台裝置。/ A desktop behind a tunnel, or a RustDesk-server device. */
export type SavedLoginFilter = { tunnelId: number; hostId: number | null; protocol: DesktopMode } | { deviceId: number };

export interface NewSavedLogin {
    label: string;
    protocol: DesktopMode;
    tunnel_id: number;
    lan_host_id: number | null;
    port: number | null;
    login: string;
    domain: string;
    password: string;
    rustdesk_device_id?: number;
}

/** 任一處新增／刪除後通知其他 hook 重新載入（偏好設定刪了，桌面頁的選單也要跟著更新）。
 *  Fired after an add / delete so every other instance reloads (deleting in Preferences updates the desktop page). */
const CHANGED = "telepy:saved-logins-changed";

function notifyChanged() {
    window.dispatchEvent(new Event(CHANGED));
}

function query(f: SavedLoginFilter | null): string {
    if (!f) return "";
    if ("deviceId" in f) return `?rustdesk_device_id=${f.deviceId}`;
    const p = new URLSearchParams({ tunnel_id: String(f.tunnelId), protocol: f.protocol });
    if (f.hostId) p.set("lan_host_id", String(f.hostId));
    return `?${p.toString()}`;
}

export function useSavedLogins(filter: SavedLoginFilter | null, enabled = true) {
    const key = query(filter);
    const [result, setResult] = useState<{ key: string; list: SavedLogin[] } | null>(null);

    const fetchList = useCallback(async (): Promise<SavedLogin[]> => {
        try {
            const res = await apiFetch(`/api/credentials${key}`);
            const data = await readJson<SavedLogin[]>(res);
            return res.ok && Array.isArray(data) ? data : [];
        } catch {
            return [];
        }
    }, [key]);

    const reload = useCallback(async () => {
        const list = await fetchList();
        setResult({ key, list });
    }, [fetchList, key]);

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        (async () => {
            const list = await fetchList();
            if (!cancelled) setResult({ key, list });
        })();
        const onChanged = () => {
            void (async () => {
                const list = await fetchList();
                if (!cancelled) setResult({ key, list });
            })();
        };
        window.addEventListener(CHANGED, onChanged);
        return () => {
            cancelled = true;
            window.removeEventListener(CHANGED, onChanged);
        };
    }, [enabled, fetchList, key]);

    /** 新增；成功回那一筆，失敗回錯誤訊息。/ Add one; returns the row or an error message. */
    const create = useCallback(async (body: NewSavedLogin): Promise<SavedLogin | string> => {
        const res = await apiFetch("/api/credentials", { method: "POST", body: JSON.stringify(body) });
        const data = await readJson<SavedLogin>(res);
        if (!res.ok || !data) return responseError(res, data, "");
        notifyChanged();
        return data;
    }, []);

    const remove = useCallback(async (id: number): Promise<boolean> => {
        const res = await apiFetch(`/api/credentials/${id}`, { method: "DELETE" });
        if (res.ok) notifyChanged();
        return res.ok;
    }, []);

    return { list: result && result.key === key ? result.list : [], loaded: !!result && result.key === key, reload, create, remove };
}
