/**
 * 網路拓撲頁的純函式：裝置篩選（全部 / 有主機的 / 在線，附數量）、一台裝置的主機種類統計（收起來時的摘要），以及
 * 沒選過時哪些裝置先展開。
 * Pure helpers for the network topology page: the device filter (all / with hosts / online, with counts), a
 * device's host-kind counts (its summary while collapsed), and which devices start expanded without a stored choice.
 */

export type TopologyFilter = "all" | "hosts" | "online";

/** 裝置不超過這麼多台時，有主機的全部先展開。/ Up to this many devices, every device with hosts starts expanded. */
export const EXPAND_ALL_UP_TO = 6;

export function filterDevices<T extends { hosts: unknown[] }>(devices: T[], filter: TopologyFilter, isOnline: (d: T) => boolean): { shown: T[]; counts: Record<TopologyFilter, number> } {
    const counts = { all: devices.length, hosts: devices.filter((d) => d.hosts.length > 0).length, online: devices.filter(isOnline).length };
    // 選的分類變空了就退回全部。/ Fall back to "all" when the chosen bucket is empty.
    const f: TopologyFilter = filter !== "all" && counts[filter] === 0 ? "all" : filter;
    const shown = f === "hosts" ? devices.filter((d) => d.hosts.length > 0) : f === "online" ? devices.filter(isOnline) : devices;
    return { shown, counts };
}

/** 依種類數主機，依數量由多到少（同數依 `order`）。/ Hosts counted by kind, most first (ties in `order`). */
export function kindCounts<H, K extends string>(hosts: H[], kindOf: (h: H) => K, order: readonly K[]): { kind: K; count: number }[] {
    const m = new Map<K, number>();
    for (const h of hosts) m.set(kindOf(h), (m.get(kindOf(h)) ?? 0) + 1);
    return [...m.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || order.indexOf(a.kind) - order.indexOf(b.kind));
}

/**
 * 沒選過時展開哪些：裝置少就把有主機的都展開；多的話全部收起來（一行摘要），只展開 `focus`（網址 ?tunnel=）。
 * Expanded without a stored choice: with few devices every one with hosts; with many none (one-line summaries)
 * except `focus` (the URL's ?tunnel=).
 */
export function defaultExpanded(devices: { id: number; hosts: unknown[] }[], focus: number | null): Set<number> {
    const out = new Set<number>(devices.length <= EXPAND_ALL_UP_TO ? devices.filter((d) => d.hosts.length > 0).map((d) => d.id) : []);
    if (focus !== null) out.add(focus);
    return out;
}
