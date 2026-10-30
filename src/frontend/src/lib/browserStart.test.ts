// node --test（Node 23 會直接拿掉型別）。/ Run with `npm test` (Node strips the types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BROWSER_STEPS, afterStart, browserLine, browserSteps, type BrowserStepEvent } from "./browserStart.ts";

const states = (v: { state: string }[]) => v.map((s) => s.state);
const ev = (step: BrowserStepEvent["step"], state: BrowserStepEvent["state"], extra: Partial<BrowserStepEvent> = {}): BrowserStepEvent => ({ step, state, ...extra });

test("the backend reports the first two steps under these names", () => {
    const rust = readFileSync(new URL("../../../backend-api/src/remote_browser/mod.rs", import.meta.url), "utf8");
    for (const id of BROWSER_STEPS.slice(0, 2)) assert.ok(rust.includes(`on("${id}", "active"`), id);
});

test("live steps while starting", () => {
    assert.deepEqual(states(browserSteps([], "idle")), ["waiting", "waiting", "waiting"]);
    // 還沒收到任何事件：第一步算進行中。/ Nothing received yet: the first step is in progress.
    assert.deepEqual(states(browserSteps([], "running")), ["active", "waiting", "waiting"]);
    assert.deepEqual(states(browserSteps([ev("proxy", "done"), ev("browser", "active", { secs: 30 })], "running")), ["done", "active", "waiting"]);
});

test("after the start answers, the stream step runs (missing reports count as done)", () => {
    const filled = afterStart([ev("proxy", "active")], 5);
    assert.deepEqual(states(browserSteps(filled, "running")), ["done", "done", "active"]);
    assert.deepEqual(states(browserSteps([...filled, ev("stream", "done")], "done")), ["done", "done", "done"]);
    assert.deepEqual(states(browserSteps([...filled, ev("stream", "failed")], "failed")), ["done", "done", "failed"]);
});

test("each step's line", () => {
    const [proxy] = browserSteps([ev("proxy", "active", { attempt: 2, attempts: 3 })], "running");
    assert.deepEqual(browserLine(proxy), { key: "browser.step.proxyRetry", vars: { n: 2, total: 3 } });
    assert.equal(browserLine(browserSteps([ev("proxy", "failed", { reason: "offline" })], "failed")[0]).key, "browser.step.proxyOffline");
    assert.deepEqual(browserLine(browserSteps([ev("proxy", "failed", { reason: "timeout", attempts: 2 })], "failed")[0]), { key: "browser.step.proxyTimeout", vars: { count: 2 } });
    // 請求失敗、沒有事件：失敗標在第一步。/ A failed request with no events marks the first step.
    assert.equal(browserLine(browserSteps([], "failed")[0]).key, "browser.step.stoppedHere");
    const after = browserSteps([ev("proxy", "done"), ev("browser", "failed")], "failed");
    assert.deepEqual(after.map((v) => browserLine(v).key), ["browser.step.proxyDone", "browser.step.browserFailed", "browser.step.streamPlan"]);
});
