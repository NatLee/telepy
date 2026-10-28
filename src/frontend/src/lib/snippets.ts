/**
 * 工具箱（指令片段）的純函式：`$name` / `${name}` 變數的讀取與代換（Python `string.Template.safe_substitute`
 * 的語意：不認得的名稱原樣留著；但 `$$` 也原樣留著——它在 shell 裡是 PID，不是跳脫）、送進終端機的行、搜尋 /
 * 分組 / 最愛、內建範例，以及 info 圖每一站的狀態。
 * Pure helpers for the toolbox: reading and substituting `$name` / `${name}` variables (Python `safe_substitute`
 * semantics: unknown names survive — except that `$$` also survives, since it is the shell's PID, not an escape),
 * the lines typed into the terminal, search / grouping / favourites, the built-in examples and the info diagram.
 */
import { statesAlong, type SpotState } from "./flow.ts";
import type { TranslationKey } from "@/locales/en";
import type { HoldBanner } from "@/lib/commandRules";

export type SnippetScope = "user" | "tunnel" | "site";

export interface SnippetVariable {
    name: string;
    label: string;
    default: string;
    /** 秘密：輸入時遮住、值永遠不存。/ Secret: masked while typed, never stored. */
    secret: boolean;
}

export interface Snippet {
    id: number;
    scope: SnippetScope;
    tunnel_id: number | null;
    name: string;
    command: string;
    description: string;
    variables: SnippetVariable[];
    confirm: boolean;
    sort_order: number;
    use_count: number;
    last_used_at: string | null;
    can_edit: boolean;
    created_at: string;
    updated_at: string;
}

export interface SnippetList {
    snippets: Snippet[];
    tunnel: { id: number; name: string; can_use: boolean; can_edit: boolean } | null;
    can_edit_site: boolean;
    limit: number;
}

/** 新增 / 修改送出的內容。/ What a create / update sends. */
export interface SnippetDraft {
    name: string;
    command: string;
    description: string;
    variables: SnippetVariable[];
    confirm: boolean;
}

export const SCOPE_ORDER: SnippetScope[] = ["user", "tunnel", "site"];

