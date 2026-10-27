/**
 * 即時 session 頁的小工具：篩選（種類 / 只看自己的 / 某條隧道）與依隧道分組。純函式，`liveSessions.test.ts` 有測試。
 * Live sessions helpers: filtering (kind / mine only / one tunnel) and grouping per tunnel.
 */
import type { LiveSession } from "@/types/liveSession";

export type KindFilter = "all" | "terminal" | "files" | "browser" | "desktop" | "rustdesk" | "ssh" | "ai" | "watch";

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

/**
 * `SESSION-ENDED` 該怎麼說（純函式）：功能被關掉（`feature`，斷線保留中的 shell 另外說）、存取變了
 * （`reason`，後端 `access_recheck::Lost`）、或某人從即時 session 頁結束。
 * How to word a `SESSION-ENDED`: a feature turned off (`feature`; a detached shell gets its own sentence), access
 * changed (`reason`, the backend's `access_recheck::Lost`), or someone ended it from the Live sessions page.
 */
export type EndedNotice =
    | { kind: "feature"; feature: string; detached: boolean }
    | { kind: "lost"; reason: "accessRemoved" | "loginRemoved" | "accountDisabled" | "detachOff"; detached: boolean }
    | { kind: "by"; by: string };

const LOST: Record<string, Extract<EndedNotice, { kind: "lost" }>["reason"]> = {
    access_removed: "accessRemoved",
    login_removed: "loginRemoved",
    account_disabled: "accountDisabled",
    detach_off: "detachOff",
};

export function endedNotice(msg: Record<string, unknown>): EndedNotice {
    const detached = msg.detached === true;
    if (typeof msg.feature === "string") return { kind: "feature", feature: msg.feature, detached };
    const lost = typeof msg.reason === "string" ? LOST[msg.reason] : undefined;
    if (lost) return { kind: "lost", reason: lost, detached };
    return { kind: "by", by: String(msg.by ?? "") };
}

/** 存取變了的原因（`EndedNotice` 的 `lost`）。/ The access-changed reasons. */
export type LostReason = Extract<EndedNotice, { kind: "lost" }>["reason"];

/** 每種 session 需要什麼（一句話，i18n key 的尾巴）。/ What each kind of session needs (an i18n key suffix). */
const NEEDS: Record<string, string> = {
    terminal: "terminal",
    files: "files",
    browser: "browser",
    desktop: "desktop",
    rustdesk: "desktop",
    ssh: "ssh",
};

/**
 * 「存取變了」的提醒怎麼說（純函式）：主句（筆電 ssh 與看終端機有自己的說法），加上這種 session 需要什麼
 * （帳號停用、斷線保留政策這兩種不必解釋）。回 i18n key。
 * How to word an "access changed" toast: the main sentence (laptop SSH and watching have their own) plus what this
 * kind of session needs (not for a disabled account or the detach policy). Returns i18n keys.
 */
export function lostToast(reason: LostReason, kind: string): { key: string; need: string | null } {
    let key = `sessions.lost.${reason}`;
    if (kind === "ssh" && (reason === "accessRemoved" || reason === "loginRemoved")) key = `sessions.lost.ssh.${reason}`;
    if (kind === "watch" && reason === "accessRemoved") key = "sessions.lost.watch";
    const needs = NEEDS[kind];
    const need = needs && (reason === "accessRemoved" || reason === "loginRemoved") && kind !== "watch" ? `sessions.need.${needs}` : null;
    return { key, need };
}
