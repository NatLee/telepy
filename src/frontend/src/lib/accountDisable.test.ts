import { test } from "node:test";
import assert from "node:assert/strict";
import { cutSpots, nothingToCut, parseImpact } from "./accountDisable.ts";

test("the backend counts are read safely", () => {
    assert.deepEqual(parseImpact({ web_sessions: 2, live_sessions: 3, agent_sessions: 1, api_tokens: 1, connected_apps: 0 }), { web_sessions: 2, live_sessions: 3, agent_sessions: 1, api_tokens: 1, connected_apps: 0 });
    assert.deepEqual(parseImpact({ web_sessions: -1, live_sessions: "x", api_tokens: 2.7 }), { web_sessions: 0, live_sessions: 0, agent_sessions: 0, api_tokens: 2, connected_apps: 0 });
    assert.equal(parseImpact(null), null);
    assert.equal(parseImpact("nope"), null);
});

test("what gets cut, before and after", () => {
    const i = { web_sessions: 2, live_sessions: 3, agent_sessions: 1, api_tokens: 0, connected_apps: 1 };
    const before = cutSpots(i, false);
    assert.deepEqual(before.map((s) => [s.id, s.count, s.outcome, s.state]), [
        ["browsers", 2, "signedOut", "failed"],
        ["sessions", 4, "ended", "failed"],
        ["tokens", 0, "none", "waiting"],
        ["apps", 1, "suspended", "failed"],
    ]);
    assert.deepEqual(before.map((s) => s.comesBack), [false, false, true, true], "only tokens and apps come back");
    assert.deepEqual(cutSpots(i, true).map((s) => s.state), ["ok", "ok", "waiting", "ok"]);
    assert.equal(nothingToCut(i), false);
    assert.equal(nothingToCut({ web_sessions: 0, live_sessions: 0, agent_sessions: 0, api_tokens: 0, connected_apps: 0 }), true);
});
