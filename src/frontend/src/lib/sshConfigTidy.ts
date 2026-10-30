/**
 * ~/.ssh/config 簡化（純函式，不碰 React，整段在瀏覽器裡跑——貼上的設定不會送出去）。
 * 規則照 OpenSSH 的原始碼（readconf.c / ssh.c / match.c，2026-10 的 master）：
 * - 由上往下讀，每個選項用「第一個讀到的值」；只有 IdentityFile、CertificateFile、LocalForward、RemoteForward、
 *   DynamicForward、SendEnv 會累加（照順序）。ProxyJump 只在 ProxyCommand 和 ProxyJump 都還沒設定時才算數。
 * - `Host` 比對的是打進去的名稱，**分大小寫**（`match_pattern`；ssh 讀完設定才轉小寫），`*` / `?` 是萬用字元，
 *   `!` 開頭的樣式比中就整段不算。
 * - `HostName` 裡的 `%h` 換成打進去的名稱——所以 `Host web1` 底下的 `HostName web1.example.com` 跟
 *   `HostName %h.example.com` 完全一樣。
 * 簡化只做「對每個名稱讀起來都一模一樣」的改寫，每一步都逐一驗證：改到的區塊都只寫明確的名稱（沒有萬用字元），
 * 所以會變的只有這些名稱，把它們一個一個解析一遍、跟原本比就是完整的證明。`Match` / `Include` 是牆：
 * 任何一行都不會跨過它們。萬用字元是選項，而且只在檔案裡沒有別的名稱會被它吃到時才用（會多套用到「打其他符合的名稱」，
 * 結果裡列出來）。
 * Telepy 自己的區塊（`# >>> telepy <別名> >>>`）只跟同一台伺服器的裝置合併，共用的設定放進
 * `# >>> telepy shared <伺服器別名> >>>`；裝置自己的標記、ProxyCommand 一律留著（重跑指令與同名偵測靠它們）。
 *
 * Simplifying ~/.ssh/config (pure, no React; it all runs in the browser — a pasted config is never sent anywhere).
 * The rules follow OpenSSH's source (readconf.c / ssh.c / match.c, master as of 2026-10):
 * - Read top to bottom; every option keeps the first value obtained, except IdentityFile, CertificateFile,
 *   LocalForward, RemoteForward, DynamicForward and SendEnv, which add up in order. ProxyJump only counts while
 *   neither ProxyCommand nor ProxyJump is set.
 * - `Host` matches the name as typed, **case-sensitively** (`match_pattern`; ssh lowercases only after reading the
 *   config); `*` / `?` are wildcards and a matching `!pattern` turns the whole block off.
 * - `%h` in `HostName` is the typed name, so `HostName web1.example.com` under `Host web1` equals
 *   `HostName %h.example.com`.
 * Only rewrites that read exactly the same for every name are made, and each one is verified: blocks it touches
 * name hosts literally (no wildcards), so the only names whose result can change are those, and resolving each of
 * them again against the original is a complete check. `Match` / `Include` are walls — no line ever crosses one.
 * Wildcards are opt-in and used only when no other name in the file would be caught (they also apply to any other
 * matching name typed later; the result lists that).
 * Telepy's own blocks (`# >>> telepy <alias> >>>`) are only grouped with devices of the same server, into
 * `# >>> telepy shared <server alias> >>>`; a device keeps its markers and its ProxyCommand (re-running the install
 * command and the same-name check rely on them).
 */

// ── OpenSSH ──────────────────────────────────────────────────────────────────

/** 照順序累加的選項（readconf.c：add_identity_file、add_local_forward、SendEnv 的 opt_array_append…）。/ Options that add up. */
const ACCUMULATE = new Set(["identityfile", "certificatefile", "localforward", "remoteforward", "dynamicforward", "sendenv"]);
/** 值是整段原文（`str + strspn(str, WHITESPACE "=")`），不拆字。/ Values taken verbatim, not split into words. */
const VERBATIM = new Set(["proxycommand", "proxyjump", "localcommand", "remotecommand", "knownhostscommand"]);
/** 同一個設定的別名（keywords[] 裡指到同一個 opcode）。/ Keywords that share one setting (same opcode). */
const SLOT_ALIASES: Record<string, string> = {
    identityfile2: "identityfile",
    hostbasedkeytypes: "hostbasedacceptedalgorithms",
    pubkeyacceptedkeytypes: "pubkeyacceptedalgorithms",
    challengeresponseauthentication: "kbdinteractiveauthentication",
    skeyauthentication: "kbdinteractiveauthentication",
    tisauthentication: "kbdinteractiveauthentication",
    smartcarddevice: "pkcs11provider",
    dsaauthentication: "pubkeyauthentication",
    keepalive: "tcpkeepalive",
};
/** OpenSSH 認得的關鍵字（readconf.c 的 keywords[]）。/ The keywords OpenSSH knows. */
const KEYWORDS = new Set(
    ("addkeystoagent addressfamily afstokenpassing batchmode bindaddress bindinterface canonicaldomains canonicalizefallbacklocal " +
        "canonicalizehostname canonicalizemaxdots canonicalizepermittedcnames casignaturealgorithms certificatefile " +
        "challengeresponseauthentication channeltimeout checkhostip cipher ciphers clearallforwardings compression compressionlevel " +
        "connectionattempts connecttimeout controlmaster controlpath controlpersist dsaauthentication dynamicforward " +
        "enableescapecommandline enablesshkeysign escapechar exitonforwardfailure fallbacktorsh fingerprinthash forkafterauthentication " +
        "forwardagent forwardx11 forwardx11timeout forwardx11trusted gatewayports globalknownhostsfile globalknownhostsfile2 " +
        "gssapiauthentication gssapidelegatecredentials hashknownhosts host hostbasedacceptedalgorithms hostbasedauthentication " +
        "hostbasedkeytypes hostkeyalgorithms hostkeyalias hostname identitiesonly identityagent identityfile identityfile2 ignoreunknown " +
        "include ipqos kbdinteractiveauthentication kbdinteractivedevices keepalive kerberosauthentication kerberostgtpassing kexalgorithms " +
        "knownhostscommand localcommand localforward loglevel logverbose macs match nohostauthenticationforlocalhost numberofpasswordprompts " +
        "obscurekeystroketiming passwordauthentication permitlocalcommand permitremoteopen pkcs11provider port preferredauthentications " +
        "protocol proxycommand proxyjump proxyusefdpass pubkeyacceptedalgorithms pubkeyacceptedkeytypes pubkeyauthentication " +
        "refuseconnection rekeylimit remotecommand remoteforward requesttty requiredrsasize revokedhostkeys rhostsauthentication " +
        "rhostsrsaauthentication rsaauthentication securitykeyprovider sendenv serveralivecountmax serveraliveinterval sessiontype setenv " +
        "skeyauthentication smartcarddevice stdinnull streamlocalbindmask streamlocalbindunlink stricthostkeychecking syslogfacility tag " +
        "tcpkeepalive tisauthentication tunnel tunneldevice updatehostkeys useprivilegedport user userknownhostsfile userknownhostsfile2 " +
        "useroaming usersh verifyhostkeydns versionaddendum visualhostkey warnweakcrypto xauthlocation").split(" "),
);
/** ssh 讀到會略過的舊選項（oDeprecated / oUnsupported / oIgnore）。/ Old options ssh skips with a warning. */
const IGNORED = new Set(
    "afstokenpassing cipher compressionlevel fallbacktorsh globalknownhostsfile2 kerberosauthentication kerberostgtpassing protocol rhostsauthentication rhostsrsaauthentication rsaauthentication useprivilegedport userknownhostsfile2 useroaming usersh".split(" "),
);
/** 一行 Host 最長寫多長（舊版 OpenSSH 一行讀 4096 bytes，留足空間）。/ The longest Host line written (old OpenSSH read 4096-byte lines). */
const HOST_LINE_MAX = 1000;
/** 至少省這麼多行才值得多一個區塊。/ A new block must save at least this many lines. */
const MIN_SAVING = 2;
const OPEN_MARKER = /^# >>> telepy (.+) >>>$/;
const CLOSE_MARKER = /^# <<< telepy (.+) <<<$/;
/** Telepy 產生的裝置 ProxyCommand：`ssh -W %h:%p <伺服器別名>`。/ The device ProxyCommand Telepy writes. */
/** Telepy 裝置區塊裡不搬的選項。/ Options a Telepy device block always keeps. */
const TELEPY_PINNED = new Set(["proxycommand", "proxyjump", "hostkeyalias"]);
const TELEPY_JUMP = /^ssh\s(?:.*\s)?-W\s+\S+\s+([A-Za-z0-9._-]+)$/;

