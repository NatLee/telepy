import { test } from "node:test";
import assert from "node:assert/strict";
import { addSources, fitsLimit, hasSource, parseAddressSources, peerAdvice, presetAdded, removeSource, sortPeers, splitSources, type GatewayPeer } from "./proxySources.ts";

const peer = (ip: string, extra: Partial<GatewayPeer> = {}): GatewayPeer => ({ ip, scope: "private", connections: 1, proxyHeaders: 0, firstAt: "", lastAt: "", lastHeaderAt: null, listed: false, ...extra });

test("parses the backend shape and drops junk", () => {
    const s = parseAddressSources({
        since: "2026-10-30T01:00:00Z",
        peers: [{ ip: "10.0.0.5", scope: "private", connections: 4, proxy_headers: 4, first_at: "a", last_at: "b", last_header_at: "b", listed: false }, { scope: "private" }],
        other_public: 7,
        presets: [{ id: "private", cidrs: ["10.0.0.0/8"] }, { id: "nope", cidrs: ["1.2.3.4"] }, { id: "loopback", cidrs: [] }],
    });
    assert.ok(s);
    assert.equal(s.peers.length, 1);
    assert.equal(s.peers[0].proxyHeaders, 4);
    assert.equal(s.otherPublic, 7);
    assert.deepEqual(s.presets.map((p) => p.id), ["private"]);
    assert.equal(parseAddressSources({}), null);
    assert.equal(parseAddressSources(null), null);
});

test("editing the list", () => {
    assert.deepEqual(splitSources(" 10.0.0.5,  10.1.0.0/16 fd00::/8 "), ["10.0.0.5", "10.1.0.0/16", "fd00::/8"]);
    assert.equal(addSources("10.0.0.5", ["10.0.0.6", "10.0.0.5"]), "10.0.0.5, 10.0.0.6");
    assert.equal(addSources("", ["127.0.0.1", "::1"]), "127.0.0.1, ::1");
    assert.equal(addSources("FD00::/8", ["fd00::/8"]), "FD00::/8", "case-insensitive duplicate");
    assert.equal(removeSource("10.0.0.5, 10.0.0.6", "10.0.0.5"), "10.0.0.6");
    assert.equal(hasSource("10.0.0.5 10.0.0.6", "10.0.0.6"), true);
    assert.equal(hasSource("10.0.0.0/8", "10.0.0.6"), false, "CIDR coverage is the server's answer (listed), not literal");
    assert.equal(presetAdded("127.0.0.1, ::1", { id: "loopback", cidrs: ["127.0.0.1", "::1"] }), true);
    assert.equal(presetAdded("127.0.0.1", { id: "loopback", cidrs: ["127.0.0.1", "::1"] }), false);
    assert.equal(fitsLimit("x".repeat(512)), true);
    assert.equal(fitsLimit("x".repeat(513)), false);
});

test("advice per address", () => {
    assert.equal(peerAdvice(peer("10.0.0.5", { proxyHeaders: 3 })), "add");
    assert.equal(peerAdvice(peer("10.0.0.5", { proxyHeaders: 3, listed: true })), "trusted");
    assert.equal(peerAdvice(peer("10.0.0.5", { listed: true })), "idle");
    assert.equal(peerAdvice(peer("172.18.0.1")), "internal");
});

test("what needs action comes first", () => {
    const sorted = sortPeers([peer("172.18.0.1", { connections: 50 }), peer("10.0.0.9", { listed: true }), peer("10.0.0.5", { proxyHeaders: 1 }), peer("10.0.0.6", { proxyHeaders: 2, listed: true })]);
    assert.deepEqual(sorted.map((p) => p.ip), ["10.0.0.5", "10.0.0.6", "10.0.0.9", "172.18.0.1"]);
});
