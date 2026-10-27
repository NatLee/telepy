"use client";

/**
 * 憑證庫（遠端桌面的登入，以及區網主機 SSH 那一跳的登入）：列出自己存的（可依目標篩選）、新增、刪除。密碼 / 私鑰只送出、
 * 從不取回 —— 例外是 RustDesk：`…/rustdesk/start` 帶 `credential_id` 時後端解開後交給瀏覽器裡的核心（挑戰回應在瀏覽器做）。
 * The credential vault: your saved desktop logins and LAN-host ssh logins (optionally for one target), add, delete.
 * Passwords and keys are only ever sent, never read back.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import type { DesktopMode } from "@/lib/desktop";

/** 憑證的協定：桌面的三種，或區網主機的 ssh。/ A saved login's protocol: the three desktop ones, or ssh for a LAN host. */
export type SavedProtocol = DesktopMode | "ssh";

export interface SavedLogin {
    id: number;
    label: string;
    /** rdp / vnc（guacd）、rustdesk（瀏覽器裡的核心）或 ssh（區網主機那一跳）。/ rdp / vnc (guacd), rustdesk (the in-browser core) or ssh (the LAN hop). */
    protocol: SavedProtocol;
    tunnel_id: number;
    tunnel_name: string | null;
    lan_host_id: number | null;
    lan_host: string | null;
    port: number | null;
    login: string;
    domain: string;
    has_password: boolean;
    /** ssh：存了私鑰。/ ssh: a private key is stored. */
    has_key?: boolean;
    created_at: string;
    last_used_at: string | null;
}

export interface SavedLoginFilter {
    tunnelId: number;
    hostId: number | null;
    protocol: SavedProtocol;
}

export interface NewSavedLogin {
    label: string;
    protocol: SavedProtocol;
    tunnel_id: number;
    lan_host_id: number | null;
    port: number | null;
    login: string;
    domain: string;
    password: string;
    /** ssh：未加密的私鑰（OpenSSH / PEM）。/ ssh: an unencrypted private key. */
    private_key?: string;
}

/** 任一處新增／刪除後通知其他 hook 重新載入（偏好設定刪了，桌面頁的選單也要跟著更新）。
 *  Fired after an add / delete so every other instance reloads (deleting in Preferences updates the desktop page). */
const CHANGED = "telepy:saved-logins-changed";

function notifyChanged() {
    window.dispatchEvent(new Event(CHANGED));
}

function query(f: SavedLoginFilter | null): string {
    if (!f) return "";
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
