import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_LABELS, parseLabels, sameLabels } from "./tunnelLabels.ts";

test("labels are split, lower-cased, de-duplicated and sorted", () => {
    assert.deepEqual(parseLabels(" Prod, home  prod,env=lab ").labels, ["env=lab", "home", "prod"]);
    assert.deepEqual(parseLabels("").labels, []);
});

test("bad labels and too many are reported", () => {
    const r = parseLabels("ok -bad a/b");
    assert.deepEqual(r.labels, ["ok"]);
    assert.deepEqual(r.invalid, ["-bad", "a/b"]);
    assert.ok(parseLabels(Array.from({ length: MAX_LABELS + 1 }, (_, i) => `l${i}`).join(",")).tooMany);
    assert.ok(sameLabels(["a", "b"], ["a", "b"]) && !sameLabels(["a"], ["a", "b"]));
});
