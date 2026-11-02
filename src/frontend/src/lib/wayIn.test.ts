import { test } from "node:test";
import assert from "node:assert/strict";
import { WAY_CHOICES, WAY_ROWS, doneKeys, initialChoice, isReinstall, outcome, outcomeKey } from "./wayIn.ts";
import { en } from "../locales/en.ts";

test("the switch dialog starts on automatic unless the device already is", () => {
    assert.equal(initialChoice("ssh"), "auto");
    assert.equal(initialChoice("websocket"), "auto");
    assert.equal(initialChoice(null), "auto", "unknown way in");
    assert.equal(initialChoice("auto"), null, "already automatic: nothing preselected, the person picks");
    assert.equal(isReinstall("auto", "auto"), true);
    assert.equal(isReinstall("ssh", "auto"), false);
    assert.equal(isReinstall(null, "auto"), false);
    assert.equal(isReinstall("ssh", null), false);
});

test("each way takes the lane its rule says, and falls back only when automatic", () => {
    const none = { ssh: false, web: false };
    const sshBlocked = { ssh: true, web: false };
    const webBlocked = { ssh: false, web: true };
    const both = { ssh: true, web: true };

    assert.deepEqual(outcome("ssh", none), { ssh: "used", web: "unused", via: "ssh" });
    assert.deepEqual(outcome("ssh", sshBlocked), { ssh: "blocked", web: "unused", via: null });
    assert.deepEqual(outcome("ssh", webBlocked), { ssh: "used", web: "unused", via: "ssh" }, "the web port does not matter");

    assert.deepEqual(outcome("websocket", none), { ssh: "unused", web: "used", via: "web" });
    assert.deepEqual(outcome("websocket", sshBlocked), { ssh: "unused", web: "used", via: "web" }, "the SSH port does not matter");
    assert.deepEqual(outcome("websocket", webBlocked), { ssh: "unused", web: "blocked", via: null });

    assert.deepEqual(outcome("auto", none), { ssh: "used", web: "standby", via: "ssh" });
    assert.deepEqual(outcome("auto", webBlocked), { ssh: "used", web: "standby", via: "ssh" });
    assert.deepEqual(outcome("auto", sshBlocked), { ssh: "blocked", web: "used", via: "web" });
    assert.deepEqual(outcome("auto", both), { ssh: "blocked", web: "blocked", via: null });
    assert.deepEqual(outcome("auto"), outcome("auto", none), "nothing blocked by default");
});

test("the sentence under the diagram follows the outcome", () => {
    assert.equal(outcomeKey("ssh"), "wayIn.out.sshOk");
    assert.equal(outcomeKey("ssh", { ssh: true, web: false }), "wayIn.out.sshBlocked");
    assert.equal(outcomeKey("websocket", { ssh: true, web: false }), "wayIn.out.webOk");
    assert.equal(outcomeKey("websocket", { ssh: false, web: true }), "wayIn.out.webBlocked");
    assert.equal(outcomeKey("auto"), "wayIn.out.autoOk");
    assert.equal(outcomeKey("auto", { ssh: true, web: false }), "wayIn.out.autoFallback");
    assert.equal(outcomeKey("auto", { ssh: true, web: true }), "wayIn.out.autoBoth");
});

test("the comparison table has a cell for every way, recommended first", () => {
    assert.deepEqual([...WAY_CHOICES], ["auto", "ssh", "websocket"]);
    for (const row of WAY_ROWS) {
        assert.ok(row.label in en, row.label);
        for (const w of WAY_CHOICES) assert.ok(row.cells[w].text in en, `${row.label} ${w}`);
    }
    // 被擋時：只有「只走 SSH port」會離線。/ When the SSH port is blocked only the SSH-port-only way goes offline.
    const blocked = WAY_ROWS.find((r) => r.label === "wayIn.row.blocked")!;
    assert.deepEqual(WAY_CHOICES.map((w) => blocked.cells[w].tone), ["good", "bad", "good"]);
});

test("the result after a switch names the way it ended up on", () => {
    assert.equal(doneKeys("auto", false).title, "deviceInstall.switch.done");
    assert.equal(doneKeys("auto", true).title, "deviceInstall.switch.doneNoCarrier", "automatic without a helper = the SSH port only");
    assert.equal(doneKeys("auto", true).toast, "deviceInstall.switch.doneToastSsh");
    assert.equal(doneKeys("ssh", false).title, "deviceInstall.switch.doneSsh");
    assert.equal(doneKeys("websocket", false).title, "deviceInstall.switch.doneWeb");
    assert.equal(doneKeys(undefined, false).title, "deviceInstall.switch.done", "an older backend without transport");
});