// ── Lines and blocks ─────────────────────────────────────────────────────────

export type LineKind = "blank" | "comment" | "option" | "invalid";

export interface CfgLine {
    /** 原檔的行號（1 起算）；簡化時新寫的行是 0。/ 1-based line in the source; 0 for lines tidy wrote. */
    n: number;
    raw: string;
    kind: LineKind;
    /** 原本的寫法（`HostName`）。/ The keyword as written. */
    key: string;
    /** 小寫、別名歸一（`hostname`）。/ Lower case, aliases folded. */
    slot: string;
    args: string[];
    /** 關鍵字和分隔符號之後的原文。/ The text after the keyword and its separator. */
    rest: string;
}

export type Owner =
    | { kind: "user" }
    | { kind: "telepy"; server: string }
    | { kind: "shared"; server: string }
    | { kind: "frozen" };

export interface CfgBlock {
    kind: "global" | "host" | "match";
    /** Host 行前面的註解、空行（含 Telepy 的開頭標記）。/ Comments and blanks before the header (incl. Telepy's open marker). */
    lead: CfgLine[];
    header: CfgLine | null;
    body: CfgLine[];
    /** 區塊後面屬於它的結尾標記。/ The close marker that belongs to this block. */
    tail: CfgLine[];
    patterns: string[];
    owner: Owner;
    /** 開頭標記的名字（`pi` / `shared telepy-x-24242`）。/ The open marker's name. */
    marker: string | null;
    /** Match、含 Include 或讀不懂的行：不動它，也不讓任何一行跨過它。/ Never touched, never crossed. */
    barrier: boolean;
    /** 每個樣式都是明確的名稱。/ Every pattern is a plain name. */
    literal: boolean;
    /** 簡化時新加的共用區塊。/ A shared block tidy added. */
    made?: boolean;
    /** 選項全被搬走、整段拿掉（前面的註解留著）。/ Every option moved out; dropped (its leading comments stay). */
    dropped?: boolean;
}

export interface ParsedConfig {
    blocks: CfgBlock[];
    /** 最後一個區塊後面的註解、空行。/ Comments and blanks after the last block. */
    trailer: CfgLine[];
    indent: string;
    newline: "\n" | "\r\n";
    endsWithNewline: boolean;
    /** Host 之前大多空一行。/ Host blocks are usually separated by a blank line. */
    spaced: boolean;
}

/** OpenSSH 的 argv_split：空白分隔、`"` / `'` 引號、反斜線跳脫，`#` 開頭的字之後是註解。null = 引號沒關。 */
function argvSplit(s: string): string[] | null {
    const out: string[] = [];
    let i = 0;
    while (i < s.length) {
        if (s[i] === " " || s[i] === "\t") {
            i++;
            continue;
        }
        if (s[i] === "#") break;
        let arg = "";
        let quote = "";
        for (; i < s.length; i++) {
            const c = s[i];
            if (c === "\\" && i + 1 < s.length && (s[i + 1] === "'" || s[i + 1] === '"' || s[i + 1] === "\\" || (!quote && s[i + 1] === " "))) {
                arg += s[++i];
            } else if (!quote && (c === " " || c === "\t")) break;
            else if (!quote && (c === '"' || c === "'")) quote = c;
            else if (quote && c === quote) quote = "";
            else arg += c;
        }
        if (quote) return null;
        out.push(arg);
    }
    return out;
}

function line(n: number, raw: string): CfgLine {
    const base = { n, raw, key: "", slot: "", args: [] as string[], rest: "" };
    const s = raw.replace(/[ \t\r]+$/, "").replace(/^[ \t]+/, "");
    if (!s) return { ...base, kind: "blank" };
    if (s.startsWith("#")) return { ...base, kind: "comment" };
    const m = /^([^\s=]+)[ \t]*(?:=[ \t]*)?(.*)$/.exec(s);
    if (!m) return { ...base, kind: "invalid" };
    const lower = m[1].toLowerCase();
    const args = argvSplit(m[2]);
    if (args === null) return { ...base, kind: "invalid", key: m[1], slot: lower, rest: m[2] };
    return { ...base, kind: "option", key: m[1], slot: SLOT_ALIASES[lower] ?? lower, args, rest: m[2] };
}

