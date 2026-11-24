/**
 * 指令速查的目錄與搜尋（純函式）：速查頁的任務（`forwardRecipes.RECIPES`）加上 telepy CLI 自己的範例
 * （`cliExamples.gen.ts`，由 `src/cli/src/examples.rs` 產生）排成一張表，每一項標明哪些工具做得到（telepy / ssh）。
 * 已經是某個任務的 telepy 寫法的範例（`TELEPY_EXAMPLE`）併進那個任務，不重複列。搜尋同時比對三種語言的標題與說明
 * （不管介面是哪種語言）、指令本身與幾個同義詞。
 * The command sheet's catalogue and search (pure): the sheet's tasks (`forwardRecipes.RECIPES`) plus the telepy CLI's
 * own examples (`cliExamples.gen.ts`, generated from `src/cli/src/examples.rs`) as one list, each saying which tools can
 * do it (telepy / ssh). An example that already is a task's telepy form (`TELEPY_EXAMPLE`) is folded into that task.
 * The search reads titles and notes in all three languages (whatever the interface language), the commands themselves
 * and a few synonyms.
 */
import type { TranslationKey } from "../locales/en.ts";
import { CLI_EXAMPLES, type CliTopicId } from "./cliExamples.gen.ts";
import { invokedCommands } from "./cliGuide.ts";
import { fold, queryWords, score, type Field } from "./fuzzy.ts";
import { RECIPES, TELEPY_EXAMPLE, TELEPY_RSYNC_EXAMPLE, recipeWays, type RecipeId, type Way } from "./forwardRecipes.ts";

export type { Way };

export interface CatalogueEntry {
    /** `task:<recipe>` 或 `ex:<example>`。/ `task:<recipe>` or `ex:<example>`. */
    id: string;
    kind: "task" | "example";
    recipe?: RecipeId;
    example?: string;
    topic: CliTopicId;
    ways: Way[];
    title: TranslationKey;
    note?: TranslationKey;
    /** 給搜尋看的其他標題 / 說明（併進來的 CLI 範例）。/ More titles / notes for the search (the folded-in CLI example). */
    alsoKeys: TranslationKey[];
    /** telepy 的指令（範例原文，`<tunnel>` 還沒填）。/ The telepy lines as written in the examples (`<tunnel>` unfilled). */
    lines: string[];
    /** 只給搜尋看的字：ssh 的旗標、同義詞。/ Search-only words: ssh flags, synonyms. */
    keywords: string[];
}

/** 這些 telepy 子指令只是包住系統的 OpenSSH / rsync：單純的 ssh 也做得到。/ These telepy subcommands wrap the system's OpenSSH / rsync, so plain ssh can do the same. */
export const OPENSSH_COMMANDS: readonly string[] = ["ssh", "scp", "sftp", "rsync", "forward"];

/** 任務的同義詞（三種語言都有；標題沒寫到、但人會這樣找的字）。/ Synonyms per task, in all three languages: what people type that the titles don't say. */
export const TASK_KEYWORDS: Record<RecipeId, string[]> = {
    local: ["ssh -L", "port forward", "port forwarding", "tunnel", "轉發", "轉送", "連接埠", "埠", "ポート転送", "フォワード"],
    lan: ["ssh -L", "port forward", "lan", "intranet", "router", "nas", "區網", "內網", "轉發", "ポート転送", "ルーター"],
    socks: ["ssh -D", "socks", "socks5", "proxy", "dynamic", "代理", "翻牆", "プロキシ"],
    remote: ["ssh -R", "reverse", "expose", "share", "反向", "分享", "公開", "リバース"],
    jump: ["ssh -J", "jump", "bastion", "hop", "proxyjump", "跳板", "跳板機", "踏み台"],
    vpn: ["vpn", "network", "subnet", "route", "tun", "網段", "整個網路", "路由", "ネットワーク", "サブネット"],
    copy: ["scp", "rsync", "sftp", "upload", "download", "sync", "上傳", "下載", "同步", "檔案", "アップロード", "ダウンロード", "同期"],
    rustdesk: ["rustdesk", "remote desktop", "21118", "遠端桌面", "リモートデスクトップ"],
};

const TASK_TOPIC: Record<RecipeId, CliTopicId> = { local: "forward", lan: "forward", socks: "forward", remote: "forward", rustdesk: "forward", jump: "everyday", copy: "files", vpn: "network" };

const example = (id: string) => CLI_EXAMPLES.find((e) => e.id === id);

/** 整張目錄：任務在前（照速查頁的順序），再來是沒有併進任務的 CLI 範例（照 examples.rs 的順序）。/ The whole catalogue: tasks first, then the CLI examples not folded into a task. */
export function catalogue(): CatalogueEntry[] {
    const folded = new Set<string>([...Object.values(TELEPY_EXAMPLE), TELEPY_RSYNC_EXAMPLE].filter(Boolean) as string[]);
    const tasks: CatalogueEntry[] = RECIPES.map((r) => {
        const ids = [TELEPY_EXAMPLE[r.id], r.id === "copy" ? TELEPY_RSYNC_EXAMPLE : undefined].filter(Boolean) as string[];
        const ex = ids.map(example).filter((e) => e !== undefined);
        return {
            id: `task:${r.id}`,
            kind: "task",
            recipe: r.id,
            topic: TASK_TOPIC[r.id],
            ways: recipeWays(r),
            title: r.title,
            alsoKeys: ex.flatMap((e) => [`cli.ex.${e.id}`, `cli.ex.${e.id}Note`] as TranslationKey[]),
            lines: ex.flatMap((e) => [...e.lines]),
            keywords: [r.flag, ...TASK_KEYWORDS[r.id]],
        };
    });
    const examples: CatalogueEntry[] = CLI_EXAMPLES.filter((e) => !folded.has(e.id)).map((e) => {
        const commands = e.lines.flatMap((l) => invokedCommands(l));
        return {
            id: `ex:${e.id}`,
            kind: "example",
            example: e.id,
            topic: e.topic,
            ways: commands.length > 0 && commands.every((c) => OPENSSH_COMMANDS.includes(c)) ? ["telepy", "ssh"] : ["telepy"],
            title: `cli.ex.${e.id}` as TranslationKey,
            note: `cli.ex.${e.id}Note` as TranslationKey,
            alsoKeys: [],
            lines: [...e.lines],
            keywords: [],
        };
    });
    return [...tasks, ...examples];
}

