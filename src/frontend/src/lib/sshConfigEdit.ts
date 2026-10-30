/**
 * ~/.ssh/config 編輯（純函式，建在 lib/sshConfigTidy.ts 的解析與解讀上）：主機總覽表、改一台主機的設定、新增 / 刪除 /
 * 改名主機、「值得看一下」的一鍵修正，以及任何改動前後「哪個名稱的哪個設定變了」。
 * 原則：改一台主機只動那台自己的區塊（`Host <它>`、只有它一個名字），而且放在 ssh 會先讀到的地方——它自己的區塊在提供
 * 目前值的區塊之後時，在那個區塊前面開一個新的 `Host <它>`；結果一律再解讀一次確認真的生效。全域設定（第一個 Host
 * 之前）對每個名稱最先生效，蓋不過，回 `global`。
 *
 * Editing ~/.ssh/config (pure, built on lib/sshConfigTidy.ts's parser and resolver): the host overview, changing
 * one host's settings, adding / removing / renaming hosts, one-click fixes for the "worth a look" notes, and for any
 * change which setting of which name it changes.
 * Rule: changing a host only touches its own block (`Host <it>`, no other name), placed where ssh reads it first —
 * when its own block comes after the block giving the current value, a new `Host <it>` goes right before that block;
 * every result is resolved again to confirm it took effect. The global section (before the first Host) applies to
 * every name first and can't be overridden: `global`.
 */
import {
    applies,
    hostNames,
    isWild,
    newBlock,
    options,
    parseConfig,
    parseLine,
    plainName,
    renderConfig,
    resolve,
    slotOf,
    stacks,
    type CfgBlock,
    type CfgLine,
    type Note,
    type ParsedConfig,
    type Source,
} from "./sshConfigTidy.ts";

/** 「其他名稱」用的探針（不會是真的主機名稱）。/ The probe for "any other name" (never a real host name). */
export const OTHER = "telepy-other-name.invalid";

/** 新寫的行用的拼法。/ How new lines spell common keywords. */
const SPELLING: Record<string, string> = {
    hostname: "HostName",
    user: "User",
    port: "Port",
    identityfile: "IdentityFile",
    proxyjump: "ProxyJump",
    proxycommand: "ProxyCommand",
    forwardagent: "ForwardAgent",
    identitiesonly: "IdentitiesOnly",
    localforward: "LocalForward",
    remoteforward: "RemoteForward",
    dynamicforward: "DynamicForward",
    serveraliveinterval: "ServerAliveInterval",
    stricthostkeychecking: "StrictHostKeyChecking",
    userknownhostsfile: "UserKnownHostsFile",
    ignoreunknown: "IgnoreUnknown",
};
export const spell = (key: string) => SPELLING[key.toLowerCase()] ?? key;

export type EditError =
    /** 這個值在全域設定（第一個 Host 之前），每個名稱都先讀到它。/ Set in the global section, read first by every name. */
    | { code: "global"; line: number; key: string }
    /** 名稱不能用（空白、萬用字元、引號…）。/ Not a usable name. */
    | { code: "bad_name" }
    /** 名稱已經在檔案裡。/ The name is already in the file. */
    | { code: "exists" }
    /** Telepy 管的主機（改名要改通道或前綴）。/ A host Telepy manages. */
    | { code: "telepy" }
    /** 值不能用（換行、空的）。/ Not a usable value. */
    | { code: "bad_value"; key: string }
    /** 找不到那一行 / 那台主機。/ No such line / host. */
    | { code: "not_found" }
    /** 寫進去了但 ssh 讀不到（不該發生）。/ Written but ssh wouldn't read it (should never happen). */
    | { code: "no_effect"; key: string };

export type EditResult = { text: string; error?: undefined } | { text?: undefined; error: EditError };

// ── Where things are ─────────────────────────────────────────────────────────

/** 只寫這一個名稱的區塊（可以放心改，不影響別台）。/ Blocks naming only this host (safe to change for it alone). */
function ownIndexes(cfg: ParsedConfig, host: string): number[] {
    return cfg.blocks.flatMap((b, i) => (b.kind === "host" && !b.barrier && !b.dropped && b.patterns.length === 1 && b.patterns[0] === host ? [i] : []));
}

