"use client";

/**
 * 使用者自訂的終端機配色(`/api/user/terminal-schemes`):一份模組層的清單,第一個用到的 hook 向後端拿一次,
 * 之後的新增 / 修改 / 刪除都先改本機再寫後端。localStorage(`telepy.terminalSchemes`)有一份快取,所以終端機
 * 一開就是對的配色、不用等後端;SSR 一律空清單。每個會查配色的地方(終端機頁、區網終端機、錄影播放器、預覽、
 * 偏好設定)都透過 useTerminalAppearance / 這個 hook 拿到同一份,讓 terminalScheme() 查得到自訂的 id。
 * User-defined terminal schemes: one module-level list, fetched once by the first hook that needs it; create /
 * update / delete change it locally first and then write to the backend. A localStorage cache means a terminal
 * opens with the right custom scheme without waiting; SSR sees an empty list. Every scheme lookup (terminal page,
 * LAN terminals, cast player, previews, preferences) goes through useTerminalAppearance / this hook, so
 * terminalScheme() can find custom ids.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/api";
import type { TerminalScheme } from "@/lib/terminalAppearance";
import { customToScheme, parseCustomSchemes, type CustomScheme, type SchemeColors } from "@/lib/terminalSchemes";

const KEY = "telepy.terminalSchemes";
const EVENT = "telepy:terminal-schemes";
const EMPTY: TerminalScheme[] = [];

let raw: string | null = null;
let converted: { raw: string | null; customs: CustomScheme[]; schemes: TerminalScheme[] } | null = null;
let fetched = false;
let inflight: Promise<void> | null = null;

function readRaw(): string | null {
    if (raw !== null) return raw;
    try { raw = localStorage.getItem(KEY); } catch { raw = null; }
    return raw;
}

function write(list: CustomScheme[]) {
    raw = JSON.stringify(list);
    try { localStorage.setItem(KEY, raw); } catch { /* 記憶體裡有 / memory has it */ }
    window.dispatchEvent(new Event(EVENT));
}

function snapshot(): TerminalScheme[] {
    const r = readRaw();
    if (converted && converted.raw === r) return converted.schemes;
    let customs: CustomScheme[] = [];
    if (r) {
        try { customs = parseCustomSchemes(JSON.parse(r)); } catch { customs = []; }
    }
    converted = { raw: r, customs, schemes: customs.map(customToScheme) };
    return converted.schemes;
}

function customs(): CustomScheme[] {
    snapshot();
    return converted?.customs ?? [];
}

function subscribe(onChange: () => void) {
    window.addEventListener(EVENT, onChange);
    const onStorage = (e: StorageEvent) => {
        if (e.key === KEY) { raw = null; onChange(); }
    };
    window.addEventListener("storage", onStorage);
    return () => {
        window.removeEventListener(EVENT, onChange);
        window.removeEventListener("storage", onStorage);
    };
}

/** 向後端拿一次(已登入時);失敗就留著快取。/ Fetch once when signed in; a failure keeps the cache. */
function fetchOnce(): Promise<void> {
    if (fetched) return Promise.resolve();
    if (inflight) return inflight;
    let token: string | null = null;
    try { token = localStorage.getItem("accessToken"); } catch { /* no storage */ }
    if (!token) return Promise.resolve();
    inflight = apiFetch("/api/user/terminal-schemes")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
            if (data) { fetched = true; write(parseCustomSchemes(data)); }
        })
        .catch(() => { })
        .finally(() => { inflight = null; });
    return inflight;
}

/** 登出 / 換帳號時清掉(由 AuthProvider 呼叫)。/ Forget the list on sign-out (called by AuthProvider). */
export function resetTerminalSchemes() {
    fetched = false;
    raw = null;
    converted = null;
    try { localStorage.removeItem(KEY); } catch { /* noop */ }
    window.dispatchEvent(new Event(EVENT));
}

/** 只讀:自訂配色(已轉成 TerminalScheme)。/ Read-only: the custom schemes as TerminalSchemes. */
export function useCustomSchemes(): TerminalScheme[] {
    const schemes = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
    useEffect(() => { void fetchOnce(); }, []);
    return schemes;
}

export interface TerminalSchemesApi {
    schemes: TerminalScheme[];
    customs: CustomScheme[];
    create: (name: string, colors: SchemeColors) => Promise<CustomScheme>;
    update: (id: string, patch: { name?: string; colors?: SchemeColors }) => Promise<CustomScheme>;
    remove: (id: string) => Promise<void>;
}

/** 錯誤訊息:後端的 `{field: [msg]}` / `{error}`,否則 HTTP 狀態。/ The backend's message, else the status. */
async function failure(r: Response): Promise<Error> {
    try {
        const body = await r.json();
        if (body && typeof body === "object") {
            if (typeof body.error === "string") return Object.assign(new Error(body.error), { code: body.code });
            const first = Object.values(body).find((v) => Array.isArray(v) && typeof v[0] === "string") as string[] | undefined;
            if (first) return new Error(first[0]);
        }
    } catch { /* not JSON */ }
    return new Error(`HTTP ${r.status}`);
}

/** 讀 + 寫。/ Read and write. */
export function useTerminalSchemes(): TerminalSchemesApi {
    const schemes = useCustomSchemes();
    const create = useCallback(async (name: string, colors: SchemeColors) => {
        const r = await apiFetch("/api/user/terminal-schemes", { method: "POST", body: JSON.stringify({ name, colors }) });
        if (!r.ok) throw await failure(r);
        const [made] = parseCustomSchemes([await r.json()]);
        if (!made) throw new Error("bad response");
        write([...customs(), made]);
        return made;
    }, []);
    const update = useCallback(async (id: string, patch: { name?: string; colors?: SchemeColors }) => {
        const r = await apiFetch(`/api/user/terminal-schemes/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
        if (!r.ok) throw await failure(r);
        const [made] = parseCustomSchemes([await r.json()]);
        if (!made) throw new Error("bad response");
        write(customs().map((c) => (c.id === id ? made : c)));
        return made;
    }, []);
    const remove = useCallback(async (id: string) => {
        const r = await apiFetch(`/api/user/terminal-schemes/${id}`, { method: "DELETE" });
        if (!r.ok && r.status !== 404) throw await failure(r);
        write(customs().filter((c) => c.id !== id));
    }, []);
    return { schemes, customs: customs(), create, update, remove };
}
