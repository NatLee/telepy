import { test } from "node:test";
import assert from "node:assert/strict";
import { en } from "../locales/en.ts";
import { RECIPES } from "./forwardRecipes.ts";
import { CLI_EXAMPLE_TOPICS } from "./cliExamples.gen.ts";
import { CLI_COMMANDS } from "./cliGuide.ts";
import { FAMILIES, TASK_FAMILY, TOPIC_FAMILY, capLabel, containment, family, sameNeeds, shared } from "./toolOverlap.ts";

const has = (k: string) => typeof (en as Record<string, string>)[k] === "string";
const names = (list: { id: string }[]) => list.map((t) => t.id);
const of = (f: "reach" | "files" | "run", id: string) => containment(family(f)).find((c) => c.tool.id === id)!;

test("the table is well formed: every ability is listed, worded and used, every tool is a real command", () => {
    const commands = new Set(CLI_COMMANDS.map((c) => c.key));
    for (const f of FAMILIES) {
        assert.ok(has(`sheet.overlap.${f.id}.title`) && has(`sheet.overlap.${f.id}.hint`), f.id);
        assert.equal(new Set(f.caps).size, f.caps.length);
        for (const c of f.caps) {
            assert.ok(has(capLabel(f.id, c)), `${f.id}.${c} has no wording`);
            assert.ok(f.tools.some((t) => c in t.can), `${f.id}.${c}: no tool does it`);
        }
        for (const t of f.tools) {
            for (const c of Object.keys(t.can)) assert.ok(f.caps.includes(c), `${t.name}: ${c} is not listed`);
            assert.ok(t.needs.length > 0, t.name);
            assert.ok(commands.has(t.name.replace("telepy ", "")), `${t.name} is not a telepy command`);
        }
    }
});

test("ports and networks: forward and proxy are inside ssh, vpn stands apart", () => {
    assert.deepEqual(names(of("reach", "ssh").covers), ["forward", "proxy"]);
    assert.deepEqual(of("reach", "ssh").adds, ["reverse"]);
    assert.deepEqual(of("reach", "ssh").only, ["reverse"]);
    assert.deepEqual(of("reach", "forward").covers, []);
    assert.deepEqual(of("reach", "vpn").covers, []);
    assert.deepEqual(of("reach", "vpn").only, ["realAddress", "allTraffic", "pingUdp"]);
    assert.deepEqual(of("reach", "proxy").only, []);
    assert.deepEqual(shared(family("reach")), ["lanPort"]);
});

test("files: scp is inside rsync and sftp; cp is the one without a key", () => {
    assert.deepEqual(names(of("files", "rsync").covers), ["scp"]);
    assert.deepEqual(names(of("files", "sftp").covers), ["scp"]);
    assert.deepEqual(of("files", "rsync").adds, ["onlyChanges"]);
    assert.deepEqual(of("files", "cp").only, ["noKey", "behindDevice"]);
    assert.deepEqual(shared(family("files")), ["copyFile"]);
});

test("running commands: nothing is inside anything, each has its own thing", () => {
    for (const c of containment(family("run"))) {
        assert.deepEqual(c.covers, [], c.tool.name);
        assert.deepEqual(c.same, [], c.tool.name);
        assert.equal(c.only.length, 1, c.tool.name);
    }
    assert.deepEqual(shared(family("run")), ["oneCommand"]);
});

test("the tasks and topics that link here exist", () => {
    for (const id of Object.keys(TASK_FAMILY)) assert.ok(RECIPES.some((r) => r.id === id), id);
    for (const id of Object.keys(TOPIC_FAMILY)) assert.ok(CLI_EXAMPLE_TOPICS.some((t) => t.id === id), id);
});

test("a tool that another one covers says why it exists: it needs less, or it has a note", () => {
    for (const f of FAMILIES) {
        const items = containment(f);
        for (const item of items) {
            const by = items.filter((o) => o.covers.includes(item.tool)).map((o) => o.tool);
            if (by.length === 0) continue;
            if (by.some((b) => sameNeeds(b, item.tool))) assert.ok(item.tool.note && has(item.tool.note), `${item.tool.name} needs a note`);
        }
    }
    assert.equal(sameNeeds(family("reach").tools[1], family("reach").tools[2]), false, "proxy needs a sign-in, ssh a key");
});
