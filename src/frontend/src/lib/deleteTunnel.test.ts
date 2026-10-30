// node --test（Node 23 會直接拿掉型別）。/ Run with `npm test` (Node strips the types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DELETE_STEPS, deletePlan, deleteSteps, deleteVerdict, flowStates, stepLine, type DeleteStepEvent } from "./deleteTunnel.ts";
import { activeNumber, countdown, stepViews } from "./progressSteps.ts";

const states = (v: { state: string }[]) => v.map((s) => s.state);
const ev = (step: DeleteStepEvent["step"], state: DeleteStepEvent["state"], extra: Partial<DeleteStepEvent> = {}): DeleteStepEvent => ({ step, state, ...extra });

test("the step order matches the backend's DeleteSteps", () => {
    const rust = readFileSync(new URL("../../../backend-api/src/api/tunnels.rs", import.meta.url), "utf8");
    const doc = rust.slice(rust.indexOf("struct DeleteSteps") - 1200, rust.indexOf("struct DeleteSteps"));
    assert.match(doc, new RegExp(DELETE_STEPS.join(" → ")));
    // 每一步的名字都在 destroy 裡送出。/ Every step id is sent by destroy.
    for (const id of DELETE_STEPS) assert.ok(rust.includes(`"${id}"`), id);
});

test("the plan skips the device steps when offline or not chosen", () => {
    assert.deepEqual(deletePlan(true, true).map((p) => p.run), [true, true, true, true, true, true]);
    assert.deepEqual(deletePlan(true, false).map((p) => [p.run, p.reason]), [[false, "off"], [true, undefined], [false, "off"], [false, "off"], [true, undefined], [true, undefined]]);
    assert.deepEqual(deletePlan(false, true).map((p) => p.reason), ["offline", "offline", "offline", "offline", undefined, undefined]);
    assert.deepEqual(states(deleteSteps(true, false, [], "idle")), ["skipped", "waiting", "skipped", "skipped", "waiting", "waiting"]);
});

test("live events drive the list; a lost start still shows the next step in progress", () => {
    const events = [ev("service", "active"), ev("service", "done", { found: 3 }), ev("keys", "active")];
    assert.deepEqual(states(deleteSteps(true, true, events, "running")), ["done", "active", "waiting", "waiting", "waiting", "waiting"]);
    assert.equal(activeNumber(deleteSteps(true, true, events, "running")), 2);
    // keys 的結束到了、stop 的開始掉了：stop 仍算進行中。/ keys ended, stop's start was lost: stop is still in progress.
    const lost = [...events, ev("keys", "done", { removed: 1 })];
    assert.deepEqual(states(deleteSteps(true, true, lost, "running")), ["done", "done", "active", "waiting", "waiting", "waiting"]);
    // 晚到的開始不會蓋掉結束。/ A late start never replaces an end.
    assert.equal(stepViews(DELETE_STEPS, deletePlan(true, true), [ev("service", "done"), ev("service", "active")], "running")[0].state, "done");
});

test("a failed request marks the step in progress, a finished report fills the rest", () => {
    const events = [ev("service", "skipped", { reason: "off" }), ev("keys", "done"), ev("stop", "skipped"), ev("watch", "skipped"), ev("telepy", "active")];
    assert.deepEqual(states(deleteSteps(true, false, events, "failed")), ["skipped", "done", "skipped", "skipped", "failed", "waiting"]);
    // 一步自己報了失敗，請求也失敗：只標那一步。/ A step reported its failure and the request failed: only that step.
    assert.deepEqual(states(deleteSteps(true, true, [ev("service", "failed")], "failed")), ["failed", "waiting", "waiting", "waiting", "waiting", "waiting"]);
    // 舊後端沒回報 steps：計畫要做的算做完。/ An older backend without steps: planned ones count as done.
    assert.deepEqual(states(deleteSteps(false, false, [], "done")), ["skipped", "skipped", "skipped", "skipped", "done", "done"]);
});

