import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPARE_ROWS, deviceCounts, deviceLinkState, deviceLinkText, laptopAddress } from "./transportInfo.ts";
import { en } from "../locales/en.ts";

test("device counts sort connected devices by how they came in", () => {
    const c = deviceCounts([
        { online: true, transport: "tcp" },
        { online: true, transport: "websocket" },
        { online: true, transport: null },
        { online: false, transport: "tcp" },
        { online: null, transport: undefined },
        { online: null, transport: "websocket" },
    ]);
    assert.deepEqual(c, { ssh: 1, web: 2, unknown: 1, offline: 2 });
    assert.equal(deviceLinkState(c), "ok");
    assert.equal(deviceLinkState({ ssh: 0, web: 0, unknown: 0, offline: 3 }), "waiting");
});

test("one device says how it came in; many list the non-zero counts", () => {
    assert.deepEqual(deviceLinkText(deviceCounts([{ online: true, transport: "websocket" }])), [{ key: "config.ti.devWeb", count: 1 }]);
    assert.deepEqual(deviceLinkText(deviceCounts([{ online: false, transport: null }])), [{ key: "config.ti.devOffline", count: 1 }]);
    assert.deepEqual(deviceLinkText({ ssh: 3, web: 0, unknown: 0, offline: 2 }), [
        { key: "config.ti.devManySsh", count: 3 },
        { key: "config.ti.devManyOffline", count: 2 },
    ]);
});

test("the laptop's address follows the choice", () => {
    const server = { host: "telepy.example", port: "24242" };
    assert.equal(laptopAddress("ssh", server, "wss://telepy.example/ws/gateway/"), "telepy.example:24242");
    assert.equal(laptopAddress("websocket", server, "wss://telepy.example/ws/gateway/"), "wss://telepy.example/ws/gateway/");
    assert.equal(laptopAddress("ssh", { host: "h", port: "" }, null), "h");
    assert.equal(laptopAddress("ssh", null, null), "…");
});

test("every comparison key exists in the dictionary", () => {
    for (const row of COMPARE_ROWS) for (const k of [row.label, row.mine, row.device]) assert.ok(k in en, k);
});
