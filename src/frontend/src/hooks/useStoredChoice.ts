/**
 * 存在 localStorage 的單選偏好（排序方式之類）：SSR 用預設值，hydration 後讀實際值（useSyncExternalStore，
 * 不會有 mismatch 警告），值不在允許清單裡就回預設。
 * A single-choice preference kept in localStorage (sort order and the like). SSR renders the default; the
 * client value takes over after hydration via useSyncExternalStore; unknown stored values fall back.
 */
import { useCallback, useSyncExternalStore } from "react";

const EVENT = "telepy:stored-choice";

function subscribe(callback: () => void) {
    window.addEventListener(EVENT, callback);
    window.addEventListener("storage", callback);
    return () => {
        window.removeEventListener(EVENT, callback);
        window.removeEventListener("storage", callback);
    };
}

export function useStoredChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): [T, (v: T) => void] {
    const read = () => {
        try {
            const v = localStorage.getItem(key);
            return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
        } catch {
            return fallback;
        }
    };
    const value = useSyncExternalStore(subscribe, read, () => fallback);
    const set = useCallback(
        (v: T) => {
            try {
                localStorage.setItem(key, v);
            } catch {
                // 私密模式等寫不進去：這次就不記。/ Storage blocked: just don't remember it.
            }
            window.dispatchEvent(new Event(EVENT));
        },
        [key],
    );
    return [value, set];
}