const isWild = (p: string) => /[*?!]/.test(p);
/** 能原樣寫回 Host 行的名稱（沒有空白、引號、跳脫、萬用字元）。/ A name that can go back on a Host line as is. */
const plainName = (p: string) => /^[^\s"'\\#*?!]+$/.test(p);

function newBlock(kind: CfgBlock["kind"], header: CfgLine | null, lead: CfgLine[]): CfgBlock {
    const patterns = kind === "host" && header ? header.args : [];
    return {
        kind,
        lead,
        header,
        body: [],
        tail: [],
        patterns,
        owner: { kind: "user" },
        marker: null,
        barrier: kind === "match",
        literal: kind === "host" && patterns.length > 0 && patterns.every(plainName),
    };
}

/** 區塊最後一個選項後面的行：結尾標記以前留在區塊，其餘交給下一個區塊。/ Split the lines after a block's last option. */
function closeBlock(b: CfgBlock): CfgLine[] {
    let last = b.body.length - 1;
    while (last >= 0 && (b.body[last].kind === "blank" || b.body[last].kind === "comment")) last--;
    const suffix = b.body.slice(last + 1);
    b.body = b.body.slice(0, last + 1);
    const at = b.marker ? suffix.findIndex((l) => l.raw.trimEnd() === `# <<< telepy ${b.marker} <<<`) : -1;
    if (at < 0) return suffix;
    b.tail = suffix.slice(0, at + 1);
    return suffix.slice(at + 1);
}

function markerOf(lead: CfgLine[]): string | null {
    const last = lead[lead.length - 1];
    const m = last && OPEN_MARKER.exec(last.raw.trimEnd());
    return m ? m[1] : null;
}

/** 文字 → 區塊。/ Text → blocks. */
export function parseConfig(text: string): ParsedConfig {
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const rawLines = text.split(/\r?\n/);
    const endsWithNewline = rawLines.length > 1 && rawLines[rawLines.length - 1] === "";
    if (endsWithNewline) rawLines.pop();
    const blocks: CfgBlock[] = [newBlock("global", null, [])];
    let cur = blocks[0];
    rawLines.forEach((raw, i) => {
        const l = line(i + 1, raw);
        if (l.kind === "option" && (l.slot === "host" || l.slot === "match")) {
            const lead = closeBlock(cur);
            cur = newBlock(l.slot === "host" ? "host" : "match", l, lead);
            cur.marker = markerOf(lead);
            blocks.push(cur);
        } else cur.body.push(l);
    });
    const trailer = closeBlock(cur);

    // 標記：只有「開頭標記 → 一個 Host 區塊 → 結尾標記」是 Telepy 的；跨好幾個區塊的整段都不動。
    // Markers: only "open marker → one Host block → close marker" is Telepy's; a region spanning several blocks is frozen.
    let open: string | null = null;
    for (const b of blocks) {
        const clean = b.marker !== null && b.tail.length > 0;
        for (const l of b.lead) {
            const o = OPEN_MARKER.exec(l.raw.trimEnd());
            const c = CLOSE_MARKER.exec(l.raw.trimEnd());
            if (o) open = o[1];
            else if (c && c[1] === open) open = null;
        }
        if (clean) {
            open = null;
            const shared = /^shared (\S+)$/.exec(b.marker!);
            const jump = b.body.find((l) => l.kind === "option" && (l.slot === "proxycommand" || l.slot === "proxyjump"));
            const via = jump ? (jump.slot === "proxyjump" ? jump.args[0] : TELEPY_JUMP.exec(jump.rest.trim())?.[1]) : undefined;
            if (shared) b.owner = { kind: "shared", server: shared[1] };
            else if (b.patterns.length === 1 && b.patterns[0] === b.marker && via && via !== b.marker) b.owner = { kind: "telepy", server: via };
            else b.owner = { kind: "frozen" };
        } else if (open !== null) b.owner = { kind: "frozen" };
        for (const l of b.body) {
            if (l.kind === "invalid" || l.slot === "include") b.barrier = true;
        }
    }

    const indents = new Map<string, number>();
    for (const b of blocks) {
        if (b.kind === "global") continue;
        for (const l of b.body) {
            const ind = /^[ \t]*/.exec(l.raw)![0];
            if (l.kind === "option" && ind) indents.set(ind, (indents.get(ind) ?? 0) + 1);
        }
    }
    const indent = [...indents.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "    ";
    const headed = blocks.filter((b) => b.kind !== "global").slice(1);
    const spaced = headed.length > 0 && headed.filter((b) => b.lead.length > 0 && b.lead[0].kind === "blank").length * 2 >= headed.length;
    return { blocks, trailer, indent, newline, endsWithNewline, spaced };
}

// ── Matching and resolving ───────────────────────────────────────────────────

const globCache = new Map<string, RegExp>();
/** match.c 的 match_pattern：`*`、`?`，分大小寫。/ match_pattern: `*`, `?`, case-sensitive. */
export function globMatch(s: string, pattern: string): boolean {
    let re = globCache.get(pattern);
    if (!re) {
        re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*").replace(/\?/g, "[\\s\\S]") + "$");
        globCache.set(pattern, re);
    }
    return re.test(s);
}

/** readconf.c 的 oHost：有一個正樣式比中、而且沒有 `!` 樣式比中。/ oHost: a positive pattern matches and no `!pattern` does. */
export function hostMatches(patterns: string[], host: string): boolean {
    let active = false;
    for (const p of patterns) {
        const negated = p.startsWith("!");
        if (globMatch(host, negated ? p.slice(1) : p)) {
            if (negated) return false;
            active = true;
        }
    }
    return active;
}

function applies(b: CfgBlock, host: string, matchAll = false): boolean {
    if (b.dropped) return false;
    if (b.kind === "match") return matchAll;
    return b.kind === "global" || hostMatches(b.patterns, host);
}

/** 比較用的值：HostName 把 `%h` 展開（只有它取決於打進去的名稱）。/ The value compared; HostName expands `%h`. */
function valueText(l: CfgLine, host: string): string {
    if (VERBATIM.has(l.slot)) return l.rest.trim();
    if (l.slot === "hostname") return (l.args[0] ?? "").replace(/%([%h])/g, (_, c) => (c === "%" ? "%" : host));
    return l.args.join("\u0000");
}

export interface Source {
    text: string;
    line: CfgLine;
    block: CfgBlock;
}

export interface Effect {
    /** 第一個值算數的選項。/ First-value options. */
    first: Map<string, Source>;
    /** 累加的選項。/ Options that add up. */
    lists: Map<string, Source[]>;
}

/**
 * 照 OpenSSH 的順序把一串區塊套到一個名稱上。Match 區塊沒辦法事先知道：`matchAll` = 當成全部成立，否則全部略過。
 * Apply blocks to a name the way ssh does. Match blocks can't be known in advance: `matchAll` treats them all as
 * matching, otherwise they are all skipped.
 */
export function resolve(blocks: CfgBlock[], host: string, matchAll = false): Effect {
    const first = new Map<string, Source>();
    const lists = new Map<string, Source[]>();
    for (const b of blocks) {
        if (!applies(b, host, matchAll)) continue;
        for (const l of b.body) {
            if (l.kind !== "option" || l.slot === "include") continue;
            const src = { text: valueText(l, host), line: l, block: b };
            if (ACCUMULATE.has(l.slot)) lists.set(l.slot, [...(lists.get(l.slot) ?? []), src]);
            else if (l.slot === "proxyjump") {
                if (!first.has("proxycommand") && !first.has("proxyjump")) first.set("proxyjump", src);
            } else if (!first.has(l.slot)) first.set(l.slot, src);
        }
    }
    return { first, lists };
}

function sameEffect(a: Effect, b: Effect): boolean {
    if (a.first.size !== b.first.size || a.lists.size !== b.lists.size) return false;
    for (const [k, v] of a.first) if (b.first.get(k)?.text !== v.text) return false;
    for (const [k, v] of a.lists) {
        const w = b.lists.get(k);
        if (!w || w.length !== v.length || w.some((x, i) => x.text !== v[i].text)) return false;
    }
    return true;
}

/** 牆（Match / Include）之間的一段。/ The runs of blocks between walls (Match / Include). */
function segments(blocks: CfgBlock[]): CfgBlock[][] {
    const out: CfgBlock[][] = [[]];
    for (const b of blocks) {
        if (b.barrier) out.push([]);
        else out[out.length - 1].push(b);
    }
    return out.filter((s) => s.length > 0);
}

// ── Result ───────────────────────────────────────────────────────────────────

export type Change =
    /** 同一個區塊裡又寫了一次一樣的值。/ The same value again in the same block. */
    | { kind: "duplicate"; n: number; key: string; host: string }
    /** 前面的區塊已經給了同一個值。/ An earlier block already gives this value. */
    | { kind: "repeat"; n: number; key: string; host: string; by: number }
    /** 好幾個區塊共用的行搬進一個區塊。/ Lines several blocks share moved into one block. */
    | { kind: "shared"; hosts: string[]; keys: string[]; removed: number; telepy: boolean }
    /** 用萬用字元代替名稱清單。/ A wildcard instead of the list of names. */
    | { kind: "wildcard"; pattern: string; hosts: string[] };

export type Note =
    /** 這行永遠不會生效（同一個選項前面已經有值）。/ This line never takes effect. */
    | { kind: "shadowed"; n: number; key: string; host: string; by: number; value: string; winner: string }
    /** OpenSSH 不認得的選項（ssh 會拒絕讀這份設定，除非 IgnoreUnknown）。/ An option OpenSSH doesn't know. */
    | { kind: "unknown"; n: number; key: string }
    /** ssh 會略過的舊選項。/ An old option ssh skips. */
    | { kind: "ignored"; n: number; key: string }
    /** 有 Match / Include：它們前後的行不會互相搬動。/ Match / Include present: nothing moves across them. */
    | { kind: "wall"; n: number; key: string }
    /** 讀不懂的行（引號沒關…）。/ A line that can't be read (an unclosed quote …). */
    | { kind: "invalid"; n: number };

export interface TidyOptions {
    /** 名稱有共同的開頭 / 結尾時改用萬用字元（會套用到其他符合的名稱）。/ Use a wildcard for names sharing a start / end. */
    wildcards?: boolean;
}

export interface OutputLine {
    text: string;
    /** 原檔的行號；0 = 簡化時新寫的。/ The source line; 0 = written by tidy. */
    n: number;
}

export interface TidyResult {
    text: string;
    lines: OutputLine[];
    /** 原檔裡拿掉或搬走的行號。/ Source lines removed or moved. */
    removed: Set<number>;
    before: { lines: number; settings: number; blocks: number };
    after: { lines: number; settings: number; blocks: number };
    changes: Change[];
    notes: Note[];
    /** 逐一驗證過的名稱。/ The names checked one by one. */
    checked: string[];
    /** 驗證失敗（不該發生）：改回原文。/ Verification failed (should never happen): the original is kept. */
    failed: string[];
    /** 萬用字元會多套用到的名稱樣式。/ Patterns a wildcard extends to. */
    widened: { pattern: string; hosts: string[] }[];
}

// ── Tidy ─────────────────────────────────────────────────────────────────────

interface Feature {
    id: string;
    slot: string;
    lines: CfgLine[];
    /** HostName 的 `%h` 樣板。/ The HostName `%h` template. */
    template?: string;
}

/** 分組用的值（`%h` 不展開，跟寫死的名稱分得開）。/ The value grouped on (`%h` kept apart from a spelled-out name). */
const idText = (l: CfgLine) => valueText(l, "\u0003");
const ownerKey = (o: Owner) => (o.kind === "telepy" ? `telepy:${o.server}` : o.kind);
const editable = (b: CfgBlock) => !b.barrier && !b.made && !b.dropped && b.literal && (b.owner.kind === "user" || b.owner.kind === "telepy");
const options = (b: CfgBlock) => b.body.filter((l) => l.kind === "option");

/** `HostName <前綴><名稱><後綴>` → `<前綴>%h<後綴>`（區塊只有一個名稱、值裡沒有 `%`）。/ HostName as a `%h` template. */
function hostnameTemplate(b: CfgBlock, l: CfgLine): string | null {
    if (b.patterns.length !== 1 || l.args.length !== 1) return null;
    const [name] = b.patterns;
    const value = l.args[0];
    if (value.includes("%") || name.includes("%")) return null;
    const at = value.indexOf(name);
    return at < 0 ? null : value.slice(0, at) + "%h" + value.slice(at + name.length);
}

function blockFeatures(b: CfgBlock, keep: Set<CfgLine>, templates: Map<string, number>): Feature[] {
    const out: Feature[] = [];
    const seen = new Set<string>();
    for (const l of options(b)) {
        if (keep.has(l) || seen.has(l.slot)) continue;
        // 裝置自己的身分留在裝置區塊：重跑指令、同名偵測看 ProxyCommand，HostKeyAlias 是這台的主機金鑰。
        // A device keeps what identifies it: the install command's same-name check reads ProxyCommand, and
        // HostKeyAlias names this device's host key.
        if (b.owner.kind === "telepy" && TELEPY_PINNED.has(l.slot)) continue;
        if (ACCUMULATE.has(l.slot)) {
            seen.add(l.slot);
            const all = options(b).filter((x) => x.slot === l.slot);
            if (all.some((x) => keep.has(x))) continue;
            out.push({ id: `${l.slot}\u0001${all.map(idText).join("\u0002")}`, slot: l.slot, lines: all });
            continue;
        }
        seen.add(l.slot);
        const tpl = l.slot === "hostname" ? hostnameTemplate(b, l) : null;
        if (tpl !== null && (templates.get(tpl) ?? 0) >= 2) out.push({ id: `hostname\u0001%T${tpl}`, slot: l.slot, lines: [l], template: tpl });
        else out.push({ id: `${l.slot}\u0001${idText(l)}`, slot: l.slot, lines: [l] });
    }
    return out;
}

/** 一行（或一串累加的行）與有它的區塊。/ One feature and the blocks that have it. */
interface Entry {
    feature: Feature;
    /** 區塊 → 它自己的那幾行。/ Block → its own lines. */
    holders: Map<CfgBlock, Feature>;
}

interface Candidate {
    /** 共用區塊的 Host 行列的區塊（有這些行的，加上同一個選項寫了別的值、自己的值先讀到的）。
     * The blocks the shared block names (those with the lines, plus those that set the option to something else
     * themselves — read first, so they keep it). */
    members: CfgBlock[];
    entries: Entry[];
    /** 每個成員要搬走的行。/ The lines moved out of each member. */
    moves: Map<CfgBlock, Set<CfgLine>>;
    saving: number;
    key: string;
}

/** Host 名稱分成每行不超過上限的幾組。/ Host names split so no Host line is too long. */
function chunkHosts(hosts: string[]): string[][] {
    const out: string[][] = [[]];
    let len = 4;
    for (const h of hosts) {
        if (out[out.length - 1].length > 0 && len + h.length + 1 > HOST_LINE_MAX) {
            out.push([]);
            len = 4;
        }
        out[out.length - 1].push(h);
        len += h.length + 1;
    }
    return out;
}

function hostsOf(members: CfgBlock[]): string[] {
    return [...new Set(members.flatMap((m) => m.patterns))];
}

/** 成員 × 共用的行 → 候選（含省下幾行）。/ Members × shared features → a candidate with its saving. */
function candidate(members: CfgBlock[], entries: Entry[]): Candidate | null {
    const inGroup = new Set(members);
    const used = entries.filter((e) => [...e.holders.keys()].filter((b) => inGroup.has(b)).length >= 1);
    if (members.length < 2 || used.length === 0) return null;
    const perMember = used.reduce((n, e) => n + e.feature.lines.length, 0);
    const telepy = members[0].owner.kind === "telepy";
    const moves = new Map<CfgBlock, Set<CfgLine>>();
    let removed = 0;
    let emptied = 0;
    for (const m of members) {
        const moved = new Set(used.flatMap((e) => e.holders.get(m)?.lines ?? []));
        moves.set(m, moved);
        removed += moved.size;
        if (!telepy && m.body.every((l) => moved.has(l) || l.kind === "blank")) emptied++;
    }
    const added = chunkHosts(hostsOf(members)).length * (1 + perMember + (telepy ? 2 : 0));
    const key = `${members.map((m) => m.header!.n).join(",")}|${used.map((e) => e.feature.id).sort().join("|")}`;
    return { members, entries: used, moves, saving: removed + emptied - added, key };
}

/**
 * 這段裡值得試的分組：同一個選項同一個值的區塊（第一種），以及「預設值」——共用區塊放在成員後面，自己寫了別的值的成員
 * 先讀到自己的、不受影響，所以它們也能列進去（第二種；累加的選項不行）。
 * The groups worth trying: the blocks with the same option and value, and "defaults" — the shared block goes after
 * its members, so members that set the option to something else read their own value first and can be listed too
 * (not for options that add up).
 */
function candidates(seg: CfgBlock[], keep: Set<CfgLine>, tried: Set<string>): { list: Candidate[]; entries: Map<string, Entry> } {
    const out: Candidate[] = [];
    const all = new Map<string, Entry>();
    const groups = new Map<string, CfgBlock[]>();
    for (const b of seg) if (editable(b)) groups.set(ownerKey(b.owner), [...(groups.get(ownerKey(b.owner)) ?? []), b]);
    for (const blocks of groups.values()) {
        if (blocks.length < 2) continue;
        const templates = new Map<string, number>();
        for (const b of blocks) {
            for (const l of options(b)) {
                const tpl = l.slot === "hostname" && !keep.has(l) ? hostnameTemplate(b, l) : null;
                if (tpl !== null) templates.set(tpl, (templates.get(tpl) ?? 0) + 1);
            }
        }
        const entries = new Map<string, Entry>();
        const sets = new Map<CfgBlock, Set<string>>();
        for (const b of blocks) {
            sets.set(b, new Set(options(b).map((l) => l.slot)));
            for (const f of blockFeatures(b, keep, templates)) {
                const e = entries.get(f.id) ?? { feature: f, holders: new Map() };
                e.holders.set(b, f);
                entries.set(f.id, e);
            }
        }
        // 一個共用區塊裡每個選項只放一個值：有的區塊最多的那個。/ One value per option in a shared block: the most common.
        const bySet = new Map<string, { members: CfgBlock[]; entries: Map<string, Entry> }>();
        const add = (members: CfgBlock[], e: Entry) => {
            const key = members.map((m) => m.header!.n).join(",");
            const g = bySet.get(key) ?? { members, entries: new Map() };
            const had = g.entries.get(e.feature.slot);
            if (!had || had.holders.size < e.holders.size) g.entries.set(e.feature.slot, e);
            bySet.set(key, g);
        };
        for (const e of entries.values()) {
            all.set(e.feature.id, e);
            if (e.holders.size < 2) continue;
            add(blocks.filter((b) => e.holders.has(b)), e);
            if (ACCUMULATE.has(e.feature.slot)) continue;
            const slot = e.feature.slot;
            const wider = blocks.filter((b) => e.holders.has(b) || (sets.get(b)!.has(slot) && !(slot === "proxycommand" && sets.get(b)!.has("proxyjump"))));
            if (wider.length > e.holders.size) add(wider, e);
        }
        for (const g of bySet.values()) {
            const c = candidate(g.members, [...g.entries.values()]);
            if (c && !tried.has(c.key) && c.saving >= MIN_SAVING) out.push(c);
        }
    }
    // 省一樣多時選名稱少的：只列真的用得到的名稱比較好讀。/ On a tie, fewer names: listing only those that use it reads better.
    return { list: out.sort((a, b) => b.saving - a.saving || a.members.length - b.members.length), entries: all };
}

function madeLine(indent: string, key: string, value: string, slot: string, args: string[], rest: string): CfgLine {
    return { n: 0, raw: `${indent}${key} ${value}`, kind: "option", key, slot, args, rest };
}

function comment(raw: string): CfgLine {
    return { n: 0, raw, kind: "comment", key: "", slot: "", args: [], rest: "" };
}

const BLANK: CfgLine = { n: 0, raw: "", kind: "blank", key: "", slot: "", args: [], rest: "" };

/** 一個共用區塊（名稱太多時拆成好幾個）。/ The shared block(s) for one group. */
function sharedBlocks(cfg: ParsedConfig, members: CfgBlock[], entries: Entry[]): CfgBlock[] {
    const features = entries.map((e) => e.feature);
    const owner = members[0].owner;
    const body: CfgLine[] = features.flatMap((f) =>
        f.template !== undefined
            ? [madeLine(cfg.indent, f.lines[0].key, f.template, "hostname", [f.template], f.template)]
            : f.lines.map((l) => ({ ...l, n: 0, raw: cfg.indent + l.raw.replace(/^[ \t]+/, "") })),
    );
    return chunkHosts(hostsOf(members)).map((hosts) => {
        const header = madeLine("", members[0].header!.key, hosts.join(" "), "host", hosts, hosts.join(" "));
        const b = newBlock("host", header, []);
        b.made = true;
        b.owner = owner;
        b.body = body;
        if (owner.kind === "telepy") {
            b.marker = `shared ${owner.server}`;
            b.lead = [comment(`# >>> telepy ${b.marker} >>>`)];
            b.tail = [comment(`# <<< telepy ${b.marker} <<<`)];
        } else if (cfg.spaced) b.lead = [BLANK];
        return b;
    });
}

/** 把一組搬出去：成員拿掉那些行，共用區塊放在 `at`。/ Move one group out; the shared block goes at `at`. */
function applyGroup(cfg: ParsedConfig, seg: CfgBlock[], c: Candidate, at: "after" | "before"): CfgBlock[] {
    const replaced = new Map<CfgBlock, CfgBlock>();
    for (const m of c.members) {
        const moved = c.moves.get(m)!;
        const body = m.body.filter((l) => !moved.has(l));
        replaced.set(m, { ...m, body, dropped: m.owner.kind === "user" && body.every((l) => l.kind === "blank") });
    }
    const made = sharedBlocks(cfg, c.members, c.entries);
    const idx = seg.map((b, i) => (c.moves.has(b) ? i : -1)).filter((i) => i >= 0);
    const pos = at === "after" ? idx[idx.length - 1] + 1 : idx[0];
    const out = seg.map((b) => replaced.get(b) ?? b);
    out.splice(pos, 0, ...made);
    return out;
}

/** 名稱逐一比對：回傳結果不一樣的名稱。/ The names whose result differs. */
function differing(before: CfgBlock[], after: CfgBlock[], hosts: Iterable<string>): string[] {
    const out: string[] = [];
    for (const h of hosts) if (!sameEffect(resolve(before, h), resolve(after, h))) out.push(h);
    return out;
}

/** 這段裡可以拿掉的重複行（同一區塊裡重複、或前面已經給了同樣的值）與永遠不生效的行。/ Repeats and lines that never apply. */
function deadLines(all: CfgBlock[], changes: Change[], notes: Note[], keep: Set<CfgLine>): Map<CfgBlock, Set<CfgLine>> {
    const drop = new Map<CfgBlock, Set<CfgLine>>();
    all.forEach((b, i) => {
        if (b.kind === "match" || b.barrier) return;
        const opts = options(b);
        opts.forEach((l, j) => {
            if (ACCUMULATE.has(l.slot) || l.slot === "include") return;
            const sets = (x: CfgLine) => (l.slot === "proxyjump" ? x.slot === "proxycommand" || x.slot === "proxyjump" : x.slot === l.slot);
            const sameBlock = opts.slice(0, j).find(sets);
            const host = b.patterns.join(" ");
            if (sameBlock) {
                if (idText(sameBlock) !== idText(l)) {
                    notes.push({ kind: "shadowed", n: l.n, key: l.key, host, by: sameBlock.n, value: l.rest.trim(), winner: sameBlock.rest.trim() });
                    keep.add(l);
                } else if (b.owner.kind === "user") {
                    changes.push({ kind: "duplicate", n: l.n, key: l.key, host });
                    drop.set(b, (drop.get(b) ?? new Set()).add(l));
                } else keep.add(l);
                return;
            }
            if (!b.literal) return;
            // 每個名稱都已經被前面的區塊（全域 / Host，不算 Match）設定了 = 這行讀不到。/ Every name already set by an earlier block.
            let by: CfgLine | null = null;
            let same = true;
            for (const h of b.patterns) {
                let setter: CfgLine | null = null;
                for (const e of all.slice(0, i)) {
                    if (e.kind === "match" || !applies(e, h)) continue;
                    setter = options(e).find(sets) ?? null;
                    if (setter) break;
                }
                if (!setter) return;
                by ??= setter;
                if (valueText(setter, h) !== valueText(l, h)) same = false;
            }
            if (!by) return;
            if (!same) {
                notes.push({ kind: "shadowed", n: l.n, key: l.key, host, by: by.n, value: l.rest.trim(), winner: by.rest.trim() });
                keep.add(l);
            } else if (b.owner.kind === "user") {
                changes.push({ kind: "repeat", n: l.n, key: l.key, host, by: by.n });
                drop.set(b, (drop.get(b) ?? new Set()).add(l));
            }
        });
    });
    return drop;
}

function commonPrefix(xs: string[]): string {
    let p = xs[0] ?? "";
    for (const x of xs) while (!x.startsWith(p)) p = p.slice(0, -1);
    return p;
}

function commonSuffix(xs: string[]): string {
    let s = xs[0] ?? "";
    for (const x of xs) while (!x.endsWith(s)) s = s.slice(1);
    return s;
}

/** 兩個萬用字元樣式有沒有共同符合的名稱（只有 `*`、`?`）。/ Whether two glob patterns can match the same name. */
export function globsIntersect(a: string, b: string): boolean {
    const seen = new Set<string>();
    const close = (i: number, j: number, acc: [number, number][]) => {
        const k = `${i},${j}`;
        if (seen.has(k)) return;
        seen.add(k);
        acc.push([i, j]);
        if (a[i] === "*") close(i + 1, j, acc);
        if (b[j] === "*") close(i, j + 1, acc);
    };
    let states: [number, number][] = [];
    close(0, 0, states);
    for (let guard = 0; guard <= a.length + b.length + 1 && states.length > 0; guard++) {
        if (states.some(([i, j]) => i === a.length && j === b.length)) return true;
        const next: [number, number][] = [];
        for (const [i, j] of states) {
            if (i >= a.length || j >= b.length) continue;
            const ca = a[i];
            const cb = b[j];
            if (ca !== "*" && ca !== "?" && cb !== "*" && cb !== "?" && ca !== cb) continue;
            close(ca === "*" ? i : i + 1, cb === "*" ? j : j + 1, next);
        }
        states = next;
    }
    return states.some(([i, j]) => i === a.length && j === b.length);
}

/** 萬用字元：共同開頭（到分隔符號為止）或 `.` / `-` 開頭的共同結尾。/ A wildcard from a common start or a common end. */
function wildcardFor(hosts: string[], all: CfgBlock[], group: CfgBlock): string | null {
    if (hosts.length < 2) return null;
    const pre = commonPrefix(hosts);
    const cut = Math.max(pre.lastIndexOf("-"), pre.lastIndexOf("."), pre.lastIndexOf("_"));
    const prefix = cut >= 1 ? pre.slice(0, cut + 1) : pre.length >= 3 ? pre : "";
    const suf = commonSuffix(hosts);
    const scut = Math.min(...["-", ".", "_"].map((c) => (suf.indexOf(c) < 0 ? Infinity : suf.indexOf(c))));
    const suffix = Number.isFinite(scut) && suf.length - scut >= 3 ? suf.slice(scut) : "";
    const inGroup = new Set(hosts);
    const others = all.filter((b) => b !== group && !b.dropped && b.kind === "host");
    for (const pattern of [suffix.startsWith(".") ? `*${suffix}` : "", prefix ? `${prefix}*` : "", suffix ? `*${suffix}` : ""]) {
        if (!pattern || pattern.length >= hosts.join(" ").length) continue;
        const clash = others.some((b) =>
            b.patterns.some((p) => {
                const q = p.startsWith("!") ? p.slice(1) : p;
                if (!isWild(q)) return !inGroup.has(q) && globMatch(q, pattern);
                return q !== "*" && globsIntersect(q, pattern);
            }),
        );
        if (!clash) return pattern;
    }
    return null;
}

function stats(cfg: Pick<ParsedConfig, "blocks" | "trailer">, text: string) {
    const live = cfg.blocks.filter((b) => !b.dropped);
    return {
        lines: text === "" ? 0 : text.replace(/\r?\n$/, "").split(/\r?\n/).length,
        settings: live.reduce((n, b) => n + (b.header ? 1 : 0) + b.body.filter((l) => l.kind === "option").length, 0),
        blocks: live.filter((b) => b.kind !== "global").length,
    };
}

/** 區塊 → 文字（拿掉的區塊只留前面的註解；不疊兩個空行）。/ Blocks → text (dropped blocks keep their leading comments). */
export function renderConfig(cfg: ParsedConfig): { text: string; lines: OutputLine[] } {
    const lines: OutputLine[] = [];
    // 拿掉的區塊或新寫的空行不疊出兩個空行。/ A dropped block or a new blank line never leaves two blank lines in a row.
    let afterDrop = false;
    const push = (l: CfgLine) => {
        const prevBlank = lines.length === 0 || lines[lines.length - 1].text.trim() === "";
        if (l.kind === "blank" && prevBlank && (l.n === 0 || afterDrop)) return;
        if (l.kind !== "blank") afterDrop = false;
        lines.push({ text: l.raw, n: l.n });
    };
    for (const b of cfg.blocks) {
        if (b.dropped) {
            afterDrop = true;
            b.lead.forEach(push);
            continue;
        }
        b.lead.forEach(push);
        if (b.header) push(b.header);
        b.body.forEach(push);
        b.tail.forEach(push);
    }
    cfg.trailer.forEach(push);
    const text = lines.map((l) => l.text).join(cfg.newline) + (lines.length > 0 && cfg.endsWithNewline ? cfg.newline : "");
    return { text, lines };
}

/** 檔案裡寫明的每個名稱（Host 行上的非萬用字元樣式）。/ Every name the file spells out (non-wildcard Host patterns). */
export function hostNames(cfg: ParsedConfig): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const b of cfg.blocks) {
        if (b.kind !== "host" || b.dropped) continue;
        for (const p of b.patterns) {
            if (!isWild(p) && !seen.has(p)) {
                seen.add(p);
                out.push(p);
            }
        }
    }
    return out;
}