test("each step's line: plan before, reason when skipped, result after", () => {
    const ctx = { keys: 2, lanHosts: 0 };
    const [service, keys, stop, watch, telepy] = deleteSteps(false, true, [], "idle");
    assert.equal(stepLine(service, ctx).key, "deleteTunnel.line.serviceOffline");
    assert.deepEqual(stepLine(keys, ctx), { key: "deleteTunnel.line.keysOffline", vars: { count: 2 } });
    assert.equal(stepLine(stop, ctx).key, "deleteTunnel.line.stopOffline");
    assert.equal(stepLine(watch, ctx).key, "deleteTunnel.line.watchOffline");
    assert.equal(stepLine(telepy, { keys: 0, lanHosts: 3 }).key, "deleteTunnel.plan.telepyLan");
    const done = deleteSteps(true, true, [ev("service", "warn", { found: 0 }), ev("keys", "done", { removed: 2, service_key: true }), ev("stop", "warn", { reason: "not_found" }), ev("watch", "skipped", { reason: "not_stopped" }), ev("telepy", "done", { revoked: 1 }), ev("disconnect", "done", { was_connected: true })], "done");
    assert.deepEqual(done.map((v) => stepLine(v, ctx).key), [
        "deleteTunnel.line.serviceNone",
        "deleteTunnel.line.keysDoneShared",
        "deleteTunnel.line.stopNothing",
        "deleteTunnel.line.watchNotStopped",
        "deleteTunnel.line.telepyMore",
        "deleteTunnel.line.disconnectDone",
    ]);
    // 請求失敗、這一步沒回報結果：還是說它要做什麼。/ The request failed with no result for the step: its plan.
    assert.equal(stepLine(deleteSteps(true, true, [ev("service", "active")], "failed")[0], ctx).key, "deleteTunnel.plan.service");
});

test("the verdict follows the worst step", () => {
    const all = (extra: DeleteStepEvent[]) => deleteSteps(true, true, extra, "done");
    assert.equal(deleteVerdict(all([])).key, "deleteTunnel.verdict.clean");
    assert.equal(deleteVerdict(all([ev("watch", "failed", { reason: "came_back" })])).tone, "danger");
    assert.equal(deleteVerdict(all([ev("keys", "warn")])).key, "deleteTunnel.verdict.keysLeft");
    assert.equal(deleteVerdict(all([ev("stop", "warn", { reason: "still_connected" })])).key, "deleteTunnel.verdict.serviceLeft");
    assert.equal(deleteVerdict(deleteSteps(true, false, [], "done")).key, "deleteTunnel.verdict.serviceKept");
    assert.equal(deleteVerdict(deleteSteps(false, true, [], "done")).key, "deleteTunnel.verdict.offline");
});

test("the diagram merges the three service steps", () => {
    assert.equal(flowStates(deleteSteps(true, false, [], "idle")).service, "skipped");
    assert.equal(flowStates(deleteSteps(true, true, [], "idle")).service, "waiting");
    // 找完、還沒停：服務那一格還在進行中。/ Found, not stopped yet: the service is still in progress.
    assert.equal(flowStates(deleteSteps(true, true, [ev("service", "done"), ev("keys", "active")], "running")).service, "active");
    assert.equal(flowStates(deleteSteps(true, true, [ev("watch", "failed")], "done")).service, "failed");
    assert.equal(flowStates(deleteSteps(true, true, [ev("stop", "warn")], "done")).service, "warn");
    assert.deepEqual(flowStates(deleteSteps(true, true, [], "done")), { service: "done", keys: "done", telepy: "done", link: "done" });
});

test("countdown of a waiting step", () => {
    assert.equal(countdown(undefined, 0), null);
    assert.equal(countdown({ secs: 25 }, 0), null);
    assert.deepEqual(countdown({ secs: 25, at: 1000 }, 11_500), { elapsed: 10, left: 15, progress: 0.42 });
    assert.deepEqual(countdown({ secs: 10, at: 0 }, 60_000), { elapsed: 60, left: 0, progress: 1 });
});
