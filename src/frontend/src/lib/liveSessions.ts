/**
 * 即時 session 頁的小工具：篩選（種類 / 只看自己的 / 某條隧道或某台 RustDesk 裝置）與依地點分組。純函式，
 * `liveSessions.test.ts` 有測試。經 Telepy RustDesk 伺服器的 session 沒有隧道，地點是那台裝置。
 * Live sessions helpers: filtering (kind / mine only / one tunnel or RustDesk device) and grouping per place. A
 * session through Telepy's RustDesk server has no tunnel; its place is the device.
 */
import type { LiveSession } from "@/types/liveSession";

export type KindFilter = "all" | "terminal" | "files" | "browser" | "desktop" | "rustdesk" | "ssh" | "ai";

/** 隧道或 RustDesk 伺服器上的裝置。/ A tunnel, or a device on Telepy's RustDesk server. */
export type Place = { type: "tunnel"; id: number } | { type: "device"; id: number };

export function placeOf(s: LiveSession): Place {
    return s.device ? { type: "device", id: s.device.id } : { type: "tunnel", id: s.tunnel.id };
}

/** `tunnel:3` / `device:7`（選單的值）。/ The select value. */
export function placeKey(p: Place): string {
    return `${p.type}:${p.id}`;
}

export function parsePlaceKey(key: string): Place | null {
    const m = /^(tunnel|device):(\d+)$/.exec(key);
    return m ? { type: m[1] as Place["type"], id: Number(m[2]) } : null;
}

/** 網址參數 `?tunnel=` / `?device=` → 地點。/ The URL parameters → a place. */
export function placeFromParams(tunnel: string | null, device: string | null): Place | null {
    const d = Number(device);
    if (d > 0) return { type: "device", id: d };
    const t = Number(tunnel);
    return t > 0 ? { type: "tunnel", id: t } : null;
}

export function placeName(s: LiveSession): string {
    return s.device ? s.device.name : s.tunnel.name ?? `#${s.tunnel.id}`;
}

export interface SessionFilter {
    kind: KindFilter;
    mineOnly: boolean;
    place: Place | null;
}

export function filterSessions(list: LiveSession[], f: SessionFilter): LiveSession[] {
    const want = f.place ? placeKey(f.place) : null;
    return list.filter((s) => (f.kind === "all" || s.kind === f.kind) && (!f.mineOnly || s.mine) && (want === null || placeKey(placeOf(s)) === want));
}

export interface PlaceGroup {
    key: string;
    place: Place;
    name: string;
    sessions: LiveSession[];
}

/** 依地點分組（名稱排序），組內依開始時間。/ Group per place (by name), oldest session first. */
export function groupByPlace(list: LiveSession[]): PlaceGroup[] {
    const groups = new Map<string, PlaceGroup>();
    for (const s of list) {
        const place = placeOf(s);
        const key = placeKey(place);
        const g = groups.get(key) ?? { key, place, name: placeName(s), sessions: [] };
        g.sessions.push(s);
        groups.set(key, g);
    }
    const out = [...groups.values()];
    for (const g of out) g.sessions.sort((a, b) => a.since.localeCompare(b.since));
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}
