import { test } from "node:test";
import assert from "node:assert/strict";
import { doneCount, firstOpenStep, nextStep, prevStep, type StepLike } from "./stepTabs.ts";
import { allDone, markKeys } from "./configDone.ts";

const steps: StepLike<"add" | "access" | "connect">[] = [
    { value: "add", state: "done" },
    { value: "access", state: "working" },
    { value: "connect", state: "todo" },
];

test("step navigation", () => {
    assert.equal(firstOpenStep(steps), "access");
    assert.equal(firstOpenStep(steps.map((s) => ({ ...s, state: "done" as const }))), "connect", "all done → the last step");
    assert.equal(firstOpenStep([]), null);
    assert.equal(nextStep(steps, "add"), "access");
    assert.equal(nextStep(steps, "connect"), null);
    assert.equal(prevStep(steps, "add"), null);
    assert.equal(prevStep(steps, "connect"), "access");
    assert.equal(doneCount(steps), 1);
});

test("config-done marks", () => {
    const a = markKeys({}, ["1:root", "1:pi"], true);
    assert.deepEqual(a, { "1:root": true, "1:pi": true });
    assert.ok(allDone(a, ["1:root"]) && allDone(a, ["1:root", "1:pi"]));
    assert.ok(!allDone(a, ["1:root", "2:root"]));
    assert.ok(!allDone(a, []), "nothing to add is not done");
    assert.deepEqual(markKeys(a, ["1:pi"], false), { "1:root": true });
});