export type Dictionaries = Record<string, Partial<Record<TranslationKey, string>>>;

export interface SearchFilter {
    way?: Way | null;
    topic?: CliTopicId | null;
}

export interface SearchHit {
    entry: CatalogueEntry;
    score: number;
    /** 是靠哪種語言的文字找到的（跟介面語言不同時才有）：結果列會把那一句也顯示出來。/ The language whose text matched, when it isn't the interface's: the row shows that title too. */
    via: string | null;
}

const topicKey = (id: CliTopicId) => `cli.topic.${id}` as TranslationKey;

function fields(entry: CatalogueEntry, dict: Partial<Record<TranslationKey, string>>): Field[] {
    const text = (k: TranslationKey | undefined) => (k ? fold(dict[k] ?? "") : "");
    return [
        { text: text(entry.title), weight: 6 },
        { text: text(entry.note), weight: 2 },
        { text: fold(entry.alsoKeys.map((k) => dict[k] ?? "").join(" · ")), weight: 2 },
        { text: text(topicKey(entry.topic)), weight: 1 },
    ];
}

/**
 * 搜尋：空的查詢 = 全部（照目錄順序）；否則每個詞都要找得到，分數高的在前，同分維持目錄順序。`locale` = 介面語言
 * （同分時優先，`via` 也以它為準）。
 * Search: an empty query lists everything in catalogue order; otherwise every word must be found, best first, ties in
 * catalogue order. `locale` = the interface language (preferred on a tie, and what `via` is relative to).
 */
export function searchCatalogue(entries: CatalogueEntry[], query: string, dicts: Dictionaries, locale: string, filter: SearchFilter = {}): SearchHit[] {
    const pool = entries.filter((e) => (!filter.way || e.ways.includes(filter.way)) && (!filter.topic || e.topic === filter.topic));
    const words = queryWords(query);
    if (words.length === 0) return pool.map((entry) => ({ entry, score: 0, via: null }));
    const locales = [locale, ...Object.keys(dicts).filter((l) => l !== locale)];
    const hits: (SearchHit & { order: number })[] = [];
    pool.forEach((entry, order) => {
        const shared: Field[] = [
            { text: fold(entry.lines.join(" · ")), weight: 4 },
            { text: fold(entry.keywords.join(" · ")), weight: 3 },
        ];
        let best = 0;
        let via: string | null = null;
        for (const l of locales) {
            const s = score(words, [...fields(entry, dicts[l] ?? {}), ...shared]);
            if (s > best) {
                best = s;
                via = l === locale ? null : l;
            }
        }
        // 「靠別的語言找到」只在那個語言自己的標題 / 說明就含有每個詞時才算；靠指令、同義詞或主題名找到的不算
        // （不然結果列會寫出一句跟查詢無關的外語標題）。
        // "Found through another language" only counts when that language's own title / note holds every word; a match
        // by the command, a synonym or the topic name doesn't (the row would show a foreign title unrelated to the query).
        if (via !== null && score(words, fields(entry, dicts[via] ?? {}).slice(0, 3)) === 0) via = null;
        // 同樣找得到時，速查頁的任務（能填空、有圖）排在 CLI 範例前面。/ When both match, the sheet's own tasks (fill-in, illustrated) come before CLI examples.
        if (best > 0) hits.push({ entry, score: entry.kind === "task" ? best * 1.5 : best, via, order });
    });
    hits.sort((a, b) => b.score - a.score || a.order - b.order);
    return hits.map(({ entry, score: s, via }) => ({ entry, score: s, via }));
}

/** 範例的指令填上這個人的通道名稱（其他的 `<…>` 留著讓人自己填）。/ An example's lines with this person's tunnel filled in; other `<…>` stay. */
export function fillTunnel(lines: string[], tunnel: string): string[] {
    const safe = /^[A-Za-z0-9._@%+=:,/-]+$/.test(tunnel) ? tunnel : `'${tunnel.replace(/'/g, `'\\''`)}'`;
    return lines.map((l) => l.replaceAll("<tunnel>", safe));
}

/** 這張目錄裡每個工具做得到幾件事（對照圖的數字）。/ How many entries each tool can do (the comparison's numbers). */
export function wayCounts(entries: CatalogueEntry[]): { telepy: number; ssh: number; both: number; telepyOnly: number } {
    const both = entries.filter((e) => e.ways.includes("ssh") && e.ways.includes("telepy")).length;
    const telepy = entries.filter((e) => e.ways.includes("telepy")).length;
    return { telepy, ssh: entries.filter((e) => e.ways.includes("ssh")).length, both, telepyOnly: telepy - both };
}