/** 驗證用的名稱：每個寫明的名稱，加上每個萬用字元樣式的例子和一個誰都不是的名字。/ Names to verify with. */
function probes(blocks: CfgBlock[]): string[] {
    const out = new Set<string>(["telepy-tidy-nobody.invalid"]);
    for (const b of blocks) {
        if (b.kind !== "host") continue;
        for (const p of b.patterns) {
            const q = p.startsWith("!") ? p.slice(1) : p;
            out.add(isWild(q) ? q.replace(/\*/g, "zz").replace(/\?/g, "z") : q);
        }
    }
    return [...out];
}

/**
 * 簡化一份 ssh config。回傳新的文字、做了什麼、要留意的行，以及逐一驗證過的名稱；驗證不過（不該發生）就原文不動。
 * Simplify an ssh config: the new text, what changed, lines worth a look and the names checked one by one; if
 * the check fails (it should never) the original stays.
 */
export function tidyConfig(text: string, opts: TidyOptions = {}): TidyResult {
    const cfg = parseConfig(text);
    const changes: Change[] = [];
    const notes: Note[] = [];
    for (const b of cfg.blocks) {
        for (const l of [...(b.header ? [b.header] : []), ...b.body]) {
            if (l.kind === "invalid") notes.push({ kind: "invalid", n: l.n });
            else if (l.kind !== "option") continue;
            else if (l.slot === "match" || l.slot === "include") notes.push({ kind: "wall", n: l.n, key: l.key });
            else if (IGNORED.has(l.key.toLowerCase())) notes.push({ kind: "ignored", n: l.n, key: l.key });
            else if (!KEYWORDS.has(l.key.toLowerCase())) notes.push({ kind: "unknown", n: l.n, key: l.key });
        }
    }
    const original = cfg.blocks;
    const keep = new Set<CfgLine>();
    const drop = deadLines(original, changes, notes, keep);
    let blocks = original.map((b) => {
        const d = drop.get(b);
        if (!d) return b;
        const body = b.body.filter((l) => !d.has(l));
        return { ...b, body, dropped: b.kind === "host" && b.owner.kind === "user" && body.every((l) => l.kind === "blank") };
    });

    const widened: TidyResult["widened"] = [];
    const out: CfgBlock[] = [];
    let start = 0;
    for (const seg of segments(blocks)) {
        // 牆照原樣放回去。/ Walls go back as they were.
        while (blocks[start] !== seg[0]) out.push(blocks[start++]);
        start += seg.length;
        const tried = new Set<string>();
        let cur = seg;
        for (let round = 0; round < 500; round++) {
            const { list } = candidates(cur, keep, tried);
            let c: Candidate | null = list[0] ?? null;
            if (!c) break;
            let next: CfgBlock[] | null = null;
            // 放在最後一個成員後面或第一個前面；都不行就去掉讀起來會變的成員再試。
            // After the last member or before the first; if neither works, drop the members that would change and retry.
            while (c && !next) {
                tried.add(c.key);
                const hosts = hostsOf(c.members);
                let bad: string[] = [];
                for (const at of ["after", "before"] as const) {
                    const tryIt = applyGroup(cfg, cur, c, at);
                    const diff = differing(seg, tryIt, hosts);
                    if (diff.length === 0) {
                        next = tryIt;
                        break;
                    }
                    if (at === "after") bad = diff;
                }
                if (next) break;
                const rest: CfgBlock[] = c.members.filter((m) => !m.patterns.some((h) => bad.includes(h)));
                const smaller: Candidate | null = rest.length < c.members.length ? candidate(rest, c.entries) : null;
                c = smaller && smaller.saving >= MIN_SAVING && !tried.has(smaller.key) ? smaller : null;
            }
            if (!next || !c) continue;
            const hosts = hostsOf(c.members);
            const removed = [...c.moves.values()].reduce((n, m) => n + m.size, 0);
            changes.push({ kind: "shared", hosts, keys: c.entries.map((e) => e.feature.lines[0].key), removed, telepy: c.members[0].owner.kind === "telepy" });
            cur = next;
        }
        if (opts.wildcards) {
            for (let i = 0; i < cur.length; i++) {
                const g = cur[i];
                if (g.owner.kind !== "user" || !g.literal || g.dropped || g.patterns.length < 2) continue;
                // 名稱還列在別的區塊（自己的設定）才換：不然 `ssh <Tab>` 補不出來、讀檔的人也找不到它。
                // Only when every name is still listed by another block (its own settings): otherwise tab completion
                // and anyone reading the file lose it.
                const listedElsewhere = g.patterns.every((h) => cur.some((b) => b !== g && !b.dropped && b.kind === "host" && b.patterns.includes(h)));
                const pattern = listedElsewhere ? wildcardFor(g.patterns, [...out, ...cur, ...blocks.slice(start)], g) : null;
                if (!pattern) continue;
                const header = madeLine("", g.header!.key, pattern, "host", [pattern], pattern);
                const next = [...cur];
                next[i] = { ...g, header, patterns: [pattern], literal: false };
                if (differing(seg, next, g.patterns).length > 0) continue;
                changes.push({ kind: "wildcard", pattern, hosts: g.patterns });
                widened.push({ pattern, hosts: g.patterns });
                cur = next;
            }
        }
        out.push(...cur);
    }
    while (start < blocks.length) out.push(blocks[start++]);
    blocks = out;

    // 最後整份再驗一次（萬用字元多套用到的名稱除外）：Match 全部略過、全部成立各一次——搬動不跨牆，拿掉的重複行是
    // 被一定會套用的區塊蓋掉的，所以兩種都該一樣。
    // One last check over the whole file (except what a wildcard widened), with every Match skipped and with every
    // Match applied: nothing moves across a wall and a removed repeat is covered by a block that always applies, so
    // both must agree.
    const widen = (h: string) => widened.some((w) => globMatch(h, w.pattern) && !w.hosts.includes(h));
    const names = probes(original).filter((h) => !widen(h));
    const failed = names.filter((h) => [false, true].some((m) => !sameEffect(resolve(original, h, m), resolve(blocks, h, m))));
    if (segments(original).length !== segments(blocks).length) failed.push("*");

    const result: ParsedConfig = failed.length ? cfg : { ...cfg, blocks };
    const rendered = renderConfig(result);
    const kept = new Set(rendered.lines.map((l) => l.n));
    const removed = new Set<number>();
    for (let n = 1; n <= text.split(/\r?\n/).length; n++) if (!kept.has(n)) removed.add(n);
    if (cfg.endsWithNewline) removed.delete(text.split(/\r?\n/).length);
    return {
        text: rendered.text,
        lines: rendered.lines,
        removed: failed.length ? new Set() : removed,
        before: stats(cfg, text),
        after: stats(result, rendered.text),
        changes: failed.length ? [] : changes,
        notes: notes.sort((a, b) => a.n - b.n),
        checked: names.filter((h) => h !== "telepy-tidy-nobody.invalid"),
        failed,
        widened: failed.length ? [] : widened,
    };
}

