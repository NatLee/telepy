import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainHost, traceHost, globsIntersect, hostMatches, namesIn, parseConfig, renderConfig, resolve, tidyConfig } from "./sshConfigTidy.ts";
import { markedBlocks, type ConfigStanza } from "./sshConfig.ts";

// 真的 ssh：`ssh -G -F <檔> <名稱>` 印出這個名稱實際拿到的設定（不連線）。兩份設定對每個名稱印出來一模一樣 = 等價。
// The real ssh: `ssh -G -F <file> <name>` prints what a name actually gets (no connection). Identical output for
// every name = equivalent configs.
const HAVE_SSH = spawnSync("ssh", ["-V"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "telepy-tidy-"));
let fileNo = 0;
function sshG(config: string, names: string[]): Map<string, string> {
    const file = join(dir, `c${fileNo++}.conf`);
    writeFileSync(file, config);
    const script = names.map((n) => `ssh -G -F '${file}' '${n}' 2>&1; echo '@@end'`).join("\n");
    const out = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" }).stdout.split("@@end\n");
    // 錯誤訊息裡有檔名：換掉才能比。/ Error messages name the file: replace it so outputs compare.
    return new Map(names.map((n, i) => [n, out[i].split(file).join("CONFIG")]));
}
function assertSameForSsh(before: string, after: string, names: string[]) {
    if (!HAVE_SSH) return;
    const a = sshG(before, names);
    const b = sshG(after, names);
    for (const n of names) assert.equal(b.get(n), a.get(n), `ssh -G ${n} differs\n--- before\n${before}\n--- after\n${after}`);
}

const SAMPLE = `# my servers
Host *
    ServerAliveInterval 60

Host web1
    HostName web1.example.com
    User deploy
    IdentityFile ~/.ssh/work
    User deploy

Host web2
    HostName web2.example.com
    User deploy
    IdentityFile ~/.ssh/work

Host db
    HostName 10.0.0.5
    User deploy
    IdentityFile ~/.ssh/work
    Port 2222
    ServerAliveInterval 30
`;

test("shared lines move into one block, HostName becomes %h, and ssh reads every name the same", () => {
    const r = tidyConfig(SAMPLE);
    assert.equal(
        r.text,
        `# my servers
Host *
    ServerAliveInterval 60

Host db
    HostName 10.0.0.5
    Port 2222
    ServerAliveInterval 30

Host web1 web2 db
    HostName %h.example.com
    User deploy
    IdentityFile ~/.ssh/work
`,
    );
    assert.deepEqual(r.failed, []);
    assert.deepEqual(r.before, { lines: 21, settings: 17, blocks: 4 });
    assert.deepEqual(r.after, { lines: 13, settings: 10, blocks: 3 });
    assert.deepEqual(r.changes.map((c) => c.kind), ["duplicate", "shared"]);
    // db 的 ServerAliveInterval 30 永遠讀不到（Host * 先給了 60）：留著、提醒。/ Never read: kept and reported.
    assert.deepEqual(r.notes, [{ kind: "shadowed", n: 21, key: "ServerAliveInterval", host: "db", by: 3, value: "30", winner: "60" }]);
    assert.ok(r.text.includes("ServerAliveInterval 30"));
    assert.ok(r.checked.includes("web1") && r.checked.includes("db"));
    assertSameForSsh(SAMPLE, r.text, ["web1", "web2", "db", "WEB1", "other"]);
});

test("Host matching is case-sensitive and negation turns a block off (match.c / readconf.c)", () => {
    assert.equal(hostMatches(["web1"], "web1"), true);
    assert.equal(hostMatches(["web1"], "WEB1"), false);
    assert.equal(hostMatches(["web*", "!web2"], "web2"), false);
    assert.equal(hostMatches(["!web2", "web*"], "web3"), true);
    assert.equal(hostMatches(["?b"], "ab"), true);
    assert.equal(hostMatches(["a.b"], "axb"), false, "a dot is a dot");
});

