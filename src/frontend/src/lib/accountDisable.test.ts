import { test } from "node:test";
import assert from "node:assert/strict";
import { cutSpots, keysLine, nothingToCut, parseImpact } from "./accountDisable.ts";

const noKeys = { devices: 0, accounts: 0, offline_devices: 0 };

test("the backend counts are read safely", () => {
    assert.deepEqual(parseImpact({ web_sessions: 2, live_sessions: 3, agent_sessions: 1, api_tokens: 1, connected_apps: 0 }), { web_sessions: 2, live_sessions: 3, agent_sessions: 1, api_tokens: 1, connected_apps: 0, device_keys: noKeys });
    assert.deepEqual(parseImpact({ web_sessions: -1, live_sessions: "x", api_tokens: 2.7 }), { web_sessions: 0, live_sessions: 0, agent_sessions: 0, api_tokens: 2, connected_apps: 0, device_keys: noKeys });
    assert.deepEqual(parseImpact({ device_keys: { devices: 2, accounts: 3, offline_devices: 5 } })?.device_keys, { devices: 2, accounts: 3, offline_devices: 2 }, "offline never exceeds devices");
    assert.equal(parseImpact(null), null);
    assert.equal(parseImpact("nope"), null);
});

test("what gets cut, before and after", () => {
    const i = { web_sessions: 2, live_sessions: 3, agent_sessions: 1, api_tokens: 0, connected_apps: 1, device_keys: { devices: 2, accounts: 3, offline_devices: 1 } };
    const before = cutSpots(i, false);
    assert.deepEqual(before.map((s) => [s.id, s.count, s.outcome, s.state]), [
        ["browsers", 2, "signedOut", "failed"],
        ["sessions", 4, "ended", "failed"],
        ["tokens", 0, "none", "waiting"],
        ["apps", 1, "suspended", "failed"],
        ["keys", 2, "removed", "failed"],
    ]);
    assert.deepEqual(before.map((s) => s.comesBack), [false, false, true, true, true], "tokens, apps and device keys come back");
    assert.deepEqual(cutSpots(i, true).map((s) => s.state), ["ok", "ok", "waiting", "ok", "ok"]);
    assert.equal(nothingToCut(i), false);
    const empty = { web_sessions: 0, live_sessions: 0, agent_sessions: 0, api_tokens: 0, connected_apps: 0, device_keys: noKeys };
    assert.equal(nothingToCut(empty), true);
    assert.equal(nothingToCut({ ...empty, device_keys: { devices: 1, accounts: 1, offline_devices: 1 } }), false, "keys on a device count");
});

test("the device key sentence", () => {
    const base = { web_sessions: 0, live_sessions: 0, agent_sessions: 0, api_tokens: 0, connected_apps: 0 };
    assert.equal(keysLine({ ...base, device_keys: noKeys }), "none");
    assert.equal(keysLine({ ...base, device_keys: { devices: 2, accounts: 2, offline_devices: 0 } }), "online");
    assert.equal(keysLine({ ...base, device_keys: { devices: 2, accounts: 3, offline_devices: 1 } }), "someOffline");
});