// ── Explaining one name ──────────────────────────────────────────────────────

export interface Explained {
    /** 小寫的選項名稱。/ The option, lower case. */
    slot: string;
    key: string;
    value: string;
    /** 給這個值的那一行與它的 Host 行。/ The line that gives it and its block's header. */
    n: number;
    header: string;
}

/**
 * 一個名稱實際拿到的設定，每個值是哪一行給的（Match 區塊不評估，另外標出來）。
 * What one name actually gets, and which line gives each value (Match blocks are not evaluated; reported apart).
 */
export function explainHost(text: string, host: string): { rows: Explained[]; matches: number[] } {
    const cfg = parseConfig(text);
    const eff = resolve(cfg.blocks, host);
    const row = (slot: string, s: Source): Explained => ({
        slot,
        key: s.line.key,
        value: s.line.rest.trim(),
        n: s.line.n,
        header: s.block.header ? s.block.header.raw.trim() : "",
    });
    const rows: Explained[] = [];
    for (const [slot, s] of eff.first) rows.push(row(slot, s));
    for (const [slot, list] of eff.lists) for (const s of list) rows.push(row(slot, s));
    return { rows: rows.sort((a, b) => a.n - b.n), matches: cfg.blocks.filter((b) => b.kind === "match" && b.header).map((b) => b.header!.n) };
}

