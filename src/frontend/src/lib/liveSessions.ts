/**
 * 即時 session 頁的小工具：篩選（種類 / 只看自己的 / 某條隧道）與依隧道分組。純函式，`liveSessions.test.ts` 有測試。
 * Live sessions helpers: filtering (kind / mine only / one tunnel) and grouping per tunnel.
 */
import type { LiveSession } from "@/types/liveSession";

export type KindFilter = "all" | "terminal" | "files" | "browser" | "desktop" | "ssh" | "ai";

export interface SessionFilter {
    kind: KindFilter;
    mineOnly: boolean;
    tunnelId: number | null;
}

export function filterSessions(list: LiveSession[], f: SessionFilter): LiveSession[] {
    return list.filter((s) => (f.kind === "all" || s.kind === f.kind) && (!f.mineOnly || s.mine) && (f.tunnelId === null || s.tunnel.id === f.tunnelId));
}

export interface TunnelGroup {
    tunnelId: number;
    name: string;
    sessions: LiveSession[];
}

/** 依隧道分組（名稱排序），組內依開始時間。/ Group per tunnel (by name), oldest session first. */
export function groupByTunnel(list: LiveSession[]): TunnelGroup[] {
    const groups = new Map<number, TunnelGroup>();
    for (const s of list) {
        const g = groups.get(s.tunnel.id) ?? { tunnelId: s.tunnel.id, name: s.tunnel.name ?? `#${s.tunnel.id}`, sessions: [] };
        g.sessions.push(s);
        groups.set(s.tunnel.id, g);
    }
    const out = [...groups.values()];
    for (const g of out) g.sessions.sort((a, b) => a.since.localeCompare(b.since));
    return out.sort((a, b) => a.name.localeCompare(b.name));
}
