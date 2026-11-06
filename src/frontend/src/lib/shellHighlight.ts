/**
 * 一行 shell 指令拆成上色用的片段（純函式）：指令、`telepy` 的子指令、旗標、`<佔位字>`、引號字串、變數、運算子、註解。
 * 拼回去一定等於原文（空白也是片段），所以複製的永遠是原本那行。CLI 頁和指令速查頁共用；顏色在 `globals.css` 的 `--code-*`。
 * Splits one shell line into coloured pieces (pure): commands, `telepy`'s subcommands, flags, `<placeholders>`,
 * quoted strings, variables, operators, comments. Joined back they always equal the input (spaces are pieces too), so
 * what gets copied is the line as written. Shared by the CLI page and the command sheet; colours are `--code-*`.
 */

export type ShellKind = "telepy" | "cmd" | "sub" | "flag" | "placeholder" | "string" | "var" | "op" | "comment" | "arg" | "space";

export interface ShellPiece {
    text: string;
    kind: ShellKind;
}

/** 一個詞裡的 `<…>` 佔位字分開標。/ `<…>` placeholders inside a word get their own pieces. */
function splitPlaceholders(word: string, kind: ShellKind, out: ShellPiece[]) {
    let last = 0;
    for (const m of word.matchAll(/<[^<>\s]+>/g)) {
        if (m.index! > last) out.push({ text: word.slice(last, m.index), kind });
        out.push({ text: m[0], kind: "placeholder" });
        last = m.index! + m[0].length;
    }
    if (last < word.length) out.push({ text: word.slice(last), kind });
}

/** 讀一個「詞」：引號內的空白不斷開。/ Read one word; spaces inside quotes don't end it. */
function readWord(line: string, from: number, synopsis = false): number {
    let i = from;
    let quote: string | null = null;
    while (i < line.length) {
        const c = line[i];
        if (quote) {
            if (c === quote) quote = null;
            else if (c === "\\" && quote === '"') i++;
        } else if (c === "'" || c === '"') quote = c;
        else if (c === " " || c === "\t" || c === "|" || c === ";" || (c === ")" && !synopsis) || (c === "&" && line[i + 1] === "&")) break;
        else if (c === "$" && line[i + 1] === "(" && i > from) break;
        i++;
    }
    return i;
}

/** `telepy` 的子指令樹：第一層 → 它下面的子指令。/ telepy's subcommands: first level → the ones below it. */
export type SubcommandTree = Readonly<Record<string, readonly string[]>>;

/**
 * `tree`：`telepy` 後面哪些詞算子指令（第一層，與它下面的第二層）；其他詞是參數。
 * `tree`: which words after `telepy` are subcommands (first level, and the second level below it); others are arguments.
 * `synopsis`：用法說明（`ls | map [--json] <tunnel>`）而不是指令：`|` 是「或」、`[ ]` 包住的照裡面的東西上色。
 * `synopsis`: a usage line (`ls | map [--json] <tunnel>`), not a command: `|` means "or" and bracketed words are
 * coloured by what is inside. `telepy` itself is its own kind (the brand colour).
 */
export function highlightShell(line: string, tree: SubcommandTree = {}, synopsis = false): ShellPiece[] {
    const out: ShellPiece[] = [];
    let i = 0;
    let expectCommand = true;
    let program: string | null = null;
    let subs = 0;
    let first: string | null = null;
    while (i < line.length) {
        const c = line[i];
        if (c === " " || c === "\t") {
            let j = i;
            while (j < line.length && (line[j] === " " || line[j] === "\t")) j++;
            out.push({ text: line.slice(i, j), kind: "space" });
            i = j;
            continue;
        }
        if (c === "#" && (i === 0 || line[i - 1] === " ")) {
            out.push({ text: line.slice(i), kind: "comment" });
            break;
        }
        if (synopsis && c === "|") {
            // 「或」：下一個詞可以又是第二層的子指令。/ "Or": the next word may be a second-level subcommand again.
            out.push({ text: c, kind: "op" });
            i++;
            if (first !== null) subs = 1;
            continue;
        }
        const op = line.startsWith("$(", i) ? "$(" : line.startsWith("&&", i) ? "&&" : line.startsWith("||", i) ? "||" : "|;)".includes(c) ? c : null;
        if (op) {
            out.push({ text: op, kind: "op" });
            i += op.length;
            expectCommand = op !== ")";
            continue;
        }
        const end = Math.max(readWord(line, i, synopsis), i + 1);
        let word = line.slice(i, end);
        i = end;
        let tail = "";
        if (synopsis) {
            // `[--json]`、`[ls]`：括號先拿掉，裡面照常上色。/ Brackets come off; the inside is coloured as usual.
            const lead = word.match(/^[[(]+/)?.[0] ?? "";
            if (lead) out.push({ text: lead, kind: "op" });
            word = word.slice(lead.length);
            tail = word.match(/[\])…]+$/)?.[0] ?? "";
            word = word.slice(0, word.length - tail.length);
            if (!word) {
                if (tail) out.push({ text: tail, kind: "op" });
                continue;
            }
        }
        classify(word);
        if (tail) out.push({ text: tail, kind: "op" });
    }
    return out;

    function classify(word: string) {
        if (expectCommand && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
            // `NAME=value cmd`：變數設定，後面還是指令。/ An assignment; a command still follows.
            const eq = word.indexOf("=") + 1;
            out.push({ text: word.slice(0, eq), kind: "var" });
            splitPlaceholders(word.slice(eq), "arg", out);
            return;
        }
        if (expectCommand) {
            out.push({ text: word, kind: word === "telepy" ? "telepy" : "cmd" });
            program = word;
            subs = 0;
            first = null;
            expectCommand = word === "export" || word === "sudo" || word === "env";
            return;
        }
        if (/^['"]/.test(word)) {
            out.push({ text: word, kind: word.includes("$") ? "var" : "string" });
            return;
        }
        if (/^\$[A-Za-z_{]/.test(word)) {
            out.push({ text: word, kind: "var" });
            return;
        }
        if (/^--?[A-Za-z]/.test(word)) {
            const eq = word.indexOf("=");
            if (eq > 0) {
                out.push({ text: word.slice(0, eq + 1), kind: "flag" });
                splitPlaceholders(word.slice(eq + 1), "arg", out);
            } else out.push({ text: word, kind: "flag" });
            subs = 2;
            return;
        }
        const isSub = program === "telepy" && (subs === 0 ? Object.hasOwn(tree, word) : subs === 1 && first !== null && tree[first]?.includes(word));
        if (isSub) {
            out.push({ text: word, kind: "sub" });
            if (subs === 0) first = word;
            subs++;
            return;
        }
        subs = 2;
        splitPlaceholders(word, "arg", out);
    }
}
