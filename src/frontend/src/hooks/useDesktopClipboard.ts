"use client";

/**
 * 遠端桌面剪貼簿的個人選擇（`/api/user/settings` 的 `desktop_clipboard`）＋站台上限（`desktop_clipboard_limit`，唯讀）。
 * 桌面頁的表單和偏好設定共用一份（模組層的 store），每次有元件掛上就重讀一次（管理員可能改了上限）。
 * 還沒讀到之前 `loaded` 是 false：這時連線不要帶 `clipboard`，讓後端用存著的值。
 * The user's remote-desktop clipboard choice plus the site's ceiling. The desktop form and Preferences share one
 * module-level store, re-read whenever a consumer mounts (an admin may have changed the limit). Until `loaded`,
 * starts should omit `clipboard` so the backend uses the saved value.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { clipboardWithin, isClipboardPolicy, type ClipboardPolicy } from "@/lib/desktop";

type SettingsReply = { desktop_clipboard?: unknown; desktop_clipboard_limit?: unknown };

interface ClipboardPref {
    choice: ClipboardPolicy;
    limit: ClipboardPolicy;
    loaded: boolean;
}

const INITIAL: ClipboardPref = { choice: "both", limit: "both", loaded: false };
let current: ClipboardPref = INITIAL;
const listeners = new Set<() => void>();

function publish(next: ClipboardPref) {
    current = next;
    listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** 後端回應 → store（不認得的值不動）。/ Apply a settings response; unknown values are ignored. */
function accept(data: SettingsReply | null) {
    if (!data) return;
    publish({
        choice: isClipboardPolicy(data.desktop_clipboard) ? data.desktop_clipboard : current.choice,
        limit: isClipboardPolicy(data.desktop_clipboard_limit) ? data.desktop_clipboard_limit : current.limit,
        loaded: true,
    });
}

let inflight: Promise<void> | null = null;
function load(): Promise<void> {
    inflight ??= apiFetch("/api/user/settings")
        .then(async (res) => accept(res.ok ? await readJson<SettingsReply>(res) : null))
        .catch(() => undefined)
        .finally(() => {
            inflight = null;
        });
    return inflight;
}

export function useDesktopClipboard() {
    const pref = useSyncExternalStore(subscribe, () => current, () => INITIAL);
    useEffect(() => {
        void load();
    }, []);
    const setChoice = useCallback(async (choice: ClipboardPolicy) => {
        const before = current;
        publish({ ...current, choice });
        try {
            const res = await apiFetch("/api/user/settings", { method: "POST", body: JSON.stringify({ desktop_clipboard: choice }) });
            if (res.ok) accept(await readJson<SettingsReply>(res));
            else publish(before);
        } catch {
            publish(before);
        }
    }, []);
    return {
        ...pref,
        /** 實際會用的方向（選擇套上上限）。/ What a new session will get. */
        effective: clipboardWithin(pref.choice, pref.limit),
        setChoice,
    };
}
