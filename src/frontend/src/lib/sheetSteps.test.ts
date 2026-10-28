import { test } from "node:test";
import assert from "node:assert/strict";
import { fillSummary, sheetOpenStep, sheetStates, type SheetProgress } from "./sheetSteps.ts";

const base: SheetProgress = { setupDone: 4, setupTotal: 4, setupLoading: false, picked: false, filled: false, invalid: false, copied: false };

test("setup decides the device step: loading, unfinished, done", () => {
    assert.equal(sheetStates({ ...base, setupLoading: true, setupDone: 0 }).device, "todo");
    assert.equal(sheetStates({ ...base, setupDone: 2 }).device, "attention");
    assert.equal(sheetStates(base).device, "done");
});

test("task, fill and run are ticked as they are done", () => {
    assert.deepEqual(sheetStates(base), { device: "done", task: "todo", fill: "todo", run: "todo" });
    // 看過填空但還沒選任務：不算填好。/ Seeing fill-in without a task does not count.
    assert.equal(sheetStates({ ...base, filled: true }).fill, "todo");
    assert.deepEqual(sheetStates({ ...base, picked: true, filled: true, copied: true }), { device: "done", task: "done", fill: "done", run: "done" });
});

test("an invalid value puts fill-in on attention", () => {
    assert.equal(sheetStates({ ...base, picked: true, filled: true, invalid: true }).fill, "attention");
    assert.equal(sheetStates({ ...base, invalid: true }).fill, "attention");
});

test("the page opens on fill-in for deep links, else device until set up, else task", () => {
    assert.equal(sheetOpenStep({ deepLinked: true, setupComplete: false }), "fill");
    assert.equal(sheetOpenStep({ deepLinked: false, setupComplete: false }), "device");
    assert.equal(sheetOpenStep({ deepLinked: false, setupComplete: true }), "task");
});

test("fill summaries say from where to where", () => {
    assert.equal(fillSummary("local", { remotePort: "80", localPort: "8080" }), "80 → localhost:8080");
    assert.equal(fillSummary("lan", { lanHost: "192.168.1.1", lanPort: "443", localPort: "8443" }), "192.168.1.1:443 → localhost:8443");
    assert.equal(fillSummary("socks", { localPort: "1080" }), "SOCKS5 localhost:1080");
    assert.equal(fillSummary("remote", { localPort: "3000", devicePort: "9000" }), "localhost:3000 → 9000");
    assert.equal(fillSummary("jump", { lanUser: "pi", lanHost: "10.0.0.5", lanPort: "22" }), "pi@10.0.0.5");
    assert.equal(fillSummary("jump", { lanUser: "pi", lanHost: "10.0.0.5", lanPort: "2222" }), "pi@10.0.0.5:2222");
    assert.equal(fillSummary("copy", { direction: "upload", tool: "scp", localPath: "./a", remotePath: "~/" }), "./a → ~/");
    assert.equal(fillSummary("copy", { direction: "download", tool: "scp", localPath: "./a", remotePath: "~/b" }), "~/b → ./a");
    assert.equal(fillSummary("rustdesk", { lanHost: "localhost", remotePort: "21118", localPort: "21118" }), "localhost:21118 → 127.0.0.1:21118");
});