const setsSlot = (slot: string) => (l: CfgLine) => l.kind === "option" && (slot === "proxyjump" ? l.slot === "proxycommand" || l.slot === "proxyjump" : l.slot === slot);

/** 第一個套用到這個名稱、而且設定了這個選項的區塊（Match 不算）。/ The first block that applies to the name and sets the option. */
function firstSetter(cfg: ParsedConfig, host: string, slot: string): { i: number; line: CfgLine } | null {
    for (let i = 0; i < cfg.blocks.length; i++) {
        const b = cfg.blocks[i];
        if (b.kind === "match" || !applies(b, host)) continue;
        const line = options(b).find(setsSlot(slot));
        if (line) return { i, line };
    }
    return null;
}

/** 新區塊放哪：第一個可能也套用到它的萬用字元區塊或 Match 之前，否則最後。/ Where a new host block goes. */
function newHostIndex(cfg: ParsedConfig, host: string): number {
    for (let i = 1; i < cfg.blocks.length; i++) {
        const b = cfg.blocks[i];
        if (b.kind === "match") return i;
        if (b.kind === "host" && !b.literal && applies(b, host)) return i;
    }
    return cfg.blocks.length;
}

/**
 * 只有一個值的選項（路徑、名稱）：有空白就加引號，ssh 才讀成一個值；其他照打的寫（`LocalForward 8080 localhost:80` 是兩個
 * 值，加引號反而讀壞）。/ Single-value options (paths, names) are quoted when they hold spaces, so ssh reads one value;
 * everything else is written as typed (`LocalForward 8080 localhost:80` is two values — quoting would break it).
 */
const SINGLE = new Set(["hostname", "user", "port", "identityfile", "certificatefile", "identityagent", "controlpath", "hostkeyalias", "pkcs11provider", "securitykeyprovider", "xauthlocation"]);