test("first value wins, IdentityFile adds up, ProxyJump yields to an earlier ProxyCommand", () => {
    const cfg = parseConfig("Host a\n  User one\n  IdentityFile k1\n  ProxyCommand nc %h %p\nHost *\n  User two\n  IdentityFile k2\n  ProxyJump j\n  HostName %h.lab\n");
    const eff = resolve(cfg.blocks, "a");
    assert.equal(eff.first.get("user")?.text, "one");
    assert.deepEqual(eff.lists.get("identityfile")?.map((s) => s.text), ["k1", "k2"]);
    assert.equal(eff.first.get("proxyjump"), undefined);
    assert.equal(eff.first.get("hostname")?.text, "a.lab", "%h is the typed name");
});

test("Key=value, quotes, aliases of one option and trailing comments parse like OpenSSH", () => {
    const cfg = parseConfig('Host a\n  User=bob\n  IdentityFile "~/My Keys/id"\n  PubkeyAcceptedKeyTypes x\n  PubkeyAcceptedAlgorithms y # later\n');
    const eff = resolve(cfg.blocks, "a");
    assert.equal(eff.first.get("user")?.text, "bob");
    assert.deepEqual(eff.lists.get("identityfile")?.map((s) => s.text), ["~/My Keys/id"]);
    assert.equal(eff.first.get("pubkeyacceptedalgorithms")?.text, "x", "the old name and the new one are one setting");
});

test("nothing to do leaves the text exactly as it was", () => {
    const text = "Host a\n\tUser x\n\n# note\nHost b\n\tPort 2200\n";
    const r = tidyConfig(text);
    assert.equal(r.text, text);
    assert.deepEqual(r.changes, []);
    assert.equal(r.removed.size, 0);
    // 原樣讀進來再寫回去也一樣（CRLF 也是）。/ A parse + render round trip is exact (CRLF too).
    const crlf = "Host a\r\n  User x\r\n";
    assert.equal(renderConfig(parseConfig(crlf)).text, crlf);
});

test("identical blocks merge into one Host line", () => {
    const text = "Host a\n    User x\n    Port 2200\n\nHost b\n    User x\n    Port 2200\n";
    const r = tidyConfig(text);
    assert.equal(r.text, "Host a b\n    User x\n    Port 2200\n");
    assertSameForSsh(text, r.text, ["a", "b", "c"]);
});

test("a line is never moved past a block that would change what ssh reads", () => {
    // b 的 User x 讀不到（Host * 在前面），a 的讀得到：不能合在一起。/ b's User x is never read, a's is: they can't merge.
    const text = "Host a\n    User x\nHost *\n    User y\nHost b\n    User x\n";
    const r = tidyConfig(text);
    assert.equal(r.text, text);
    assert.equal(r.notes[0].kind, "shadowed");
    assertSameForSsh(text, r.text, ["a", "b", "c"]);
});

test("IdentityFile order is kept: a stack that would change order stays put", () => {
    const text = "Host a\n  IdentityFile k0\n  IdentityFile k1\nHost b\n  IdentityFile k1\nHost *\n  IdentityFile k9\n";
    const r = tidyConfig(text);
    assertSameForSsh(text, r.text, ["a", "b", "c"]);
    for (const h of ["a", "b"]) {
        const before = resolve(parseConfig(text).blocks, h).lists.get("identityfile")!.map((s) => s.text);
        const after = resolve(parseConfig(r.text).blocks, h).lists.get("identityfile")!.map((s) => s.text);
        assert.deepEqual(after, before);
    }
});

test("Match and Include are walls: no line crosses them", () => {
    const text = "Host a\n  User x\n  Port 2200\nMatch exec \"true\"\n  User z\nHost b\n  User x\n  Port 2200\n";
    const r = tidyConfig(text);
    assert.equal(r.text, text, "a and b are on either side of Match");
    assert.ok(r.notes.some((n) => n.kind === "wall"));
    const inc = "Host a\n  User x\n  Port 2200\nHost c\n  Include other.conf\nHost b\n  User x\n  Port 2200\n";
    assert.equal(tidyConfig(inc).text, inc);
});

test("unknown and ignored options are reported", () => {
    const r = tidyConfig("Host a\n  Usr x\n  Protocol 2\n  Hostname a.example\n");
    assert.deepEqual(r.notes.map((n) => n.kind), ["unknown", "ignored"]);
});