export interface TraceLine {
    n: number;
    key: string;
    value: string;
    /** used = 這行給了值；stacked = 累加進去；skipped = 前面已經有值，ssh 略過。/ Gives the value / adds up / skipped. */
    state: "used" | "stacked" | "skipped";
    slot: string;
}

export interface TraceBlock {
    /** Host 行的行號（全域設定 = 0）。/ The header's line (0 = the global section). */
    n: number;
    header: string;
    /** 簡化時新加的共用區塊。/ A shared block tidy added. */
    made: boolean;
    telepy: boolean;
    lines: TraceLine[];
}

/**
 * ssh 讀一個名稱時走過的區塊：只列套用到它的（照檔案順序），每一行標出用了、累加或略過。Match 區塊不評估，另外列行號。
 * The blocks ssh walks for one name: only those that apply (in file order), each line marked used, stacked or
 * skipped. Match blocks are not evaluated; their lines are listed apart.
 */
export function traceHost(text: string, host: string): { blocks: TraceBlock[]; matches: number[] } {
    const cfg = parseConfig(text);
    const set = new Set<string>();
    const blocks: TraceBlock[] = [];
    for (const b of cfg.blocks) {
        if (!applies(b, host)) continue;
        const lines: TraceLine[] = [];
        for (const l of b.body) {
            if (l.kind !== "option" || l.slot === "include") continue;
            let state: TraceLine["state"];
            if (ACCUMULATE.has(l.slot)) state = "stacked";
            else if (l.slot === "proxyjump") state = set.has("proxycommand") || set.has("proxyjump") ? "skipped" : "used";
            else state = set.has(l.slot) ? "skipped" : "used";
            if (state === "used") set.add(l.slot);
            lines.push({ n: l.n, key: l.key, value: l.rest.trim(), state, slot: l.slot });
        }
        if (b.kind === "global" && lines.length === 0) continue;
        blocks.push({ n: b.header?.n ?? 0, header: b.header ? b.header.raw.trim() : "", made: b.marker?.startsWith("shared ") ?? false, telepy: b.owner.kind === "telepy" || b.owner.kind === "shared", lines });
    }
    return { blocks, matches: cfg.blocks.filter((b) => b.kind === "match" && b.header).map((b) => b.header!.n) };
}

