import { test } from "node:test";
import assert from "node:assert/strict";
import { RECIPES, RECIPE_BY_ID, TELEPY_EXAMPLE, buildSegments, segmentsToString, shellSegments, type ConnectTarget, type ForwardOptions } from "./forwardRecipes.ts";
import { CLI_EXAMPLES } from "./cliExamples.gen.ts";
import { fillExample } from "./cliGuide.ts";

const OFF: ForwardOptions = { background: false, keepAlive: false, exitOnFailure: false };
const target = (mode: ConnectTarget["mode"]): ConnectTarget => ({ tunnel: "box", alias: "box", username: "pi", serverHost: "telepy.example.com", serverPort: "2222", reversePort: 32001, mode });
const cmd = (id: (typeof RECIPES)[number]["id"], mode: ConnectTarget["mode"], params?: Record<string, string>) =>
    segmentsToString(buildSegments(id, params ?? RECIPE_BY_ID[id].defaults, target(mode), OFF));

test("the telepy way is the CLI's own examples (src/cli/src/examples.rs), not a third copy", () => {
    const context = { base: "", tunnel: "box", account: "pi", other: null, label: null, group: null, snippet: null };
    for (const [recipe, exampleId] of Object.entries(TELEPY_EXAMPLE)) {
        const ex = CLI_EXAMPLES.find((e) => e.id === exampleId);
        assert.ok(ex, `example ${exampleId}`);
        assert.equal(cmd(recipe as keyof typeof RECIPE_BY_ID, "telepy"), fillExample(ex.lines, context)[0], `${recipe} = ${exampleId}`);
    }
    // 每個任務都對到一個 CLI 範例（那邊的 clap 測試保證它跑得動）。/ Every task maps to a CLI example (whose clap test proves it parses).
    for (const r of RECIPES) assert.ok(TELEPY_EXAMPLE[r.id], `${r.id} has a CLI example`);
});

test("the telepy way for the rest: a LAN shell through the device, scp, a shell", () => {
    assert.equal(cmd("jump", "telepy"), "telepy ssh box@pi --ssh-opt -t -- ssh ubuntu@192.168.1.20");
    assert.equal(cmd("jump", "telepy", { lanUser: "root", lanHost: "10.0.0.5", lanPort: "2200" }), "telepy ssh box@pi --ssh-opt -t -- ssh -p 2200 root@10.0.0.5");
    assert.equal(cmd("copy", "telepy"), "telepy scp -r ./project box@pi:~/");
    assert.equal(cmd("copy", "telepy", { direction: "download", tool: "rsync", localPath: "./logs", remotePath: "/var/log/my app" }), "telepy scp -r box@pi:'/var/log/my app' ./logs", "no rsync through telepy");
    assert.equal(segmentsToString(shellSegments(target("telepy"))), "telepy ssh box@pi");
    assert.equal(segmentsToString(shellSegments(target("telepy"), "uptime")), "telepy ssh box@pi -- uptime");
    // 名字要引號就整個 <通道>@<帳號> 一起包。/ A name that needs quoting quotes the whole target.
    const odd = { ...target("telepy"), tunnel: "my box" };
    assert.equal(segmentsToString(buildSegments("socks", RECIPE_BY_ID.socks.defaults, odd, OFF)), "telepy ssh 'my box@pi' -N -D 1080");
});

test("OpenSSH ways are unchanged", () => {
    assert.equal(cmd("local", "alias"), "ssh -N -L 8080:localhost:80 box");
    assert.equal(cmd("local", "direct"), "ssh -N -L 8080:localhost:80 -J telepy@telepy.example.com:2222 -p 32001 pi@localhost");
    assert.equal(cmd("copy", "alias", { direction: "upload", tool: "rsync", localPath: "./a", remotePath: "~/" }), "rsync -avz --progress ./a box:~/");
});

test("every segment explains itself with a short label", () => {
    for (const mode of ["telepy", "alias", "direct"] as const) {
        for (const r of RECIPES) {
            for (const seg of buildSegments(r.id, r.defaults, target(mode), OFF)) assert.ok(seg.explain, `${mode} ${r.id}: ${seg.tokens.map((t) => t.text).join(" ")}`);
        }
    }
});
