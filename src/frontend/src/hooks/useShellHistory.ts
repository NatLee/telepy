"use client";

/**
 * 個人預設：Telepy 的 shell 打的指令寫不寫進裝置的歷史檔（`/api/user/settings` 的 `shell_history`）。偏好設定與
 * 隧道詳細資訊共用一份（模組層的 store，有元件掛上就重讀一次）；localStorage `telepy.shellHistory` 給第一次畫面用。
 * The personal default for keeping commands out of the device's shell history, shared by Preferences and the tunnel
 * details (a module-level store, re-read when a consumer mounts); mirrored in localStorage for the first paint.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { isHistoryMode, type HistoryMode } from "@/lib/shellHistory";

type SettingsReply = { shell_history?: unknown };

interface Pref {
    mode: HistoryMode;
    loaded: boolean;
}

const STORAGE_KEY = "telepy.shellHistory";
const INITIAL: Pref = { mode: "keep", loaded: false };
let current: Pref = INITIAL;
let hydrated = false;
const listeners = new Set<() => void>();

function publish(next: Pref) {
    current = next;
    try {
        localStorage.setItem(STORAGE_KEY, next.mode);
    } catch { /* 無痕 / 被擋 / unavailable */ }
    listeners.forEach((l) => l());
}

function hydrate() {
    if (hydrated) return;
    hydrated = true;
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        if (isHistoryMode(v)) current = { mode: v, loaded: false };
    } catch { /* 沒有 / none */ }
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function accept(data: SettingsReply | null) {
    if (!data) return;
    publish({ mode: isHistoryMode(data.shell_history) ? data.shell_history : current.mode, loaded: true });
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

export function useShellHistory() {
    const pref = useSyncExternalStore(subscribe, () => {
        hydrate();
        return current;
    }, () => INITIAL);
    useEffect(() => {
        void load();
    }, []);
    /** 存到帳號上；失敗就退回原值並回 false。/ Save on the account; on failure roll back and return false. */
    const setMode = useCallback(async (mode: HistoryMode): Promise<boolean> => {
        const before = current;
        publish({ ...current, mode });
        try {
            const res = await apiFetch("/api/user/settings", { method: "POST", body: JSON.stringify({ shell_history: mode }) });
            if (res.ok) {
                accept(await readJson<SettingsReply>(res));
                return true;
            }
        } catch { /* 網路 / network */ }
        publish(before);
        return false;
    }, []);
    return { ...pref, setMode };
}
