import { test } from "node:test";
import assert from "node:assert/strict";
import { localViewModes, parseViewModes, viewModeOf } from "./viewModes.ts";

test("parse keeps well-formed pages and card / list only", () => {
    assert.deepEqual(parseViewModes({ tunnels: "list", key_groups: "card", Bad: "list", other: "grid" }), { tunnels: "list", key_groups: "card" });
    assert.deepEqual(parseViewModes(["tunnels"]), {});
    assert.deepEqual(parseViewModes(null), {});
});

test("a page without a choice uses its default", () => {
    assert.equal(viewModeOf({}, "tunnels"), "card");
    assert.equal(viewModeOf({ tunnels: "list" }, "tunnels"), "list");
    assert.equal(viewModeOf({ tunnels: "list" }, "key_groups"), "card");
});

test("the old tunnels-view value moves over unless the cache has one", () => {
    assert.deepEqual(localViewModes(null, "list"), { tunnels: "list" });
    assert.deepEqual(localViewModes('{"tunnels":"card"}', "list"), { tunnels: "card" });
    assert.deepEqual(localViewModes("not json", "nonsense"), {});
});
