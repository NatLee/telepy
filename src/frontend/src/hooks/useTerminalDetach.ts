"use client";

/**
 * 網頁終端機斷線保留的個人選擇（`/api/user/settings` 的 `terminal_detach_secs`）＋站台上限（`terminal_detach_max_secs`，唯讀）。
 * 偏好設定、終端機頁與網路頁的說明圖共用一份（模組層的 store），有元件掛上就重讀一次（管理員可能改了上限）。
 * localStorage `telepy.terminalDetach` 存一份，讀到伺服器之前先用它（這台瀏覽器上次看到的值）。
 * The user's web terminal detach choice plus the site's ceiling, shared by Preferences, the terminal page and the
 * network page (a module-level store, re-read when a consumer mounts). Mirrored in localStorage for the first paint.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { effectiveDetach, isDetachChoice, type DetachChoice } from "@/lib/terminalDetach";

type SettingsReply = { terminal_detach_secs?: unknown; terminal_detach_max_secs?: unknown };

interface DetachPref {
    choice: DetachChoice;
    limit: number;
    loaded: boolean;
}

const STORAGE_KEY = "telepy.terminalDetach";
const INITIAL: DetachPref = { choice: 0, limit: 1800, loaded: false };
let current: DetachPref = INITIAL;
let hydrated = false;
const listeners = new Set<() => void>();

function publish(next: DetachPref) {
    current = next;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ choice: next.choice, limit: next.limit }));
    } catch { /* 無痕 / 被擋 / unavailable */ }
    listeners.forEach((l) => l());
}

/** 第一次用時從 localStorage 補上次的值。/ On first use, start from the last value this browser saw. */
function hydrate() {
    if (hydrated) return;
    hydrated = true;
    try {
        const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as { choice?: unknown; limit?: unknown } | null;
        if (v) current = { choice: isDetachChoice(v.choice) ? v.choice : 0, limit: typeof v.limit === "number" ? v.limit : INITIAL.limit, loaded: false };
    } catch { /* 沒有 / none */ }
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function accept(data: SettingsReply | null) {
    if (!data) return;
    publish({
        choice: isDetachChoice(data.terminal_detach_secs) ? data.terminal_detach_secs : current.choice,
        limit: typeof data.terminal_detach_max_secs === "number" ? data.terminal_detach_max_secs : current.limit,
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

export function useTerminalDetach() {
    const pref = useSyncExternalStore(subscribe, () => {
        hydrate();
        return current;
    }, () => INITIAL);
    useEffect(() => {
        void load();
    }, []);
    const setChoice = useCallback(async (choice: DetachChoice) => {
        const before = current;
        publish({ ...current, choice });
        try {
            const res = await apiFetch("/api/user/settings", { method: "POST", body: JSON.stringify({ terminal_detach_secs: choice }) });
            if (res.ok) accept(await readJson<SettingsReply>(res));
            else publish(before);
        } catch {
            publish(before);
        }
    }, []);
    return {
        ...pref,
        /** 套上站台上限之後（不含裝置政策）。/ After the site ceiling (without a device's policy). */
        effective: effectiveDetach(pref.choice, pref.limit),
        setChoice,
    };
}