test("wildcards are opt-in, never catch another name in the file, and say what they widen", () => {
    const text = "Host web-1\n  HostName 10.0.0.1\nHost web-2\n  HostName 10.0.0.2\nHost web-1 web-2\n  User deploy\n  Port 2200\n";
    assert.equal(tidyConfig(text).text, text);
    const r = tidyConfig(text, { wildcards: true });
    assert.equal(r.text, "Host web-1\n  HostName 10.0.0.1\nHost web-2\n  HostName 10.0.0.2\nHost web-*\n  User deploy\n  Port 2200\n");
    assert.deepEqual(r.widened, [{ pattern: "web-*", hosts: ["web-1", "web-2"] }]);
    assertSameForSsh(text, r.text, ["web-1", "web-2", "web"]);
    // 檔案裡還有 web-db：web-* 會吃到它，就不用萬用字元。/ web-db is in the file too: no wildcard.
    const clash = text + "Host web-db\n  User root\n";
    assert.ok(!tidyConfig(clash, { wildcards: true }).text.includes("web-*"));
});

test("glob intersection", () => {
    assert.equal(globsIntersect("web-*", "*.lab"), true);
    assert.equal(globsIntersect("web-*", "db-*"), false);
    assert.equal(globsIntersect("a?c", "*b*"), true);
    assert.equal(globsIntersect("abc", "abd"), false);
});

test("a very long list of names is split over several Host lines", () => {
    const names = Array.from({ length: 120 }, (_, i) => `device-number-${i}.lab.example`);
    const text = names.map((n) => `Host ${n}\n    User admin\n    Port 2222\n`).join("");
    const r = tidyConfig(text);
    const hostLines = r.text.split("\n").filter((l) => l.startsWith("Host "));
    assert.ok(hostLines.length >= 4, hostLines.join("\n"));
    assert.ok(hostLines.every((l) => l.length <= 1000));
    assert.deepEqual(namesIn(r.text).sort(), [...names].sort());
    assertSameForSsh(text, r.text, [names[0], names[60], names[119], "nope"]);
});

// ── Telepy's own blocks ──────────────────────────────────────────────────────

const ME = "telepy-telepy.example-24242";
const opts = (pairs: [string, string][]) => pairs.map(([key, value]) => ({ key, value }));
const serverStanza: ConfigStanza = {
    alias: ME,
    options: opts([["HostName", "telepy.example"], ["Port", "24242"], ["Compression", "yes"], ["StrictHostKeyChecking", "yes"], ["UserKnownHostsFile", "~/.ssh/telepy_known_hosts"], ["HostKeyAlias", ME], ["User", "telepy"]]),
};
const device = (alias: string, user: string, id: number, strict = "yes", host = alias, server = ME): ConfigStanza => ({
    alias,
    options: opts([["HostName", host], ["Port", "22"], ["Compression", "yes"], ["StrictHostKeyChecking", strict], ["UserKnownHostsFile", "~/.ssh/telepy_known_hosts"], ["HostKeyAlias", `${server}-device-${id}`], ["User", user], ["ProxyCommand", `ssh -W %h:%p ${server}`]]),
});

test("Telepy devices share one marked block; each keeps its markers, ProxyCommand and HostKeyAlias", () => {
    const text = markedBlocks([serverStanza, device("pi", "pi", 1), device("nas-root", "root", 2, "yes", "nas"), device("nas-admin", "admin", 2, "yes", "nas"), device("cam", "root", 3, "accept-new"), device("router", "root", 4)]);
    const r = tidyConfig(text);
    assert.deepEqual(r.failed, []);
    const shared = `# >>> telepy shared ${ME} >>>\nHost pi nas-root nas-admin cam router\n    HostName %h\n    Port 22\n    Compression yes\n    StrictHostKeyChecking yes\n    UserKnownHostsFile ~/.ssh/telepy_known_hosts\n    User root\n# <<< telepy shared ${ME} <<<\n`;
    assert.ok(r.text.endsWith(shared), r.text);
    // 伺服器區塊原封不動。/ The server block is untouched.
    assert.ok(r.text.startsWith(markedBlocks([serverStanza])));
    assert.ok(r.text.includes(`# >>> telepy cam >>>\nHost cam\n    StrictHostKeyChecking accept-new\n    HostKeyAlias ${ME}-device-3\n    ProxyCommand ssh -W %h:%p ${ME}\n# <<< telepy cam <<<\n`), r.text);
    for (const a of ["pi", "nas-root", "nas-admin", "cam", "router"]) {
        assert.ok(r.text.includes(`# >>> telepy ${a} >>>\nHost ${a}\n`) && r.text.includes(`# <<< telepy ${a} <<<`), a);
    }
    assertSameForSsh(text, r.text, ["pi", "nas-root", "nas-admin", "cam", "router", ME, "other"]);
});

