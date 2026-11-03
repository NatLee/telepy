/**
 * 網路頁「裝置自己、閘道、跟上次掃描比」的純函式：把裝置自己的服務（位址 `localhost`）從區網主機分出來、主機排序
 * （閘道在前、這次沒看到的在後）、每台主機的變化（新的 / port 開關 / 沒看到）、一次掃描的變化統計與清單（給「變了什麼」
 * 視窗），以及上次掃描多久以前（太久就提醒）。
 * Pure helpers for the network page's "the device itself, its gateway, and what changed": the device's own services
 * (address `localhost`) split from the LAN hosts, host order (gateway first, hosts not seen last), each host's change
 * (new / ports opened or closed / not seen), a scan's change counts and lists (for the "what changed" dialog), and how
 * long ago the last scan was (with a nudge when it's old).
 */
import type { LanChanges } from "../types/lan.ts";

type HostLike = { address: string; own?: boolean; source?: string; gateway?: boolean; missing?: boolean; since_last?: { new: boolean; opened: number[]; closed: number[] } | null };

/** 上次掃描超過這麼多天，就說可能過時了。/ A last scan older than this many days is called out of date. */
export const STALE_DAYS = 7;

/** 這一列是裝置自己在聽的服務。/ This row is the device's own listening services. */
export function isOwn(h: Pick<HostLike, "own" | "source">): boolean {
    return h.own === true || h.source === "self";
}

/**
 * 裝置自己那一列 + 其他區網主機（閘道排第一、這次沒看到的排最後，其他照原順序）。
 * The device's own row plus the other LAN hosts (the gateway first, hosts not seen last, the rest as they came).
 */
export function splitOwn<H extends HostLike>(hosts: H[]): { own: H | null; lan: H[] } {
    const own = hosts.find(isOwn) ?? null;
    const rest = hosts.filter((h) => !isOwn(h));
    const rank = (h: H) => (h.gateway ? 0 : h.missing ? 2 : 1);
    // 穩定排序：同一級照原順序。/ Stable: same rank keeps the original order.
    const lan = rest.map((h, i) => ({ h, i })).sort((a, b) => rank(a.h) - rank(b.h) || a.i - b.i).map((x) => x.h);
    return { own, lan };
}

export type HostChange = "new" | "ports" | "missing";

/** 一台主機在上次掃描的變化（同時有就照「沒看到 > 新的 > port」）。/ A host's change in the last scan. */
export function hostChange(h: HostLike): HostChange | null {
    if (h.missing) return "missing";
    if (h.since_last?.new) return "new";
    if (h.since_last && (h.since_last.opened.length > 0 || h.since_last.closed.length > 0)) return "ports";
    return null;
}

export interface ChangeCounts {
    new: number;
    gone: number;
    changed: number;
    total: number;
}

export function changeCounts(c: LanChanges | null | undefined): ChangeCounts | null {
    if (!c) return null;
    const out = { new: c.new.length, gone: c.gone.length, changed: c.changed.length };
    return { ...out, total: out.new + out.gone + out.changed };
}

/**
 * 「變了什麼」視窗的三組：新的、沒看到、port 變了；每個位址配上清單裡的主機（刪掉了就只有位址）。
 * The dialog's three groups — new, not seen, ports changed — each address paired with its host (address only when the
 * host was deleted since).
 */
export function changeGroups<H extends { address: string }>(c: LanChanges, hosts: H[]): {
    new: { address: string; host: H | null }[];
    gone: { address: string; host: H | null }[];
    changed: { address: string; host: H | null; opened: number[]; closed: number[] }[];
} {
    const byAddr = new Map(hosts.map((h) => [h.address, h]));
    const pick = (address: string) => byAddr.get(address) ?? null;
    return {
        new: c.new.map((address) => ({ address, host: pick(address) })),
        gone: c.gone.map((address) => ({ address, host: pick(address) })),
        changed: c.changed.map((x) => ({ ...x, host: pick(x.address) })),
    };
}

/**
 * 上次掃描多久以前（毫秒、天數）與是不是太久了；沒掃過或時間壞掉 = null。
 * How long ago the last scan was (ms, whole days) and whether it is out of date; null without a valid time.
 */
export function scanAge(scannedAt: string | null | undefined, now: number): { ms: number; days: number; stale: boolean } | null {
    if (!scannedAt) return null;
    const at = Date.parse(scannedAt);
    if (Number.isNaN(at)) return null;
    const ms = Math.max(0, now - at);
    const days = Math.floor(ms / 86_400_000);
    return { ms, days, stale: days >= STALE_DAYS };
}