/** 兩份設定給一個名稱的結果一不一樣（Match 全部略過、全部成立都比）。/ Whether two configs give a name the same result. */
export function sameResult(a: string, b: string, host: string): boolean {
    const x = parseConfig(a).blocks;
    const y = parseConfig(b).blocks;
    return [false, true].every((m) => sameEffect(resolve(x, host, m), resolve(y, host, m)));
}

/** 一份設定裡寫明的名稱。/ The names a config spells out. */
export function namesIn(text: string): string[] {
    return hostNames(parseConfig(text));
}

/** 貼上頁「試試看」的例子（設定本身不翻譯）。/ The paste page's example (config text is not translated). */
export const TIDY_EXAMPLE = `# Work servers
Host bastion
    HostName bastion.example.com
    User deploy
    IdentityFile ~/.ssh/work_ed25519

Host web-1
    HostName web-1.internal.example.com
    User deploy
    IdentityFile ~/.ssh/work_ed25519
    ProxyJump bastion
    ServerAliveInterval 30

Host web-2
    HostName web-2.internal.example.com
    User deploy
    IdentityFile ~/.ssh/work_ed25519
    ProxyJump bastion
    ServerAliveInterval 30
    User deploy

Host db
    HostName 10.20.0.5
    User postgres
    IdentityFile ~/.ssh/work_ed25519
    ProxyJump bastion
    ServerAliveInterval 30

Host *
    AddKeysToAgent yes
    ServerAliveInterval 60

Host lab-pi
    HostName 192.168.1.40
    ServerAliveInterval 15
`;

/** 變動裡第一個名稱（資訊視窗先顯示它）。/ The first name a change touches (the info dialog starts there). */
export function firstChangedName(r: TidyResult): string | undefined {
    for (const c of r.changes) {
        if (c.kind === "shared" || c.kind === "wildcard") return c.hosts[0];
        if (c.host && !/[*?!]/.test(c.host.split(" ")[0])) return c.host.split(" ")[0];
    }
    return undefined;
}
