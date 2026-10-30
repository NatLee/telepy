import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EDGE_HEADERS, KNOWN_HEADERS, headerChoices, isHeaderName, knownHeader } from "./clientIpHeaders.ts";
import { CDN_HEADERS } from "./clientIp.ts";

const rust = readFileSync(new URL("../../../backend-api/src/client_ip.rs", import.meta.url), "utf8");
const candidates = (() => {
    const block = rust.slice(rust.indexOf("pub const CANDIDATE_HEADERS"), rust.indexOf("];", rust.indexOf("pub const CANDIDATE_HEADERS")));
    return [...block.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
})();

test("the address check reports every header offered here", () => {
    assert.ok(candidates.length >= 10, `read ${candidates.length} candidates`);
    for (const h of KNOWN_HEADERS) assert.ok(candidates.includes(h.name.toLowerCase()), `${h.name} is missing from CANDIDATE_HEADERS`);
    for (const h of KNOWN_HEADERS) assert.ok(isHeaderName(h.name), h.name);
});

test("the CDN check counts every edge-set header", () => {
    for (const h of EDGE_HEADERS) assert.ok(CDN_HEADERS.includes(h), h);
    assert.ok(!EDGE_HEADERS.includes("x-real-ip"), "nginx's header is a proxy you run, not an edge");
});

test("lookup ignores case", () => {
    assert.equal(knownHeader("cf-connecting-ip")?.id, "cloudflare");
    assert.equal(knownHeader(" X-REAL-IP ")?.id, "realIp");
    assert.equal(knownHeader("x-unknown"), undefined);
});

test("header names follow the HTTP token rule", () => {
    assert.equal(isHeaderName("CF-Connecting-IP"), true);
    assert.equal(isHeaderName("X Real IP"), false);
    assert.equal(isHeaderName("x-real-ip:"), false);
});

test("arrived headers come first, public addresses first, Forwarded left out", () => {
    const seen = [
        { name: "x-real-ip", value: "172.18.0.1", addresses: [{ ip: "172.18.0.1", scope: "private" }] },
        { name: "cf-connecting-ip", value: "203.0.113.9", addresses: [{ ip: "203.0.113.9", scope: "public" }] },
        { name: "forwarded", value: "for=203.0.113.9", addresses: [{ ip: "203.0.113.9", scope: "public" }] },
        { name: "x-weird-ip", value: "203.0.113.10", addresses: [{ ip: "203.0.113.10", scope: "public" }] },
    ];
    const choices = headerChoices(seen, "X-Real-IP");
    assert.deepEqual(choices.slice(0, 3).map((c) => c.name), ["CF-Connecting-IP", "x-weird-ip", "X-Real-IP"]);
    assert.ok(!choices.some((c) => c.name.toLowerCase() === "forwarded"));
    assert.equal(choices.find((c) => c.name === "X-Real-IP")?.current, true);
    assert.equal(choices.find((c) => c.name === "x-weird-ip")?.known, null);
    // 其他認得的跟在後面、沒收到。/ The other known ones follow, not seen.
    const rest = choices.slice(3);
    assert.equal(rest.length, KNOWN_HEADERS.length - 2);
    assert.ok(rest.every((c) => c.seen === null && c.known));
});

test("nothing current when blank", () => {
    assert.ok(headerChoices([], "").every((c) => !c.current));
});