function value(slot: string, v: string): string {
    if (!SINGLE.has(slot) || !/[\s"'#\\]/.test(v)) return v;
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 表單裡顯示、可以改的值（一個值的選項不帶引號，其他照原文）。/ The value as edited in a form. */
export function editValue(l: CfgLine): string {
    return SINGLE.has(l.slot) ? (l.args[0] ?? "") : l.rest.trim();
}

function optionLine(cfg: ParsedConfig, key: string, v: string): CfgLine {
    const slot = slotOf(key);
    return { ...parseLine(0, `${cfg.indent}${spell(key)} ${value(slot, v)}`), n: 0 };
}

function hostBlock(cfg: ParsedConfig, host: string, body: CfgLine[], spacedLead: boolean): CfgBlock {
    const b = newBlock("host", { ...parseLine(0, `Host ${host}`), n: 0 }, spacedLead && cfg.spaced ? [{ ...parseLine(0, ""), n: 0 }] : []);
    b.body = body;
    return b;
}

const render = (cfg: ParsedConfig, blocks: CfgBlock[]) => renderConfig({ ...cfg, blocks }).text;
const validValue = (v: string) => v.trim() !== "" && !/[\r\n]/.test(v);

/** 讀起來 `key` 對 `host` 的值（比較用）。/ The value `key` has for `host` (for comparing). */
function effective(blocks: CfgBlock[], host: string, slot: string): string | null {
    const eff = resolve(blocks, host);
    if (stacks(slot)) return eff.lists.get(slot)?.map((s) => s.text).join("\u0000") ?? null;
    return eff.first.get(slot)?.text ?? null;
}

// ── Changing one host ────────────────────────────────────────────────────────

/**
 * 讓 `host` 的 `key` 變成 `v`：它自己的區塊已經給了值就原地改；否則加進它自己、而且在目前提供值的區塊之前的區塊；
 * 都沒有就在那個區塊前面開一個 `Host <host>`。
 * Make `key` read `v` for `host`: change its own line in place when its own block gives the value; otherwise add it to
 * an own block that comes before the block giving the current value, or open a `Host <host>` right before that block.
 */
export function setOption(text: string, host: string, key: string, v: string): EditResult {
    const slot = slotOf(key);
    if (!validValue(v)) return { error: { code: "bad_value", key } };
    if (stacks(slot)) return setOwnList(text, host, key, [v]);
    const cfg = parseConfig(text);
    const blocks = [...cfg.blocks];
    const src = firstSetter(cfg, host, slot);
    const own = ownIndexes(cfg, host);
    const line = optionLine(cfg, key, v);
    if (src && src.i === 0 && blocks[0].kind === "global") return { error: { code: "global", line: src.line.n, key: src.line.key } };
    if (src && own.includes(src.i)) {
        // 原地換掉那一行（同一個區塊後面同選項的行本來就讀不到，留著）。/ Replace that line in place.
        const b = blocks[src.i];
        blocks[src.i] = { ...b, body: b.body.map((l) => (l === src.line ? { ...line, raw: /^[ \t]*/.exec(l.raw)![0] + line.raw.trimStart() } : l)) };
    } else {
        const before = own.find((j) => !src || j < src.i);
        if (before !== undefined) {
            const b = blocks[before];
            blocks[before] = { ...b, body: [...b.body, line] };
        } else {
            const at = src ? src.i : newHostIndex(cfg, host);
            blocks.splice(at, 0, hostBlock(cfg, host, [line], true));
        }
    }
    const out = render(cfg, blocks);
    const want = { ...line, n: 0 };
    if (effective(parseConfig(out).blocks, host, slot) !== effective([{ ...newBlock("global", null, []), body: [want] }], host, slot)) return { error: { code: "no_effect", key } };
    return { text: out };
}

/** 拿掉 `host` 自己區塊裡的 `key`（之後照別的區塊或 ssh 預設）。/ Drop `key` from `host`'s own blocks (it then inherits). */
export function clearOption(text: string, host: string, key: string): EditResult {
    const slot = slotOf(key);
    const cfg = parseConfig(text);
    const own = new Set(ownIndexes(cfg, host));
    let found = false;
    const blocks = cfg.blocks.map((b, i) => {
        if (!own.has(i)) return b;
        const body = b.body.filter((l) => {
            const hit = l.kind === "option" && l.slot === slot;
            found ||= hit;
            return !hit;
        });
        return { ...b, body };
    });
    if (!found) return { error: { code: "not_found" } };
    return { text: render(cfg, dropEmpty(blocks)) };
}

/**
 * `host` 自己的累加選項（IdentityFile…）整串換成 `values`：舊的拿掉，新的放在它自己、而且排在其他給這個選項的區塊之前的
 * 區塊（所以照順序先試）。/ Replace `host`'s own stacked option (IdentityFile …) with `values`, in an own block that comes
 * before every other block giving that option (so they are tried first).
 */
export function setOwnList(text: string, host: string, key: string, values: string[]): EditResult {
    const slot = slotOf(key);
    if (values.some((v) => !validValue(v))) return { error: { code: "bad_value", key } };
    const cfg = parseConfig(text);
    const own = ownIndexes(cfg, host);
    let blocks = cfg.blocks.map((b, i) => (own.includes(i) ? { ...b, body: b.body.filter((l) => !(l.kind === "option" && l.slot === slot)) } : b));
    if (values.length > 0) {
        const lines = values.map((v) => optionLine(cfg, key, v));
        const src = firstSetter({ ...cfg, blocks }, host, slot);
        if (src && src.i === 0 && blocks[0].kind === "global") return { error: { code: "global", line: src.line.n, key: src.line.key } };
        const before = own.find((j) => !src || j < src.i);
        if (before !== undefined) blocks[before] = { ...blocks[before], body: [...blocks[before].body, ...lines] };
        else blocks.splice(src ? src.i : newHostIndex({ ...cfg, blocks }, host), 0, hostBlock(cfg, host, lines, true));
    }
    blocks = dropEmpty(blocks);
    const out = render(cfg, blocks);
    const got = resolve(parseConfig(out).blocks, host).lists.get(slot)?.map((s) => s.text) ?? [];
    if (values.some((v, i) => got[i] !== optionLine(cfg, key, v).args.join("\u0000"))) return { error: { code: "no_effect", key } };
    return { text: out };
}

/** 選項全被拿掉的使用者區塊（沒有註解）整段拿掉。/ User blocks left with no option (and no comment) go. */
function dropEmpty(blocks: CfgBlock[]): CfgBlock[] {
    return blocks.map((b) => (b.kind === "host" && b.owner.kind === "user" && b.body.every((l) => l.kind === "blank") ? { ...b, dropped: true } : b));
}

// ── Hosts ────────────────────────────────────────────────────────────────────

const telepyManaged = (cfg: ParsedConfig, host: string) => cfg.blocks.some((b) => b.owner.kind === "telepy" && b.patterns[0] === host);

/** 新增主機：放在第一個可能也套用到它的萬用字元區塊 / Match 之前，每個值都確認讀得到。/ Add a host; every value is checked. */
export function addHost(text: string, name: string, entries: { key: string; value: string }[]): EditResult {
    if (!plainName(name)) return { error: { code: "bad_name" } };
    const cfg = parseConfig(text);
    if (hostNames(cfg).includes(name)) return { error: { code: "exists" } };
    const bad = entries.find((e) => !validValue(e.value) || !e.key.trim());
    if (bad) return { error: { code: "bad_value", key: bad.key } };
    for (const e of entries) {
        const g = cfg.blocks[0];
        const hit = g.kind === "global" ? options(g).find(setsSlot(slotOf(e.key))) : undefined;
        if (hit && !stacks(slotOf(e.key))) return { error: { code: "global", line: hit.n, key: hit.key } };
    }
    const blocks = [...cfg.blocks];
    const at = newHostIndex(cfg, name);
    const b = hostBlock(cfg, name, entries.map((e) => optionLine(cfg, e.key, e.value)), true);
    // 放在最後、而且前一行不是空行時，用空行隔開（照檔案原本的習慣）。/ Spacing follows the file's habit.
    blocks.splice(at, 0, b);
    return { text: render(cfg, blocks) };
}

/** 拿掉 `Host` 行上的一個名稱；沒有正樣式剩下的區塊整段拿掉（Telepy 的標記一起）。/ Drop a name from Host lines. */
export function removeHost(text: string, name: string): EditResult {
    const cfg = parseConfig(text);
    if (!hostNames(cfg).includes(name)) return { error: { code: "not_found" } };
    const blocks = cfg.blocks.map((b) => {
        if (b.kind !== "host" || !b.patterns.includes(name)) return b;
        const patterns = b.patterns.filter((p) => p !== name);
        if (!patterns.some((p) => !p.startsWith("!"))) {
            // 整段拿掉；Telepy 的開頭標記在 lead 最後一行、結尾標記在 tail。/ The whole block, Telepy markers included.
            const lead = b.marker ? b.lead.slice(0, -1) : b.lead;
            return { ...b, lead, dropped: true };
        }
        const header = { ...parseLine(0, `${b.header!.key} ${patterns.join(" ")}`), n: 0 };
        return { ...b, header, patterns };
    });
    return { text: render(cfg, blocks) };
}

/**
 * 改名：每個 Host 行上的這個名稱換掉。`keep` = 改名後讀起來不一樣的設定（HostName 的 %h、萬用字元比中的不同）在新名字
 * 自己的區塊寫死原本的值，所以連的還是同一台。Telepy 管的主機不改（名稱跟著通道）。
 * Rename: the name is replaced on every Host line. `keep` pins settings that would read differently under the new
 * name (HostName's %h, different wildcard matches) in its own block, so it still reaches the same machine. Hosts
 * Telepy manages are refused (their names follow the tunnel).
 */
export function renameHost(text: string, from: string, to: string, keep = true): EditResult {
    if (!plainName(to)) return { error: { code: "bad_name" } };
    const cfg = parseConfig(text);
    if (!hostNames(cfg).includes(from)) return { error: { code: "not_found" } };
    if (from !== to && hostNames(cfg).includes(to)) return { error: { code: "exists" } };
    if (telepyManaged(cfg, from)) return { error: { code: "telepy" } };
    const blocks = cfg.blocks.map((b) => {
        if (b.kind !== "host" || !b.patterns.includes(from)) return b;
        const patterns = b.patterns.map((p) => (p === from ? to : p));
        return { ...b, patterns, header: { ...parseLine(0, `${b.header!.key} ${patterns.join(" ")}`), n: 0 } };
    });
    let out = render(cfg, blocks);
    if (!keep) return { text: out };
    const before = resolve(cfg.blocks, from);
    const after = resolve(parseConfig(out).blocks, to);
    for (const [slot, src] of before.first) {
        if (after.first.get(slot)?.text === src.text) continue;
        // 寫死原本讀到的值（HostName 是展開後的）。/ Pin the value it read before (HostName expanded).
        const literal = slot === "hostname" ? src.text : src.line.rest.trim();
        const r = setOption(out, to, src.line.key, literal);
        if (r.text !== undefined) out = r.text;
    }
    return { text: out };
}

// ── Fixes ────────────────────────────────────────────────────────────────────

export type FixKind = "apply" | "remove" | "ignore";

/** 一則提醒能怎麼修。/ The fixes a note offers. */
export function fixesFor(note: Note): FixKind[] {
    switch (note.kind) {
        case "shadowed":
            return ["apply", "remove"];
        case "unknown":
            return ["remove", "ignore"];
        case "ignored":
        case "invalid":
            return ["remove"];
        case "wall":
            return [];
    }
}

function locate(cfg: ParsedConfig, n: number): { i: number; line: CfgLine } | null {
    for (let i = 0; i < cfg.blocks.length; i++) {
        const line = cfg.blocks[i].body.find((l) => l.n === n);
        if (line) return { i, line };
    }
    return null;
}

/** 拿掉第 n 行（選項全空的使用者區塊一起拿掉）。/ Remove line n (a user block left empty goes too). */
export function removeLine(text: string, n: number): EditResult {
    const cfg = parseConfig(text);
    const at = locate(cfg, n);
    if (!at) return { error: { code: "not_found" } };
    const blocks = [...cfg.blocks];
    blocks[at.i] = { ...blocks[at.i], body: blocks[at.i].body.filter((l) => l !== at.line) };
    return { text: render(cfg, dropEmpty(blocks)) };
}

/**
 * 「讓這行生效」：同一個區塊裡被前面那行蓋掉 → 拿掉前面那行；被前面的區塊蓋掉 → 這行連同它的 Host 行搬到最早蓋掉它的
 * 區塊前面（全域設定蓋不過）。/ "Make this line apply": shadowed in its own block → drop the earlier line; shadowed by
 * an earlier block → move it, with its Host line, in front of the earliest block that shadows it (the global
 * section can't be overtaken).
 */
function makeApply(text: string, note: Extract<Note, { kind: "shadowed" }>): EditResult {
    const cfg = parseConfig(text);
    const at = locate(cfg, note.n);
    const by = locate(cfg, note.by);
    if (!at || !by) return { error: { code: "not_found" } };
    if (at.i === by.i) return removeLine(text, note.by);
    const b = cfg.blocks[at.i];
    let first = Infinity;
    for (const h of b.patterns.filter((p) => !p.startsWith("!"))) {
        const s = firstSetter(cfg, h, at.line.slot);
        if (s) first = Math.min(first, s.i);
    }
    if (first === 0 && cfg.blocks[0].kind === "global") return { error: { code: "global", line: note.by, key: note.key } };
    if (!Number.isFinite(first)) return { error: { code: "not_found" } };
    const blocks = [...cfg.blocks];
    blocks[at.i] = { ...b, body: b.body.filter((l) => l !== at.line) };
    const moved = newBlock("host", { ...parseLine(0, b.header!.raw.trim()), n: 0 }, cfg.spaced ? [{ ...parseLine(0, ""), n: 0 }] : []);
    moved.body = [{ ...at.line, n: 0, raw: cfg.indent + at.line.raw.trimStart() }];
    blocks.splice(first, 0, moved);
    return { text: render(cfg, dropEmpty(blocks)) };
}

/** `IgnoreUnknown` 加上這個選項：已經有就接在後面，沒有就寫在檔案最上面。/ Add the option to IgnoreUnknown. */
function ignoreUnknown(text: string, key: string): EditResult {
    const cfg = parseConfig(text);
    const g = cfg.blocks[0];
    const existing = g.kind === "global" ? options(g).find((l) => l.slot === "ignoreunknown") : undefined;
    const blocks = [...cfg.blocks];
    if (existing) {
        const list = [...existing.args.join(",").split(","), key.toLowerCase()].filter(Boolean);
        const line = { ...parseLine(0, `${existing.key} ${[...new Set(list)].join(",")}`), n: 0 };
        blocks[0] = { ...g, body: g.body.map((l) => (l === existing ? line : l)) };
    } else {
        blocks[0] = { ...g, body: [{ ...parseLine(0, `IgnoreUnknown ${key.toLowerCase()}`), n: 0 }, ...g.body] };
    }
    return { text: render(cfg, blocks) };
}

export function applyFix(text: string, note: Note, kind: FixKind): EditResult {
    if (kind === "remove" && "n" in note) return removeLine(text, note.n);
    if (kind === "apply" && note.kind === "shadowed") return makeApply(text, note);
    if (kind === "ignore" && note.kind === "unknown") return ignoreUnknown(text, note.key);
    return { error: { code: "not_found" } };
}

// ── What a change does ───────────────────────────────────────────────────────

export interface EffectChange {
    /** 名稱（OTHER = 檔案沒寫到的其他名稱）。/ The name (OTHER = any name the file doesn't spell out). */
    name: string;
    slot: string;
    key: string;
    before: string | null;
    after: string | null;
}

/** 給人看的值：HostName 展開 %h，累加的接起來。/ The value as shown: HostName expanded, stacks joined. */
function shown(src: Source): string {
    return src.line.slot === "hostname" ? src.text : src.line.rest.trim();
}

function table(blocks: CfgBlock[], host: string): Map<string, { key: string; value: string }> {
    const eff = resolve(blocks, host);
    const out = new Map<string, { key: string; value: string }>();
    for (const [slot, s] of eff.first) out.set(slot, { key: s.line.key, value: shown(s) });
    for (const [slot, list] of eff.lists) out.set(slot, { key: list[0].line.key, value: list.map((s) => shown(s)).join(", ") });
    return out;
}

/**
 * 改動前後，每個名稱哪些設定變了（`renamed` = 改名，舊名稱的「前」對新名稱的「後」）。
 * What each name gets differently after a change (`renamed`: the old name before against the new name after).
 */
export function effectChanges(before: string, after: string, renamed?: { from: string; to: string }): EffectChange[] {
    const a = parseConfig(before);
    const b = parseConfig(after);
    const names = [...new Set([...hostNames(a), ...hostNames(b)])].filter((n) => !renamed || n !== renamed.to);
    const out: EffectChange[] = [];
    for (const name of [...names, OTHER]) {
        const x = table(a.blocks, name);
        const y = table(b.blocks, renamed && name === renamed.from ? renamed.to : name);
        for (const slot of new Set([...x.keys(), ...y.keys()])) {
            const p = x.get(slot);
            const q = y.get(slot);
            if (p?.value === q?.value) continue;
            out.push({ name, slot, key: (q ?? p)!.key, before: p?.value ?? null, after: q?.value ?? null });
        }
    }
    return out;
}

// ── Overview ─────────────────────────────────────────────────────────────────

export interface Cell {
    key: string;
    value: string;
    /** 表單裡可以改的寫法（%h 不展開）。/ The value as edited in a form (%h kept). */
    edit: string;
    /** 給這個值的那一行與它的 Host 行。/ The line giving it and its block's header. */
    n: number;
    header: string;
    /** 來自它自己的區塊（可以直接改 / 清掉）。/ From the host's own block (can be changed / cleared there). */
    own: boolean;
    /** 來自好幾個名稱共用的區塊或萬用字元 / 全域設定。/ From a block shared with other names, a wildcard or the global section. */
    shared: boolean;
}

export interface HostRow {
    name: string;
    /** 第一個值算數的選項。/ First-value options. */
    cells: Record<string, Cell>;
    /** 累加的選項，照順序。/ Stacked options, in order. */
    stacks: Record<string, Cell[]>;
    /** Telepy 管的主機。/ A host Telepy manages. */
    telepy: boolean;
}

function cellOf(s: Source, host: string, ownSet: Set<CfgBlock>): Cell {
    const b = s.block;
    return {
        key: s.line.key,
        value: shown(s),
        edit: editValue(s.line),
        n: s.line.n,
        header: b.header ? b.header.raw.trim() : "",
        own: ownSet.has(b),
        shared: b.kind === "global" || b.patterns.length > 1 || b.patterns.some(isWild),
    };
}

function rowFor(cfg: ParsedConfig, name: string, blocks = cfg.blocks): HostRow {
    const ownSet = new Set(ownIndexes(cfg, name).map((i) => cfg.blocks[i]));
    const eff = resolve(blocks, name);
    const cells: Record<string, Cell> = {};
    const lists: Record<string, Cell[]> = {};
    for (const [slot, s] of eff.first) cells[slot] = cellOf(s, name, ownSet);
    for (const [slot, list] of eff.lists) lists[slot] = list.map((s) => cellOf(s, name, ownSet));
    return { name, cells, stacks: lists, telepy: telepyManaged(cfg, name) };
}

/** 每個名稱實際用的設定（+ 檔案沒寫到的其他名稱）。/ What every name actually uses (+ any other name). */
export function hostTable(text: string): { rows: HostRow[]; other: HostRow; hasMatch: boolean } {
    const cfg = parseConfig(text);
    return {
        rows: hostNames(cfg).map((n) => rowFor(cfg, n)),
        other: rowFor(cfg, OTHER),
        hasMatch: cfg.blocks.some((b) => b.kind === "match"),
    };
}

/** 拿掉它自己的區塊後會用的值（編輯時的「繼承」提示）。/ What a host would use without its own blocks (the "inherited" hint). */
export function inheritedRow(text: string, name: string): HostRow {
    const cfg = parseConfig(text);
    const own = new Set(ownIndexes(cfg, name));
    return rowFor(cfg, name, cfg.blocks.filter((_, i) => !own.has(i)));
}

// ── Editing a host from a form ───────────────────────────────────────────────

export interface HostDraft {
    name: string;
    /** 要設定的值（key → 值）。/ Values to set (key → value). */
    set: Record<string, string>;
    /** 要拿掉自己的值、改回繼承的選項。/ Options whose own line goes (back to inherited). */
    clear: string[];
    /** 累加選項自己的那幾行（整串換掉）。/ A stacked option's own lines (replaced whole). */
    lists: Record<string, string[]>;
}

/**
 * 表單的草稿套到文字上：新主機 = addHost；既有的照序 set / clear / lists，最後改名（保留原本連的）。
 * Apply a form draft: a new host is addHost; an existing one gets set / clear / lists in order, then the rename
 * (keeping what it reaches).
 */
export function applyHostDraft(text: string, host: string | null, draft: HostDraft): EditResult {
    const name = draft.name.trim();
    if (host === null) {
        const entries = [
            ...Object.entries(draft.set).filter(([, v]) => v.trim() !== "").map(([key, value]) => ({ key, value: value.trim() })),
            ...Object.entries(draft.lists).flatMap(([key, vs]) => vs.filter((v) => v.trim()).map((value) => ({ key, value: value.trim() }))),
        ];
        return addHost(text, name, entries);
    }
    let out = text;
    for (const key of draft.clear) {
        const r = clearOption(out, host, key);
        if (r.error && r.error.code !== "not_found") return r;
        if (r.text !== undefined) out = r.text;
    }
    for (const [key, v] of Object.entries(draft.set)) {
        const r = setOption(out, host, key, v.trim());
        if (r.error) return r;
        out = r.text;
    }
    for (const [key, vs] of Object.entries(draft.lists)) {
        const r = setOwnList(out, host, key, vs.map((v) => v.trim()).filter(Boolean));
        if (r.error) return r;
        out = r.text;
    }
    if (name !== host) return renameHost(out, host, name, true);
    return { text: out };
}