test("devices of two Telepy servers and the user's own blocks never share a block", () => {
    const OTHER = "telepy-other.example-22";
    const text = markedBlocks([device("pi", "root", 1), device("cam", "root", 2), device("nas", "root", 3)]) + markedBlocks([device("a", "root", 1, "yes", "a", OTHER), device("b", "root", 2, "yes", "b", OTHER), device("c", "root", 3, "yes", "c", OTHER)]) + "Host mine\n    Port 22\n    Compression yes\n    User root\n";
    const r = tidyConfig(text);
    const sharedHosts = r.text.split("\n").filter((l, i, all) => i > 0 && all[i - 1].startsWith("# >>> telepy shared ")).sort();
    assert.deepEqual(sharedHosts, ["Host a b c", "Host pi cam nas"]);
    assert.ok(r.text.includes(`# >>> telepy shared ${OTHER} >>>`));
    assert.ok(r.text.endsWith("Host mine\n    Port 22\n    Compression yes\n    User root\n"), "the user's block stays its own");
    assertSameForSsh(text, r.text, ["pi", "cam", "nas", "a", "b", "c", "mine"]);
});

test("an already simplified Telepy config has nothing left to do", () => {
    const text = markedBlocks([serverStanza, device("pi", "pi", 1), device("cam", "root", 3), device("router", "root", 4), device("nas", "root", 5)]);
    const once = tidyConfig(text).text;
    assert.notEqual(once, text);
    assert.equal(tidyConfig(once).text, once);
});

test("explainHost says which line gives each value", () => {
    const { rows } = explainHost(SAMPLE, "db");
    const by = Object.fromEntries(rows.map((r) => [r.slot, r]));
    assert.equal(by.serveralivefinterval, undefined);
    assert.equal(by.serveraliveinterval.n, 3);
    assert.equal(by.serveraliveinterval.header, "Host *");
    assert.equal(by.port.value, "2222");
    const after = explainHost(tidyConfig(SAMPLE).text, "web2");
    assert.equal(after.rows.find((r) => r.slot === "hostname")?.value, "%h.example.com");
});

test("traceHost walks the blocks for one name, marking what ssh uses and skips", () => {
    const t = traceHost(SAMPLE, "db");
    assert.deepEqual(t.blocks.map((b) => b.header), ["Host *", "Host db"]);
    const db = t.blocks[1].lines;
    assert.equal(db.find((l) => l.key === "ServerAliveInterval")?.state, "skipped");
    assert.equal(db.find((l) => l.key === "Port")?.state, "used");
    assert.equal(db.find((l) => l.key === "IdentityFile")?.state, "stacked");
    const after = traceHost(tidyConfig(SAMPLE).text, "db");
    assert.deepEqual(after.blocks.map((b) => b.header), ["Host *", "Host db", "Host web1 web2 db"]);
    assert.equal(after.blocks[2].lines.find((l) => l.key === "HostName")?.state, "skipped", "db reads its own HostName first");
});

// ── Random configs against the real ssh ─────────────────────────────────────

