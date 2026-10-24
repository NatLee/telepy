/**
 * 標籤輸入的整理與檢查（和後端 `db::tunnel_tags::normalize_labels` 同規則）：逗號或空白分開、轉小寫、
 * 去重複、排序；`[a-z0-9]` 開頭，後面可以有 `. _ - =`，最多 32 字元、12 個。
 * Label input normalisation, same rules as the backend: comma / space separated, lower-cased, de-duplicated
 * and sorted; starts with a letter or digit, then `. _ - =`; up to 32 characters and 12 labels.
 */
export const MAX_LABELS = 12;
const LABEL_RE = /^[a-z0-9][a-z0-9._=-]{0,31}$/;

export type LabelCheck = { labels: string[]; invalid: string[]; tooMany: boolean };

export function parseLabels(input: string): LabelCheck {
    const seen = new Set<string>();
    const invalid: string[] = [];
    for (const raw of input.split(/[\s,]+/)) {
        const l = raw.trim().toLowerCase();
        if (!l) continue;
        if (!LABEL_RE.test(l)) invalid.push(raw.trim());
        else seen.add(l);
    }
    const labels = [...seen].sort();
    return { labels, invalid, tooMany: labels.length > MAX_LABELS };
}

export const sameLabels = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
