import { test } from "node:test";
import assert from "node:assert/strict";
import { closeFailure, terminalPhase, terminalSpotStates, terminalStep } from "./terminalFlow.ts";

test("close codes map to the hop where the terminal stopped", () => {
    assert.equal(closeFailure(1000, false), null);
    assert.equal(closeFailure(1005, true), null);
    assert.equal(closeFailure(4001, false)?.at, "web");
    assert.equal(closeFailure(4005, false)?.at, "tunnel");
    assert.equal(closeFailure(4006, false)?.at, "device");
    // 4003 / 4004 差在裝置帳號還是區網主機。/ 4003 / 4004 mean the device account or the LAN host.
    assert.equal(closeFailure(4003, false)?.at, "device");
    assert.equal(closeFailure(4003, true)?.at, "target");
    assert.equal(closeFailure(4004, false)?.at, "telepy");
    assert.equal(closeFailure(4004, true)?.at, "reach");
    assert.equal(closeFailure(4008, true)?.key, "stepUp.deniedCard");
    assert.deepEqual(closeFailure(4321, false), { key: "terminal.flow.err.generic", vars: { code: 4321 }, at: "telepy" });
});

test("a tab's status becomes a phase; a normal end is not a failure", () => {
    assert.deepEqual(terminalPhase(null, null, false), { phase: "idle", failure: null });
    assert.equal(terminalPhase("connecting", null, false).phase, "connecting");
    assert.equal(terminalPhase("connected", null, false).phase, "connected");
    assert.equal(terminalPhase("closed", 1000, false).phase, "ended");
    const failed = terminalPhase("closed", 4005, false);
    assert.equal(failed.phase, "failed");
    assert.equal(failed.failure?.at, "tunnel");
    // 沒有關閉碼 = 網路斷了。/ No code = the network dropped.
    assert.equal(terminalPhase("closed", undefined, false).failure?.at, "web");
});

test("spot states follow the phase and the failing hop", () => {
    const failed = terminalSpotStates("failed", { key: "terminal.flow.err.offline", at: "tunnel" });
    assert.equal(failed.telepy, "ok");
    assert.equal(failed.tunnel, "failed");
    assert.equal(failed.device, "waiting");
    const ended = terminalSpotStates("ended", null);
    assert.equal(ended.reach, "ok");
    assert.equal(ended.target, "waiting");
    const connecting = terminalSpotStates("connecting", null);
    assert.equal(connecting.browser, "ok");
    assert.equal(connecting.web, "active");
    assert.equal(connecting.target, "active");
    assert.equal(terminalStep("connected", null, true), 4);
    assert.equal(terminalStep("connected", null, false), 3);
    assert.equal(terminalStep("failed", { key: "terminal.flow.err.offline", at: "tunnel" }, false), 2);
});