const VAR_RE = /\$(?:(\$)|([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/g;

/** 指令裡出現的變數名稱（依出現順序、不重複；`$$` 不算）。/ Variable names in the command (in order, unique; `$$` skipped). */
export function variableRefs(command: string): string[] {
    const out: string[] = [];
    for (const m of command.matchAll(VAR_RE)) {
        const name = m[2] ?? m[3];
        if (name && !out.includes(name)) out.push(name);
    }
    return out;
}

/** 代換：有值的名稱換掉，其他（`$HOME`、`$(cmd)`、`$$`、`${x:-y}`）原樣留著。/ Substitute known names; leave the rest. */
export function substitute(command: string, values: Record<string, string>): string {
    return command.replace(VAR_RE, (whole, dollar: string | undefined, bare: string | undefined, braced: string | undefined) => {
        if (dollar) return whole;
        const name = bare ?? braced ?? "";
        return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole;
    });
}

/** 執行前要問的變數：有宣告、而且指令裡真的用到的（依宣告順序）。/ Variables to ask for: declared and used. */
export function askedVariables(s: Pick<Snippet, "command" | "variables">): SnippetVariable[] {
    const refs = new Set(variableRefs(s.command));
    return s.variables.filter((v) => refs.has(v.name));
}

/** 預設值（秘密變數一律空白）。/ Initial values (secrets always start empty). */
export function initialValues(vars: SnippetVariable[]): Record<string, string> {
    return Object.fromEntries(vars.map((v) => [v.name, v.secret ? "" : v.default]));
}

/** 預覽：秘密變數的值用 •••• 代替（填了才遮，沒填顯示 `$name`）。/ Preview with secret values masked. */
export function maskedPreview(command: string, vars: SnippetVariable[], values: Record<string, string>): string {
    const shown: Record<string, string> = {};
    for (const v of vars) {
        const val = values[v.name] ?? "";
        if (v.secret) {
            if (val) shown[v.name] = "••••";
        } else {
            shown[v.name] = val;
        }
    }
    return substitute(command, shown);
}

/** 送進終端機的行（`\r\n` / `\n` 都算換行；結尾的空行去掉）。/ The lines typed into the terminal. */
export function terminalLines(command: string): string[] {
    const lines = command.replace(/\r\n?/g, "\n").split("\n");
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    return lines;
}

export const isMultiline = (command: string) => terminalLines(command).length > 1;

/** 一行要送的輸入：打字 + Enter（不是括號貼上，指令規則才讀得到）。/ One line's input: typed text + Enter, never a bracketed paste. */
export function lineInput(line: string, enter: boolean): string {
    return enter ? `${line}\r` : line;
}

/** 搜尋：每個字都要出現在名稱 / 指令 / 說明裡（不分大小寫）。/ Every word must appear in the name, command or description. */
export function matchesQuery(s: Pick<Snippet, "name" | "command" | "description">, query: string): boolean {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const hay = `${s.name}\n${s.command}\n${s.description}`.toLowerCase();
    return words.every((w) => hay.includes(w));
}

export interface SnippetGroups {
    favourites: Snippet[];
    user: Snippet[];
    tunnel: Snippet[];
    site: Snippet[];
}

/** 依範圍分組；最愛放最上面一組（不在原本那組重複出現）。/ Group by scope; favourites on top (not repeated below). */
export function groupSnippets(list: Snippet[], query: string, favourites: number[]): SnippetGroups {
    const fav = new Set(favourites);
    const out: SnippetGroups = { favourites: [], user: [], tunnel: [], site: [] };
    for (const s of list) {
        if (!matchesQuery(s, query)) continue;
        if (fav.has(s.id)) out.favourites.push(s);
        else out[s.scope].push(s);
    }
    // 最愛照加入的順序。/ Favourites in the order they were starred.
    out.favourites.sort((a, b) => favourites.indexOf(a.id) - favourites.indexOf(b.id));
    return out;
}

/** localStorage 裡的最愛（壞資料 = 空）。/ Favourites from localStorage (garbage = none). */
export function parseFavourites(raw: string | null): number[] {
    if (!raw) return [];
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [];
    } catch {
        return [];
    }
}

export function toggleFavourite(list: number[], id: number): number[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/**
 * 編輯時的變數清單：指令裡每個 `$name` 一列；已宣告的保留設定，`asked` = 要不要在執行前問（沒問的照字面送，由 shell 展開）。
 * The editor's variable rows: one per `$name` in the command; declared ones keep their settings, `asked` = prompt
 * before running (unasked names are typed as is and the shell expands them).
 */
export function editorRows(command: string, declared: SnippetVariable[]): (SnippetVariable & { asked: boolean })[] {
    return variableRefs(command).map((name) => {
        const d = declared.find((v) => v.name === name);
        return d ? { ...d, asked: true } : { name, label: "", default: "", secret: false, asked: guessAsked(name) };
    });
}

/** 新出現的名稱預設要不要問：全大寫（`$HOME`、`$PATH`）多半是 shell 變數，不問。/ ALL-CAPS names are usually shell variables. */
export function guessAsked(name: string): boolean {
    return name !== name.toUpperCase();
}

/** 存檔用的變數：只留要問的，秘密變數不帶預設值。/ Variables to save: asked ones only, secrets without a default. */
export function declaredFromRows(rows: (SnippetVariable & { asked: boolean })[]): SnippetVariable[] {
    return rows.filter((r) => r.asked).map(({ name, label, default: def, secret }) => ({ name, label: label.trim(), default: secret ? "" : def, secret }));
}

// ---------------------------------------------------------------- built-in examples

export interface BuiltinSnippet {
    id: string;
    nameKey: TranslationKey;
    descKey: TranslationKey;
    command: string;
    variables?: { name: string; labelKey: TranslationKey; default: string }[];
    confirm?: boolean;
}

/** 空的工具箱提供的範例（一鍵加到「我的」）。/ Examples an empty toolbox offers (one click adds to Mine). */
export const BUILTIN_SNIPPETS: BuiltinSnippet[] = [
    { id: "disk", nameKey: "toolbox.builtin.disk", descKey: "toolbox.builtin.diskDesc", command: "df -h" },
    {
        id: "bigDirs", nameKey: "toolbox.builtin.bigDirs", descKey: "toolbox.builtin.bigDirsDesc",
        command: "du -xh -d 1 ${path} 2>/dev/null | sort -h | tail -n 15",
        variables: [{ name: "path", labelKey: "toolbox.builtin.varFolder", default: "." }],
    },
    { id: "memory", nameKey: "toolbox.builtin.memory", descKey: "toolbox.builtin.memoryDesc", command: "free -h" },
    { id: "topCpu", nameKey: "toolbox.builtin.topCpu", descKey: "toolbox.builtin.topCpuDesc", command: "ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu | head -n 15" },
    { id: "ports", nameKey: "toolbox.builtin.ports", descKey: "toolbox.builtin.portsDesc", command: "ss -tulpn 2>/dev/null || netstat -tulpn" },
    { id: "uptime", nameKey: "toolbox.builtin.uptime", descKey: "toolbox.builtin.uptimeDesc", command: "uptime" },
    { id: "osInfo", nameKey: "toolbox.builtin.osInfo", descKey: "toolbox.builtin.osInfoDesc", command: "uname -a\nhead -n 4 /etc/os-release 2>/dev/null" },
    {
        id: "journal", nameKey: "toolbox.builtin.journal", descKey: "toolbox.builtin.journalDesc",
        command: "journalctl -u $unit -n $lines --no-pager",
        variables: [
            { name: "unit", labelKey: "toolbox.builtin.varService", default: "ssh" },
            { name: "lines", labelKey: "toolbox.builtin.varLines", default: "100" },
        ],
    },
    {
        id: "serviceStatus", nameKey: "toolbox.builtin.serviceStatus", descKey: "toolbox.builtin.serviceStatusDesc",
        command: "systemctl status $unit --no-pager",
        variables: [{ name: "unit", labelKey: "toolbox.builtin.varService", default: "ssh" }],
    },
    {
        id: "restartService", nameKey: "toolbox.builtin.restartService", descKey: "toolbox.builtin.restartServiceDesc",
        command: "sudo systemctl restart $unit",
        variables: [{ name: "unit", labelKey: "toolbox.builtin.varService", default: "" }],
        confirm: true,
    },
    { id: "dockerPs", nameKey: "toolbox.builtin.dockerPs", descKey: "toolbox.builtin.dockerPsDesc", command: "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'" },
    {
        id: "dockerLogs", nameKey: "toolbox.builtin.dockerLogs", descKey: "toolbox.builtin.dockerLogsDesc",
        command: "docker logs --tail $lines $container",
        variables: [
            { name: "container", labelKey: "toolbox.builtin.varContainer", default: "" },
            { name: "lines", labelKey: "toolbox.builtin.varLines", default: "100" },
        ],
    },
    {
        id: "gitStatus", nameKey: "toolbox.builtin.gitStatus", descKey: "toolbox.builtin.gitStatusDesc",
        command: "git -C ${repo} status -sb",
        variables: [{ name: "repo", labelKey: "toolbox.builtin.varFolder", default: "." }],
    },
];

/** 範例 → 新增的內容（名稱與標籤用目前的語言）。/ An example → a draft, in the current language. */
export function draftFromBuiltin(b: BuiltinSnippet, t: (key: TranslationKey) => string): SnippetDraft {
    return {
        name: t(b.nameKey),
        command: b.command,
        description: t(b.descKey),
        variables: (b.variables ?? []).map((v) => ({ name: v.name, label: t(v.labelKey), default: v.default, secret: false })),
        confirm: b.confirm ?? false,
    };
}

/** 已經加過的範例（同樣的指令）。/ Examples already added (same command). */
export function addedBuiltins(list: Pick<Snippet, "command">[]): Set<string> {
    const commands = new Set(list.map((s) => s.command));
    return new Set(BUILTIN_SNIPPETS.filter((b) => commands.has(b.command)).map((b) => b.id));
}

// ---------------------------------------------------------------- info diagram

/** 最近一次執行走到哪。/ How far the latest run got. */
export type RunStage = "idle" | "filling" | "typing" | "sent" | "held" | "blocked";

export type ToolboxSpot = "snippet" | "fill" | "variables" | "type" | "shell" | "check" | "rules" | "ssh" | "device";

const SPOTS: readonly ToolboxSpot[] = ["snippet", "fill", "variables", "type", "shell", "check", "rules", "ssh", "device"];

/** 每一站 / 每一段的狀態。/ The state of every node and link. */
export function toolboxSpotStates(stage: RunStage): Record<ToolboxSpot, SpotState> {
    switch (stage) {
        case "idle":
            return statesAlong(SPOTS, {});
        case "filling":
            return statesAlong(SPOTS, { activeFrom: "fill", activeTo: "variables" });
        case "typing":
            return statesAlong(SPOTS, { activeFrom: "type", activeTo: "check" });
        case "held":
            return statesAlong(SPOTS, { activeFrom: "rules" });
        case "blocked":
            return statesAlong(SPOTS, { failedAt: "rules" });
        case "sent":
            return statesAlong(SPOTS, { done: true });
    }
}

/** 圖上方「現在」那一行的字。/ The "right now" line above the diagram. */
export function runNowKey(stage: RunStage): TranslationKey {
    return `toolbox.flow.now.${stage}` as TranslationKey;
}

/** 指令規則通知 → 這次執行的結果（沒有通知 = 已送出）。/ A command-rule notice → the run's outcome. */
export function stageFromBanner(state: "pending" | "blocked" | "error" | "warned" | "approved" | "denied" | "cancelled" | "expired"): RunStage {
    switch (state) {
        case "pending":
            return "held";
        // 提醒：指令照跑了。/ A reminder: the command ran.
        case "warned":
        case "approved":
            return "sent";
        default:
            return "blocked";
    }
}

// ---------------------------------------------------------------- typing into the terminal

/** 工具箱要送進去的那個終端機。/ The terminal a toolbox types into. */
export interface ToolboxTarget {
    tunnelId: number;
    /** 送一段輸入到 shell（跟鍵盤同一條 `pty_input`）；沒連線回 false。/ Send input like the keyboard does; false when offline. */
    send: (input: string) => boolean;
    /** 訂閱輸出（等上一行跑完再送下一行用）；回傳取消訂閱。/ Subscribe to output; returns the unsubscribe. */
    onOutput: (cb: () => void) => () => void;
    connected: boolean;
    /**
     * 這個終端機現在的指令規則提示（每次呼叫讀最新的；面板收起來之後也要讀得到，所以不是 prop）。
     * The terminal's current command-rule banner, read fresh on every call (still readable after the panel closes).
     */
    banner: () => HoldBanner | null;
    /** 「帳號@裝置」之類，顯示在哪裡跑。/ Where it runs, e.g. "account@device". */
    where: string;
}

/**
 * 等輸出安靜下來：上一行的輸出停了 `quietMs` 再回來（一直沒輸出就等 2 × quietMs），最多 `maxMs`。
 * Wait until output settles: `quietMs` after the last output (2 × quietMs when nothing comes), at most `maxMs`.
 */
export function settle(onOutput: ToolboxTarget["onOutput"], quietMs = 350, maxMs = 5000): Promise<void> {
    return new Promise((resolve) => {
        let finished = false;
        let off: () => void = () => { };
        let quiet: ReturnType<typeof setTimeout>;
        const done = () => {
            if (finished) return;
            finished = true;
            clearTimeout(quiet);
            clearTimeout(cap);
            off();
            resolve();
        };
        quiet = setTimeout(done, quietMs * 2);
        const cap = setTimeout(done, maxMs);
        off = onOutput(() => {
            clearTimeout(quiet);
            quiet = setTimeout(done, quietMs);
        });
    });
}

/**
 * 一行一行打進去，每行一個 Enter；下一行等輸出安靜了再送（指令規則就能單獨讀到每一行），被擋 / 等核准就停。
 * Insert（`enter` = false）只送一行、不按 Enter。
 * Type the lines one Enter each; the next waits for output to settle (so command rules read each line on its own),
 * and a block / hold stops the rest. Insert (`enter` false) types one line without Enter.
 */
export async function typeLines(
    lines: string[],
    enter: boolean,
    deps: { send: (input: string) => boolean; settle: () => Promise<void>; stopped: () => boolean },
): Promise<"done" | "stopped" | "offline"> {
    if (!enter) return deps.send(lineInput(lines.join(" "), false)) ? "done" : "offline";
    for (let i = 0; i < lines.length; i++) {
        if (deps.stopped()) return "stopped";
        if (!deps.send(lineInput(lines[i], true))) return "offline";
        if (i < lines.length - 1) await deps.settle();
    }
    return "done";
}
