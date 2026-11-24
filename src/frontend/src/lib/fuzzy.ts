/**
 * 模糊比對（純函式）：指令速查的搜尋用。查詢切成詞，每個詞都要在某個欄位裡找得到；找法依序是「整段出現」、
 * 「字母照順序出現在同一個詞裡」（縮寫：`fwd` → forward）、「差一兩個字」（打錯：`forwrad`）。中日文沒有空白分詞，
 * 只做整段出現。分數越高越前面。
 * Fuzzy matching (pure) for the command sheet's search. The query is split into words and each must be found in some
 * field: as a substring, as letters in order inside one word (abbreviations: `fwd` → forward), or within a typo or two
 * (`forwrad`). CJK text has no word breaks, so it only matches as a substring. Higher scores sort first.
 */

/** 比對前的整理：NFKC（全形 → 半形）、小寫、去掉重音符號。/ Normalise before matching: NFKC, lower case, no diacritics. */
export function fold(text: string): string {
    return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").normalize("NFKC").toLowerCase();
}

/** 查詢切成詞（空白分隔）。/ The query's words. */
export function queryWords(query: string): string[] {
    return fold(query).split(/\s+/).filter(Boolean);
}

const LATIN = /^[a-z0-9:_./@-]+$/;

/** 欄位裡的「詞」：連續的英數（含 `-`、`:`、`.` 之類指令會有的字元）。/ A field's words: runs of letters / digits and command punctuation. */
function wordsOf(folded: string): string[] {
    return folded.match(/[a-z0-9][a-z0-9:_./@-]*|-{1,2}[a-z0-9][a-z0-9-]*/g) ?? [];
}

/** `needle` 的字母是否照順序出現在 `word` 裡，而且從第一個字母開始。/ Letters of `needle` in order inside `word`, starting at its first letter. */
function subsequence(needle: string, word: string): boolean {
    if (needle[0] !== word[0]) return false;
    let i = 0;
    for (const ch of word) {
        if (ch === needle[i]) i++;
        if (i === needle.length) return true;
    }
    return false;
}

/** 編輯距離（含相鄰對調），超過 `max` 就提早回 max + 1。/ Edit distance with adjacent swaps; gives up past `max`. */
export function distance(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev2: number[] = [];
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let best = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
            cur[j] = v;
            if (v < best) best = v;
        }
        if (best > max) return max + 1;
        prev2 = prev;
        prev = cur;
    }
    return prev[b.length];
}

/**
 * 一個詞在一段文字裡找得多好：4 = 是某個詞的開頭（或整段文字的開頭）、3 = 出現在中間、2 = 縮寫、1 = 打錯字、0 = 沒有。
 * How well one query word is found in a text: 4 = starts a word, 3 = inside, 2 = abbreviation, 1 = typo, 0 = not found.
 * `text` 要先 `fold` 過。/ `text` must already be folded.
 */
export function matchWord(word: string, text: string): number {
    if (!word || !text) return 0;
    const at = text.indexOf(word);
    if (at >= 0) {
        const before = at === 0 ? "" : text[at - 1];
        return at === 0 || !/[a-z0-9]/.test(before) ? 4 : 3;
    }
    // 縮寫與錯字只對拉丁字母的查詢做（中日文一個字差很多）。/ Abbreviations and typos only for Latin queries.
    if (!LATIN.test(word) || word.length < 3) return 0;
    const words = wordsOf(text);
    if (words.some((w) => w.length > word.length && subsequence(word, w))) return 2;
    const max = word.length >= 8 ? 2 : word.length >= 4 ? 1 : 0;
    if (max > 0 && words.some((w) => distance(word, w.length > word.length + max ? w.slice(0, word.length + max) : w, max) <= max)) return 1;
    return 0;
}

export interface Field {
    text: string;
    /** 這個欄位多重要（標題 > 指令 > 說明）。/ How much this field counts (title > command > note). */
    weight: number;
}

/**
 * 查詢對一組欄位的分數；任何一個詞都找不到 = 0。每個詞取它在各欄位裡最好的「找得多好 × 欄位權重」，再加總。
 * A query's score against some fields; 0 when any word is missing. Each word takes its best quality × field weight.
 * 欄位文字要先 `fold` 過。/ Field texts must already be folded.
 */
export function score(words: string[], fields: Field[]): number {
    let total = 0;
    for (const w of words) {
        let best = 0;
        for (const f of fields) {
            const s = matchWord(w, f.text) * f.weight;
            if (s > best) best = s;
        }
        if (best === 0) return 0;
        total += best;
    }
    return total;
}
