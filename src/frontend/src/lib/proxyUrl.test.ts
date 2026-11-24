import { test } from "node:test";
import assert from "node:assert/strict";
import { proxyRows, proxyUrlProblem, proxyVerdict, tidyUrl } from "./proxyUrl.ts";

const WS = "wss://telepy.example.com/ws/proxy/";

test("both addresses are always listed", () => {
    // 沒設定：代理那一列就是網頁的位址。/ Unset: the proxy row is the web address.
    assert.deepEqual(proxyRows("", WS, false), [
        { id: "web", value: WS, state: "always" },
        { id: "proxy", value: WS, state: "sameAsWeb" },
    ]);
    assert.deepEqual(proxyRows(" https://proxy.example.com:8444/ ", WS, true)[1], { id: "proxy", value: "https://proxy.example.com:8444", state: "listening" });
    assert.equal(proxyRows("https://proxy.example.com:8444", WS, false)[1].state, "notListening");
    assert.equal(proxyVerdict("", true), "webOnly");
    assert.equal(proxyVerdict("https://p.example.com", true), "ready");
    assert.equal(proxyVerdict("https://p.example.com", false), "portClosed");
});

test("the input follows the backend's rule", () => {
    assert.equal(tidyUrl(" https://p.example.com:8444// "), "https://p.example.com:8444");
    for (const ok of ["", "  ", "https://proxy.example.com:8444", "http://10.0.0.5:8444/"]) assert.equal(proxyUrlProblem(ok), null, ok);
    for (const bad of ["proxy.example.com:8444", "socks5://proxy.example.com", "https://box:token@proxy.example.com", "https://proxy.example.com/path", "https://proxy.example.com/?a=1"]) assert.equal(proxyUrlProblem(bad), "format", bad);
});
