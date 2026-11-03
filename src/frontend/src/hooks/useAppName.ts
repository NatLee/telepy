/**
 * 這台 Telepy 裝成 app 時的名稱（網站設定「App 名稱」：Telepy / 網域 / 自訂），從公開的 manifest 讀，通知的標題用它。
 * localStorage 留一份，第一次畫面就是對的；網站設定存檔後呼叫 `refreshAppName()`。
 * This Telepy's app name (the "App name" site setting: Telepy / the domain / custom), read from the public manifest;
 * notification titles use it. A copy in localStorage makes the first paint right; the site settings call
 * `refreshAppName()` after a save.
 */
import { useEffect, useSyncExternalStore } from "react";
import { DEFAULT_APP_NAME } from "@/lib/installApp";

const KEY = "telepy.appName";
const MANIFEST = "/api/app/manifest.webmanifest";

let current: string | null = null;
let fetched = false;
const listeners = new Set<() => void>();

function read(): string {
    if (current !== null) return current;
    try {
        current = localStorage.getItem(KEY) || DEFAULT_APP_NAME;
    } catch {
        current = DEFAULT_APP_NAME;
    }
    return current;
}

function set(name: string) {
    if (name === current) return;
    current = name;
    try {
        localStorage.setItem(KEY, name);
    } catch {
        /* 只是快取 / only a cache */
    }
    listeners.forEach((l) => l());
}

/** 重新讀 manifest（公開，不帶登入）。/ Re-read the manifest (public, no credentials). */
export async function refreshAppName(): Promise<void> {
    fetched = true;
    try {
        const res = await fetch(MANIFEST, { cache: "no-store", credentials: "omit" });
        if (!res.ok) return;
        const m = (await res.json()) as { name?: unknown };
        if (typeof m.name === "string" && m.name.trim()) set(m.name);
    } catch {
        /* 讀不到就用快取的 / keep the cached one */
    }
}

/** React 以外（通知）用。/ For code outside React (notifications). */
export function currentAppName(): string {
    return typeof window === "undefined" ? DEFAULT_APP_NAME : read();
}

export function useAppName(): string {
    const name = useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        read,
        () => DEFAULT_APP_NAME,
    );
    useEffect(() => {
        if (!fetched) void refreshAppName();
    }, []);
    return name;
}
