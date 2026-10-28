import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveHistory, isHistoryMode, overrideBody, overrideChoice } from "./shellHistory.ts";

test("modes", () => {
    assert.equal(isHistoryMode("keep"), true);
    assert.equal(isHistoryMode("skip"), true);
    assert.equal(isHistoryMode("off"), false);
    assert.equal(isHistoryMode(null), false);
});

test("the tunnel's override wins, null follows the default", () => {
    assert.deepEqual(effectiveHistory("keep", null), { mode: "keep", source: "default" });
    assert.deepEqual(effectiveHistory("skip", null), { mode: "skip", source: "default" });
    assert.deepEqual(effectiveHistory("keep", "skip"), { mode: "skip", source: "tunnel" });
    assert.deepEqual(effectiveHistory("skip", "keep"), { mode: "keep", source: "tunnel" });
});

test("override choice ⇄ PUT body", () => {
    assert.equal(overrideChoice(null), "default");
    assert.equal(overrideChoice("skip"), "skip");
    assert.equal(overrideChoice("bogus"), "default");
    assert.deepEqual(overrideBody("default"), { mode: null });
    assert.deepEqual(overrideBody("keep"), { mode: "keep" });
});
