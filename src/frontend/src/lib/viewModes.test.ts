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
    // 金鑰頁沒選過還是列表（以前只有列表）。/ The keys page stays a list until chosen (it used to be list-only).
    assert.equal(viewModeOf({}, "keys"), "list");
    assert.equal(viewModeOf({ keys: "card" }, "keys"), "card");
    // API 頁的 token 與 CLI 登入預設清單。/ The API page's tokens and CLI sign-ins default to a list.
    assert.equal(viewModeOf({}, "api_tokens"), "list");
    assert.equal(viewModeOf({}, "cli_signins"), "list");
    assert.equal(viewModeOf({ cli_signins: "card" }, "cli_signins"), "card");
});

test("the old tunnels-view value moves over unless the cache has one", () => {
    assert.deepEqual(localViewModes(null, "list"), { tunnels: "list" });
    assert.deepEqual(localViewModes('{"tunnels":"card"}', "list"), { tunnels: "card" });
    assert.deepEqual(localViewModes("not json", "nonsense"), {});
});
