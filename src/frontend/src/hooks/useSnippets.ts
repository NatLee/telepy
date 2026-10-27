"use client";

/**
 * 工具箱的資料：`GET /api/snippets?tunnel_id=`（自己的 + 這條隧道的 + 全站的）、新增 / 修改 / 刪除、用了一次的計數，
 * 以及每個人自己的最愛（localStorage `telepy.toolboxFavs`，只在這個瀏覽器）。寫入之後發 `telepy:snippets-changed`，
 * 讓同一頁的其他工具箱（桌機側欄 / 手機底部面板 / 區網終端機）重新載入。
 * Toolbox data: the usable snippets for a tunnel, create / update / delete, the use counter, and per-browser
 * favourites (localStorage `telepy.toolboxFavs`). Writes fire `telepy:snippets-changed` so other toolboxes on the
 * page reload.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/api";
import { formatApiError } from "@/lib/formatApiError";
import { parseFavourites, toggleFavourite, type Snippet, type SnippetDraft, type SnippetList, type SnippetScope } from "@/lib/snippets";

const CHANGED = "telepy:snippets-changed";
const FAV_KEY = "telepy.toolboxFavs";
const FAV_EVENT = "telepy:toolbox-favs";
const NO_FAVS: number[] = [];

let favRaw: string | null | undefined;
let favParsed: number[] = NO_FAVS;

function favSnapshot(): number[] {
    let r: string | null = null;
    try { r = localStorage.getItem(FAV_KEY); } catch { r = null; }
    if (r !== favRaw) {
        favRaw = r;
        favParsed = parseFavourites(r);
    }
    return favParsed;
}

function favSubscribe(cb: () => void) {
    const onStorage = (e: StorageEvent) => { if (e.key === FAV_KEY) cb(); };
    window.addEventListener(FAV_EVENT, cb);
    window.addEventListener("storage", onStorage);
    return () => {
        window.removeEventListener(FAV_EVENT, cb);
        window.removeEventListener("storage", onStorage);
    };
}

/** 存檔結果：成功帶回片段，失敗帶欄位錯誤或一句話。/ A save result: the snippet, or field errors / a message. */
export type SaveResult = { ok: true; snippet: Snippet } | { ok: false; fields: Record<string, string>; message: string | null };

async function saveResult(r: Response): Promise<SaveResult> {
    const data = await r.json().catch(() => null);
    if (r.ok) return { ok: true, snippet: data as Snippet };
    const fields: Record<string, string> = {};
    if (data && typeof data === "object") {
        for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
            if (Array.isArray(v) && typeof v[0] === "string") fields[k] = v[0];
        }
    }
    return { ok: false, fields, message: Object.keys(fields).length > 0 ? null : formatApiError(data) };
}

export function useSnippets(tunnelId: number | null) {
    const [data, setData] = useState<SnippetList | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const favourites = useSyncExternalStore(favSubscribe, favSnapshot, () => NO_FAVS);

    const reload = useCallback(async () => {
        try {
            const r = await apiFetch(`/api/snippets${tunnelId ? `?tunnel_id=${tunnelId}` : ""}`);
            const body = await r.json().catch(() => null);
            if (!r.ok) {
                setError(formatApiError(body));
                return;
            }
            setData(body as SnippetList);
            setError(null);
        } catch {
            setError(null);
        } finally {
            setLoading(false);
        }
    }, [tunnelId]);

    useEffect(() => {
        void reload();
        const onChanged = () => void reload();
        window.addEventListener(CHANGED, onChanged);
        return () => window.removeEventListener(CHANGED, onChanged);
    }, [reload]);

    const changed = () => window.dispatchEvent(new Event(CHANGED));

    const create = useCallback(async (scope: SnippetScope, draft: SnippetDraft): Promise<SaveResult> => {
        const r = await apiFetch("/api/snippets", { method: "POST", body: JSON.stringify({ scope, tunnel_id: scope === "tunnel" ? tunnelId : undefined, ...draft }) });
        const res = await saveResult(r);
        if (res.ok) changed();
        return res;
    }, [tunnelId]);

    const update = useCallback(async (id: number, draft: SnippetDraft): Promise<SaveResult> => {
        const r = await apiFetch(`/api/snippets/${id}`, { method: "PATCH", body: JSON.stringify(draft) });
        const res = await saveResult(r);
        if (res.ok) changed();
        return res;
    }, []);

    const remove = useCallback(async (id: number): Promise<string | null> => {
        const r = await apiFetch(`/api/snippets/${id}`, { method: "DELETE" });
        if (!r.ok) return formatApiError(await r.json().catch(() => null));
        changed();
        return null;
    }, []);

    /** 用了一次（不等、失敗不管）。/ Count a use (fire and forget). */
    const markUsed = useCallback((id: number) => {
        void apiFetch(`/api/snippets/${id}/used`, { method: "POST" }).then(async (r) => {
            if (!r.ok) return;
            const u = (await r.json().catch(() => null)) as { use_count: number; last_used_at: string | null } | null;
            if (u) setData((d) => (d ? { ...d, snippets: d.snippets.map((s) => (s.id === id ? { ...s, use_count: u.use_count, last_used_at: u.last_used_at } : s)) } : d));
        }).catch(() => { });
    }, []);

    const toggleFav = useCallback((id: number) => {
        const next = toggleFavourite(favSnapshot(), id);
        try { localStorage.setItem(FAV_KEY, JSON.stringify(next)); } catch { /* 存不了就算了 / best effort */ }
        window.dispatchEvent(new Event(FAV_EVENT));
    }, []);

    return { data, loading, error, reload, create, update, remove, markUsed, favourites, toggleFav };
}
