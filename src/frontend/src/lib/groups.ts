/**
 * 群組的純函式（不依賴 React，`groups.test.ts` 有測試）：名稱檢查、通道列表分段、調整順序、金鑰群組「會到哪裡」
 * （授予 → 通道 → 帳號）與每台裝置的安裝進度。
 * Pure helpers for groups (tested in groups.test.ts): name checks, tunnel list sections, reordering, where a key
 * group reaches (grants → tunnels → accounts) and the install progress on each device.
 */
import type { KeyGroup, KeyGroupGrant, TunnelGroup } from "../types/groups";

/** 群組名稱最長幾個字（與後端 `db::groups::MAX_NAME_CHARS` 相同）。/ Same as the backend limit. */
export const MAX_GROUP_NAME = 48;

/** 去頭尾空白、連續空白變一個（與後端一樣）。/ Trim and collapse whitespace, like the backend. */
export function normalizeGroupName(raw: string): string {
    return raw.split(/\s+/).filter(Boolean).join(" ");
}

export type GroupNameProblem = "empty" | "tooLong" | "taken" | null;

/** 名稱哪裡不行（同一個人不能重名，不分大小寫）。/ What is wrong with a name (unique per person, ignoring case). */
export function groupNameProblem(raw: string, existing: { id: number; name: string }[], exceptId?: number): GroupNameProblem {
    const name = normalizeGroupName(raw);
    if (!name) return "empty";
    if ([...name].length > MAX_GROUP_NAME) return "tooLong";
    const lower = name.toLowerCase();
    if (existing.some((g) => g.id !== exceptId && g.name.toLowerCase() === lower)) return "taken";
    return null;
}

/** 通道頁的「依群組 / 單一清單」（localStorage `telepy.tunnelGrouping`）；金鑰頁的裝置矩陣跟著同一個選擇。
 *  The tunnels page's "by group / one list" choice; the keys page's device matrix follows it too. */
export const TUNNEL_GROUPING_KEY = "telepy.tunnelGrouping";
export const TUNNEL_GROUPINGS = ["groups", "flat"] as const;

/** 通道 id → 我的群組 id。/ Tunnel id → my group id. */
export function groupOf(groups: TunnelGroup[]): Map<number, number> {
    const m = new Map<number, number>();
    for (const g of groups) for (const t of g.tunnel_ids) m.set(t, g.id);
    return m;
}

/** 列表的一段：一個群組（null = 未分組）、這段要顯示的、這組總共幾條。/ One section of the list. */
export interface Section<T> {
    group: TunnelGroup | null;
    items: T[];
    total: number;
}

/**
 * 依我的群組把（已篩選、已排序的）列表分段：群組照我排的順序，未分組的在最後。`hideEmpty`（搜尋 / 篩選中）
 * 拿掉沒有符合項目的段；平常空的群組也顯示（看得到、可以放東西進去），沒東西的「未分組」才不顯示。
 * Split the (filtered, sorted) list by my groups: groups in my order, ungrouped last. While filtering
 * (`hideEmpty`) sections without matches go; otherwise empty groups stay visible and only an empty
 * "ungrouped" section is dropped.
 */
export function groupSections<T extends { id: number }>(visible: T[], all: T[], groups: TunnelGroup[], hideEmpty: boolean): Section<T>[] {
    const of = groupOf(groups);
    const ordered = [...groups].sort((a, b) => a.position - b.position || a.id - b.id);
    const out: Section<T>[] = ordered.map((g) => ({
        group: g,
        items: visible.filter((t) => of.get(t.id) === g.id),
        total: all.filter((t) => of.get(t.id) === g.id).length,
    }));
    out.push({ group: null, items: visible.filter((t) => !of.has(t.id)), total: all.filter((t) => !of.has(t.id)).length });
    return out.filter((s) => (hideEmpty ? s.items.length > 0 : s.group !== null || s.total > 0));
}

/** 把 id 往前（-1）或往後（+1）移一格；到邊界就不動。/ Move an id one step up (-1) or down (+1). */
export function moveId(ids: number[], id: number, delta: -1 | 1): number[] {
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return ids;
    const out = [...ids];
    [out[i], out[j]] = [out[j], out[i]];
    return out;
}

/** 一筆授予碰到的通道。/ The tunnels a grant reaches. */
export function grantReach(grant: KeyGroupGrant, tunnelGroups: TunnelGroup[]): number[] {
    if (grant.tunnel) return [grant.tunnel.id];
    if (grant.tunnel_group) return tunnelGroups.find((g) => g.id === grant.tunnel_group!.id)?.tunnel_ids ?? [];
    return [];
}

/** 金鑰群組到得了的一台裝置：經由哪些授予、帳號名稱（聯集；null = 全部）。/ One device a key group reaches. */
export interface Reach {
    tunnelId: number;
    via: KeyGroupGrant[];
    accounts: string[] | null;
}

/** 帳號選擇的聯集：有一個是「全部」（null）就是全部。/ Union of account choices; any null means all. */
export function unionAccounts(choices: (string[] | null)[]): string[] | null {
    if (choices.some((c) => c === null)) return null;
    return [...new Set(choices.flatMap((c) => c ?? []))].sort();
}

/** 金鑰群組會到的每台裝置（照第一次碰到的順序）。/ Every device a key group reaches, in first-reached order. */
export function keyGroupReach(group: KeyGroup, tunnelGroups: TunnelGroup[]): Reach[] {
    const out: Reach[] = [];
    for (const grant of group.grants) {
        for (const id of grantReach(grant, tunnelGroups)) {
            const r = out.find((x) => x.tunnelId === id);
            if (r) r.via.push(grant);
            else out.push({ tunnelId: id, via: [grant], accounts: null });
        }
    }
    for (const r of out) r.accounts = unionAccounts(r.via.map((g) => g.accounts));
    return out;
}

/** 允許的帳號 ∩ 選的（null = 全部）。/ Allowed accounts ∩ the choice (null = all). */
export function placedAccounts(allowed: string[], chosen: string[] | null): string[] {
    return chosen === null ? allowed : allowed.filter((a) => chosen.includes(a));
}

/** 這些裝置上我能用的帳號名稱（聯集、排序）：授予時「只裝到這些帳號」的選項。/ Account names I may use on these devices. */
export function accountChoices(tunnelIds: number[], devices: { tunnel_id: number; accounts: string[] }[]): string[] {
    const set = new Set<string>();
    for (const d of devices) if (tunnelIds.includes(d.tunnel_id)) for (const a of d.accounts) set.add(a);
    return [...set].sort();
}

export interface Progress {
    installed: number;
    pending: number;
    error: number;
}

/** 一台裝置上，這些金鑰在各帳號的安裝狀態加總。/ Install states of these keys on one device, summed over accounts. */
export function deviceProgress(device: { keys: { user_key_id: number; targets: { status: string }[] }[] } | undefined, keyIds: number[]): Progress {
    const p: Progress = { installed: 0, pending: 0, error: 0 };
    for (const k of device?.keys ?? []) {
        if (!keyIds.includes(k.user_key_id)) continue;
        for (const t of k.targets) {
            if (t.status === "installed") p.installed++;
            else if (t.status === "error") p.error++;
            else p.pending++;
        }
    }
    return p;
}
