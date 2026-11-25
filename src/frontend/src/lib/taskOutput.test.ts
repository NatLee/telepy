import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { en } from "../locales/en.ts";
import { RECIPES, buildSegments, resolveParams, type ConnectMode, type ConnectTarget, type RecipeId } from "./forwardRecipes.ts";
import { FORWARDING_LINE, fieldSegments, forwardShown, segmentFields, taskOutput } from "./taskOutput.ts";

const target = (mode: ConnectMode): ConnectTarget => ({ tunnel: "web-01", alias: "web-01", username: "deploy", serverHost: "telepy.example.com", serverPort: "24242", reversePort: 32101, mode });
const opts = { background: false, keepAlive: false, exitOnFailure: false };
const out = (id: RecipeId, mode: ConnectMode, params = {}, o = opts) => taskOutput(id, resolveParams(id, params), "web-01", mode, o);

test("the Forwarding line is the CLI's own format string", () => {
    const rs = readFileSync(new URL("../../../cli/src/lib.rs", import.meta.url), "utf8");
    assert.ok(rs.includes(`eprintln!("${FORWARDING_LINE}", name_of(&t));`), "src/cli/src/lib.rs prints something else now");
    assert.ok(rs.includes('println!("{shown}");'));
});

test("telepy forward prints a URL for a web port and localhost:<port> otherwise", () => {
    assert.equal(forwardShown("80", "8080"), "http://localhost:8080/");
    assert.equal(forwardShown("443", "8443"), "https://localhost:8443/");
    assert.equal(forwardShown("5432", "15432"), "localhost:15432");
    assert.deepEqual(out("local", "telepy").lines, ["http://localhost:8080/", "Forwarding http://localhost:8080/ → localhost:80 behind web-01. Press Ctrl+C to stop."]);
    assert.deepEqual(out("lan", "telepy").lines[1], "Forwarding https://localhost:8443/ → 192.168.1.1:443 behind web-01. Press Ctrl+C to stop.");
    assert.deepEqual(out("rustdesk", "telepy").lines[0], "localhost:21118");
    assert.deepEqual(out("local", "telepy", { remotePort: "5432", localPort: "15432" }).lines[0], "localhost:15432", "it follows the blanks");
});

test("a command that prints nothing gets no invented output, only a note", () => {
    for (const id of ["local", "lan", "socks", "remote", "rustdesk"] as const) {
        for (const mode of ["alias", "direct"] as const) assert.deepEqual(out(id, mode), { lines: [], note: "sheet.out.silent" }, `${id} ${mode}`);
    }
    assert.deepEqual(out("socks", "telepy"), { lines: [], note: "sheet.out.silent" });
    assert.equal(out("local", "alias", {}, { ...opts, background: true }).note, "sheet.out.background");
    assert.equal(out("local", "telepy", {}, { ...opts, background: true }).note, "sheet.out.holds", "telepy has no -f");
    assert.deepEqual(out("jump", "telepy"), { lines: [], note: "sheet.out.shell", vars: { host: "192.168.1.20" } });
    assert.equal(out("vpn", "telepy").lines.length, 0);
    assert.equal(out("copy", "alias").note, "sheet.out.scp");
    const rsync = out("copy", "telepy", { tool: "rsync" });
    assert.ok(rsync.lines.some((l) => l.startsWith("sent ")) && rsync.note === "sheet.out.rsync", "rsync shows the CLI example's real output");
});

test("every task has a worded note in every way", () => {
    for (const r of RECIPES) for (const mode of ["telepy", "alias", "direct"] as const) assert.equal(typeof (en as Record<string, string>)[out(r.id, mode).note], "string", `${r.id} ${mode}`);
});

test("a part of the command knows its blanks, and a blank knows its parts", () => {
    const def = RECIPES.find((r) => r.id === "lan")!;
    const resolved = resolveParams("lan", {});
    const segs = buildSegments("lan", {}, target("telepy"), opts);
    // telepy forward web-01@deploy 192.168.1.1:443 --local 8443
    assert.deepEqual(segs.map((s) => segmentFields(s, def.fields, resolved)), [[], [], [], ["lanHost", "lanPort"], ["localPort"]]);
    assert.deepEqual(fieldSegments("localPort", segs, def.fields, resolved), [4]);
    assert.deepEqual(fieldSegments("lanHost", segs, def.fields, resolved), [3]);
    // ssh -N -L 8443:192.168.1.1:443 web-01：三格都在同一段。/ All three blanks sit in the one -L part.
    const ssh = buildSegments("lan", {}, target("alias"), opts);
    const at = ssh.findIndex((s) => s.tokens.some((tk) => tk.text.includes("192.168.1.1")));
    assert.deepEqual(segmentFields(ssh[at], def.fields, resolved), ["lanHost", "lanPort", "localPort"]);
    assert.deepEqual(fieldSegments("lanPort", ssh, def.fields, resolved), [at]);
    // 每個任務、每種跑法：每一格至少出現在一段。/ Every blank appears in at least one part, for every task and way.
    for (const r of RECIPES) {
        const res = resolveParams(r.id, {});
        for (const mode of ["telepy", "alias", "direct"] as const) {
            const s = buildSegments(r.id, {}, target(mode), opts);
            // 跳板機的 22 埠是預設值，不寫進指令。/ A jump host's port 22 is the default and isn't written.
            for (const f of r.fields.filter((f) => f.kind !== "choice" && !(r.id === "jump" && f.key === "lanPort"))) assert.ok(fieldSegments(f.key, s, r.fields, res).length > 0, `${r.id} ${mode}: ${f.key} is in no part`);
        }
    }
});
