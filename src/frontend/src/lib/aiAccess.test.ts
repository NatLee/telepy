import { test } from "node:test";
import assert from "node:assert/strict";
import { describeDetail, reachFor, SCOPES, TOOL_LABELS } from "./aiAccess.ts";

const t = (k: string, v?: Record<string, string | number>) => `${k}${v ? JSON.stringify(v) : ""}`;

test("reach follows the granted scopes", () => {
    const read = reachFor(["tunnels:read"]);
    assert.equal(read.branches.tunnels, true);
    assert.equal(read.device, false, "reading tunnel status never logs in to a device");
    const exec = reachFor(["ssh:exec"]);
    assert.deepEqual([exec.branches.exec, exec.branches.shell, exec.branches.files, exec.device, exec.web], [true, true, false, true, false]);
    const browser = reachFor(["browser:use"]);
    assert.deepEqual([browser.device, browser.beyond, browser.web], [true, true, true]);
    assert.equal(reachFor(["network:scan"]).beyond, true);
    assert.equal(reachFor(["network:scan"]).web, false);
    assert.equal(reachFor([]).device, false);
    assert.ok(Object.values(reachFor(null).branches).every(Boolean), "no app picked = everything possible");
});

test("every tool of every scope has a label", () => {
    for (const s of SCOPES) for (const tool of s.tools) assert.ok(TOOL_LABELS[tool], tool);
    assert.ok(SCOPES.some((s) => s.scope === "browser:use"));
});

test("browser close details are translated", () => {
    assert.equal(describeDetail("browser_close", "reason: idle; actions: 4", t), 'activity.browserCloseDetail{"reason":"activity.reason.idle","count":4}');
    assert.equal(describeDetail("browser_close", "reason: closed_by_user; by: alice; actions: 2", t), 'activity.browserCloseDetail{"reason":"activity.endedBy{\\"user\\":\\"alice\\"}","count":2}');
    assert.equal(describeDetail("shell_close", "shell sh_1: reason: idle", t), "shell sh_1: reason: idle");
});