const NAMES = ["a", "b", "c", "web1", "web2", "db.lab", "db2.lab", "x-1", "x-2"];
const PATTERNS = ["*", "web*", "*.lab", "x-?", "!web2", "!db.lab"];
const OPTIONS: [string, string[]][] = [
    ["User", ["u1", "u2"]],
    ["Port", ["22", "2222"]],
    ["HostName", ["%h.example.com", "10.0.0.1", "SELF"]],
    ["Compression", ["yes", "no"]],
    ["IdentityFile", ["~/.ssh/a", "~/.ssh/b"]],
    ["LocalForward", ["8080 localhost:80", "9090 localhost:90"]],
    ["ServerAliveInterval", ["30", "60"]],
    ["ProxyJump", ["j1", "j2"]],
    ["SendEnv", ["LANG", "LC_X"]],
    ["StrictHostKeyChecking", ["yes", "accept-new"]],
];

function rng(seed: number) {
    return () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x80000000;
    };
}

function randomConfig(seed: number): string {
    const r = rng(seed);
    const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    const out: string[] = [];
    if (r() < 0.2) {
        const [key, values] = pick(OPTIONS);
        out.push(`${key} ${pick(values).replace("SELF", "global")}`);
    }
    const blocks = 3 + Math.floor(r() * 7);
    for (let i = 0; i < blocks; i++) {
        if (r() < 0.07) {
            out.push("Match all", `    User m${i}`);
            continue;
        }
        const pats = new Set<string>();
        const n = r() < 0.75 ? 1 + Math.floor(r() * 2) : 1;
        for (let k = 0; k < n; k++) pats.add(r() < 0.75 ? pick(NAMES) : pick(PATTERNS));
        if ([...pats].every((p) => p.startsWith("!"))) pats.add(pick(NAMES));
        out.push(`Host ${[...pats].join(" ")}`);
        const lines = Math.floor(r() * 5);
        for (let k = 0; k < lines; k++) {
            const [key, values] = pick(OPTIONS);
            const name = [...pats].find((p) => !/[*?!]/.test(p)) ?? "z";
            out.push(`    ${key} ${pick(values).replace("SELF", name)}`);
        }
        if (r() < 0.3) out.push("");
    }
    return out.join("\n") + "\n";
}

