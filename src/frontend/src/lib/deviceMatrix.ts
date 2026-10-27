/**
 * 金鑰頁裝置矩陣的純函式：依自己的通道群組分段、裝置多時預設收起哪些段，以及一格裡的帳號狀態能不能縮成一個籤。
 * Pure helpers for the keys page's device matrix: sections by the viewer's tunnel groups, which sections start
 * collapsed when there are many devices, and whether a cell's account states fold into one chip.
 */
import type { TunnelGroup } from "../types/groups";
import type { KeyTarget } from "../types/keys";
import { groupOf } from "./groups.ts";

/** 「未分組」段的鍵。/ The key of the "not in a group" section. */
export const UNGROUPED_SECTION = "none";
/** 裝置超過這麼多台、而且沒選過時，只展開第一段。/ Past this many devices (and no stored choice) only the first section starts open. */
export const SECTIONS_OPEN_UP_TO = 8;

export interface MatrixSection<T> {
    group: TunnelGroup | null;
    key: string;
    items: T[];
    /** 這段全部幾台（不管搜尋）。/ Devices in the section regardless of the filter. */
    total: number;
}

export const sectionKeyOf = (g: TunnelGroup | null) => (g ? String(g.id) : UNGROUPED_SECTION);

/**
 * 依群組順序分段，最後是「未分組」。沒有裝置的段不出現；篩選中只留有符合的段。
 * Sections in group order, then "not in a group". Sections without devices are left out; while filtering only
 * sections with a match stay.
 */
export function matrixSections<T>(visible: T[], all: T[], groups: TunnelGroup[], idOf: (t: T) => number, filtering: boolean): MatrixSection<T>[] {
    const of = groupOf(groups);
    const ordered = [...groups].sort((a, b) => a.position - b.position || a.id - b.id);
    const pick = (list: T[], g: TunnelGroup | null) => list.filter((t) => (g ? of.get(idOf(t)) === g.id : !of.has(idOf(t))));
    return [...ordered, null]
        .map((g) => ({ group: g, key: sectionKeyOf(g), items: pick(visible, g), total: pick(all, g).length }))
        .filter((s) => s.total > 0 && (!filtering || s.items.length > 0));
}

/** 至少有一台裝置在某個群組裡，分段才有意義。/ Sections only make sense once a device is in a group. */
export function hasGroupedDevice(ids: number[], groups: TunnelGroup[]): boolean {
    const of = groupOf(groups);
    return ids.some((id) => of.has(id));
}

/**
 * 沒選過時收起哪些段：裝置不多就全部展開；多的話只展開第一段，其他只留標題（點開即可）。
 * Sections collapsed when nothing is stored: none for a few devices; otherwise all but the first.
 */
export function defaultCollapsed(sectionKeys: string[], deviceCount: number): Set<string> {
    if (deviceCount <= SECTIONS_OPEN_UP_TO) return new Set();
    return new Set(sectionKeys.slice(1));
}

/**
 * 一格的帳號狀態能縮成一個「✓ N 個帳號」籤：兩個以上帳號、全部已裝上、沒有刻意略過的帳號。
 * 單一帳號照樣顯示名稱；有等待中 / 失敗的就一個個列出來，問題才看得到。
 * A cell folds into one "✓ N accounts" chip when it has two or more accounts, all installed, none left out on
 * purpose. One account keeps its name; pending or failed ones stay listed so problems remain visible.
 */
export function foldsToSummary(targets: KeyTarget[], unchosen: string[]): boolean {
    return targets.length >= 2 && unchosen.length === 0 && targets.every((t) => t.status === "installed");
}
