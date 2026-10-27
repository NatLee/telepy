/**
 * 裝置金鑰面板「你的金鑰」分頁的純邏輯：金鑰依金鑰群組分段（群組列在上、組員在下，沒分組的最後），
 * 每把金鑰怎麼到這台（直接 / 經由群組 / 兩者 / 沒有），以及一行摘要的數字。
 * Pure helpers for the device panel's "Your keys" tab: keys sectioned by key group (the group row with its
 * members under it, ungrouped keys last), how each key reaches this device, and the summary counts.
 */
import { fieldsMatch, queryTerms } from "./keyRows.ts";

export interface HereKey {
    id: number;
    name: string;
    fingerprint: string | null;
    key_type: string | null;
    in_list: boolean;
    group_id?: number | null;
    via_groups?: { id: number }[];
}

export interface HereGroup {
    id: number;
    name: string;
    grant: unknown | null;
    via_tunnel_group: unknown | null;
}

/** direct = 直接在清單上；group = 只經由金鑰群組；both；none = 不在這台。/ How a key reaches this device. */
export type Reach = "direct" | "group" | "both" | "none";

export function reachOf(k: HereKey): Reach {
    const viaGroup = (k.via_groups ?? []).length > 0;
    if (k.in_list) return viaGroup ? "both" : "direct";
    return viaGroup ? "group" : "none";
}

/** 群組有沒有到這台（直接授予或經由通道群組）。/ Whether a key group reaches this device. */
export function groupHere(g: HereGroup): boolean {
    return !!g.grant || !!g.via_tunnel_group;
}

export interface Section<K, G> {
    /** null = 沒分組的金鑰。/ null = keys in no group. */
    group: G | null;
    keys: K[];
    /** 這組的金鑰總數（搜尋前）。/ Keys in the section before searching. */
    total: number;
}

/**
 * 依群組分段：群組照給的順序（空群組也留著，因為仍可授予），組員照 `keys` 的順序，沒分組的放最後（沒有就不出現）。
 * 搜尋時：群組名稱符合 = 整組都留；否則只留符合的金鑰，一把都沒有的群組拿掉。
 * Sections in the given group order (empty groups stay — they can still be granted), members in `keys` order,
 * ungrouped keys last (omitted when none). Searching keeps a whole group when its name matches, otherwise only
 * the matching keys, and drops groups left with none.
 */
export function keySections<K extends HereKey, G extends HereGroup>(keys: K[], groups: G[], query = ""): Section<K, G>[] {
    const terms = queryTerms(query);
    const known = new Set(groups.map((g) => g.id));
    const matches = (k: K) => fieldsMatch([k.name, k.fingerprint, k.key_type], terms);
    const out: Section<K, G>[] = [];
    for (const g of groups) {
        const members = keys.filter((k) => k.group_id === g.id);
        if (!terms.length || fieldsMatch([g.name], terms)) {
            out.push({ group: g, keys: members, total: members.length });
            continue;
        }
        const hits = members.filter(matches);
        if (hits.length) out.push({ group: g, keys: hits, total: members.length });
    }
    const loose = keys.filter((k) => k.group_id == null || !known.has(k.group_id));
    const looseShown = terms.length ? loose.filter(matches) : loose;
    if (looseShown.length) out.push({ group: null, keys: looseShown, total: loose.length });
    return out;
}

/** 摘要：幾把在這台、其中直接 / 只經由群組各幾把。/ Summary: keys here, of which direct / only via a group. */
export function reachSummary(keys: HereKey[]): { total: number; here: number; direct: number; viaGroup: number } {
    let here = 0;
    let direct = 0;
    let viaGroup = 0;
    for (const k of keys) {
        const r = reachOf(k);
        if (r === "none") continue;
        here++;
        if (r === "group") viaGroup++;
        else direct++;
    }
    return { total: keys.length, here, direct, viaGroup };
}

/** 在這台的排前面，其餘照原順序（打開時排一次，勾選不會讓列跳位置）。/ Keys here first, once per open. */
export function initialOrder(keys: HereKey[]): number[] {
    const here = (k: HereKey) => reachOf(k) !== "none";
    return [...keys.filter(here), ...keys.filter((k) => !here(k))].map((k) => k.id);
}
