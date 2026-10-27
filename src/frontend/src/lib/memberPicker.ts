/**
 * 群組編輯器的成員挑選（金鑰群組挑金鑰、通道群組挑通道）：搜尋 + 「全部 / 已選 / 不在任何群組」分類（附數量），
 * 以及一次勾選 / 取消目前符合的全部。純函式，數量依搜尋算。
 * Member picking in the group editors (keys for a key group, tunnels for a tunnel group): search plus "all /
 * selected / in no group" buckets with counts, and ticking / unticking every current match at once. Pure; the
 * counts follow the search.
 */

export type PickerBucket = "all" | "selected" | "free";

export interface PickerEntry {
    id: number;
    /** 搜尋比對的欄位。/ Fields the search looks at. */
    text: (string | null | undefined)[];
    /** 它現在所在的群組（null = 沒有）。/ The group it is in now (null = none). */
    group: number | null;
}

export function pickerTerms(query: string): string[] {
    return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * 符合搜尋與分類的項目（原順序）與各分類的數量。「已選」也留著 `kept`（進入這個分類時已選的），所以在那裡取消勾選
 * 不會讓那列立刻消失；「不在任何群組」看的是開啟時的狀態（還沒分組的），勾了也不會跳走。
 * The entries matching the search and bucket (in order) and each bucket's count. "Selected" also keeps `kept` (what
 * was selected when the bucket was opened), so unticking there doesn't make the row vanish; "in no group" looks at
 * the state when the editor opened (not grouped yet), so ticking never makes a row jump away.
 */
export function pickerView<T extends PickerEntry>(
    entries: T[],
    selected: ReadonlySet<number>,
    query: string,
    bucket: PickerBucket,
    kept: ReadonlySet<number> = new Set(),
): { shown: T[]; counts: Record<PickerBucket, number> } {
    const terms = pickerTerms(query);
    const match = entries.filter((e) => terms.every((term) => e.text.some((f) => f != null && f.toLowerCase().includes(term))));
    const isSelected = (e: T) => selected.has(e.id) || kept.has(e.id);
    const isFree = (e: T) => e.group === null;
    const counts = { all: match.length, selected: match.filter((e) => selected.has(e.id)).length, free: match.filter(isFree).length };
    const shown = bucket === "selected" ? match.filter(isSelected) : bucket === "free" ? match.filter(isFree) : match;
    return { shown, counts };
}

/** 一次勾上（保留原順序，新的接在後面）或取消一批。/ Tick (keeping the order, new ones appended) or untick a batch. */
export function toggleMany(selected: number[], ids: number[], on: boolean): number[] {
    if (on) {
        const have = new Set(selected);
        return [...selected, ...ids.filter((id) => !have.has(id))];
    }
    const drop = new Set(ids);
    return selected.filter((id) => !drop.has(id));
}