test("random configs: ssh -G reads every name exactly as before", { skip: HAVE_SSH ? false : "ssh not installed" }, () => {
    const names = [...NAMES, "web3", "WEB1", "zz.lab", "x-9", "nobody"];
    let simplified = 0;
    for (let seed = 1; seed <= 40; seed++) {
        const text = randomConfig(seed);
        const before = sshG(text, names);
        for (const wildcards of [false, true]) {
            const r = tidyConfig(text, { wildcards });
            assert.deepEqual(r.failed, [], `seed ${seed}: self-check failed\n${text}`);
            if (r.text === text) continue;
            simplified++;
            const widened = (h: string) => r.widened.some((w) => !w.hosts.includes(h) && new RegExp("^" + w.pattern.replace(/[.]/g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$").test(h));
            const after = sshG(r.text, names);
            for (const h of names) {
                if (widened(h)) continue;
                assert.equal(after.get(h), before.get(h), `seed ${seed} (wildcards ${wildcards}): ssh -G ${h} differs\n--- before\n${text}\n--- after\n${r.text}`);
            }
        }
    }
    assert.ok(simplified > 12, `only ${simplified} configs were simplified`);
});

test("random configs: the model agrees with ssh -G on User, Port, HostName and IdentityFile", { skip: HAVE_SSH ? false : "ssh not installed" }, () => {
    const names = ["a", "web1", "web2", "db.lab", "x-1", "WEB1"];
    for (let seed = 100; seed <= 130; seed++) {
        const text = randomConfig(seed);
        if (text.includes("Match")) continue;
        const real = sshG(text, names);
        const cfg = parseConfig(text);
        for (const h of names) {
            const eff = resolve(cfg.blocks, h);
            const out = real.get(h)!;
            const get = (k: string) => out.split("\n").filter((l) => l.startsWith(k + " ")).map((l) => l.slice(k.length + 1));
            if (eff.first.has("user")) assert.deepEqual(get("user"), [eff.first.get("user")!.text], `seed ${seed} ${h} user`);
            if (eff.first.has("port")) assert.deepEqual(get("port"), [eff.first.get("port")!.text], `seed ${seed} ${h} port`);
            if (eff.first.has("hostname")) assert.deepEqual(get("hostname"), [eff.first.get("hostname")!.text.toLowerCase()], `seed ${seed} ${h} hostname`);
            if (eff.lists.has("identityfile")) assert.deepEqual(get("identityfile"), [...new Set(eff.lists.get("identityfile")!.map((s) => s.text))], `seed ${seed} ${h} identityfile`);
        }
    }
});

// ── The CLI's shared cases ───────────────────────────────────────────────────

// `telepy config tidy`（Rust，src/cli/src/tidy.rs）必須跟這裡逐字一樣：這些案例寫在 src/cli/tests/tidy_cases.json，
// 兩邊的測試都比對。規則改了就用 `UPDATE_TIDY_CASES=1 npm test` 重寫檔案，再讓 Rust 那邊跟上。
// `telepy config tidy` (Rust) must match this byte for byte: these cases live in src/cli/tests/tidy_cases.json and
// both test suites check them. After a rule change, rewrite the file with `UPDATE_TIDY_CASES=1 npm test`.
import { readFileSync as readCases } from "node:fs";
import { TIDY_EXAMPLE } from "./sshConfigTidy.ts";

function sharedCases() {
    const fixed: [string, string][] = [
        ["sample", SAMPLE],
        ["example", TIDY_EXAMPLE],
        ["telepy-fleet", markedBlocks([serverStanza, device("pi", "pi", 1), device("nas-root", "root", 2, "yes", "nas"), device("nas-admin", "admin", 2, "yes", "nas"), device("cam", "root", 3, "accept-new"), device("router", "root", 4)])],
        ["two-servers", markedBlocks([device("pi", "root", 1), device("cam", "root", 2), device("nas", "root", 3)]) + markedBlocks([device("a", "root", 1, "yes", "a", "telepy-other.example-22"), device("b", "root", 2, "yes", "b", "telepy-other.example-22")]) + "Host mine\n    Port 22\n"],
        ["crlf", "Host a\r\n  User x\r\n  Port 2200\r\n\r\nHost b\r\n  User x\r\n  Port 2200\r\n"],
        ["walls", "Host a\n  User x\n  Port 2200\nMatch exec \"true\"\n  User z\nHost b\n  User x\n  Port 2200\nHost c\n  Include other.conf\n"],
        ["notes", "Host a\n  Usr x\n  Protocol 2\n  User one\n  User two\n  Hostname a.example\n  Bad \"quote\n"],
        ["quotes", 'Host a\n  User=bob\n  IdentityFile "~/My Keys/id"\nHost b\n  User = bob\n  IdentityFile "~/My Keys/id"\n'],
        ["stacks", "Host a\n  IdentityFile k0\n  IdentityFile k1\nHost b\n  IdentityFile k1\nHost *\n  IdentityFile k9\n"],
        ["long", Array.from({ length: 120 }, (_, i) => `Host device-number-${i}.lab.example\n    User admin\n    Port 2222\n`).join("")],
        ["wild", "Host web-1\n  HostName 10.0.0.1\nHost web-2\n  HostName 10.0.0.2\nHost web-1 web-2\n  User deploy\n  Port 2200\n"],
    ];
    const inputs: [string, string][] = [...fixed, ...Array.from({ length: 40 }, (_, i) => [`random-${i + 1}`, randomConfig(i + 1)] as [string, string])];
    return inputs.flatMap(([name, input]) =>
        [false, true].map((wildcards) => {
            const r = tidyConfig(input, { wildcards });
            return { name, wildcards, input, output: r.text, notes: r.notes.map((n) => [n.kind, n.n]), changes: r.changes.map((c) => c.kind), failed: r.failed };
        }),
    );
}

test("the CLI's shared cases are up to date (src/cli/tests/tidy_cases.json)", () => {
    const file = new URL("../../../cli/tests/tidy_cases.json", import.meta.url);
    const cases = sharedCases();
    const json = JSON.stringify(cases, null, 1) + "\n";
    if (process.env.UPDATE_TIDY_CASES) writeFileSync(file, json);
    assert.equal(readCases(file, "utf8"), json, "run UPDATE_TIDY_CASES=1 npm test, then make the Rust side match");
    assert.ok(cases.every((c) => c.failed.length === 0));
});
