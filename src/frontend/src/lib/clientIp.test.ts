import { test } from "node:test";
import assert from "node:assert/strict";
import { PROBE_FORWARDED_FOR, PROBE_REAL_IP, checkPassed, hopState, parseClientIpCheck, probeOutcome, viaCdn, type ClientIpCheck } from "./clientIp.ts";

const production = {
    ip: "172.19.0.1",
    scope: "private",
    from: "chain",
    geo: { scope: "private" },
    trusted_proxy_hops: 2,
    client_ip_header: null,
    chain: [
        { ip: "172.19.0.1", scope: "private", source: "forwarded_for", role: "client" },
        { ip: "192.168.167.1", scope: "private", source: "forwarded_for", role: "proxy" },
        { ip: "192.168.167.3", scope: "private", source: "peer", role: "proxy" },
    ],
    headers: [{ name: "x-real-ip", value: "172.19.0.1", addresses: [{ ip: "172.19.0.1", scope: "private" }] }],
    verdict: "all_private",
    suggest: { trusted_proxy_hops: null, client_ip_header: null },
    short_chain: false,
    header_absent: false,
};

test("the backend answer is read safely", () => {
    const c = parseClientIpCheck(production)!;
    assert.equal(c.ip, "172.19.0.1");
    assert.equal(c.trustedProxyHops, 2);
    assert.equal(c.clientIpHeader, null);
    assert.equal(c.chain.length, 3);
    assert.equal(c.chain[2].source, "peer");
    assert.deepEqual(c.headers[0].addresses, [{ ip: "172.19.0.1", scope: "private" }]);
    assert.equal(c.verdict, "all_private");
    assert.equal(checkPassed(c), false);

    assert.equal(parseClientIpCheck(null), null);
    assert.equal(parseClientIpCheck({ ip: "1.2.3.4" }), null, "no chain = not this endpoint");
    const odd = parseClientIpCheck({ chain: [{ ip: "" }, { ip: "1.2.3.4", role: "boss" }], verdict: "great", trusted_proxy_hops: -3, suggest: { trusted_proxy_hops: 2.5 } })!;
    assert.deepEqual(odd.chain, [{ ip: "1.2.3.4", scope: "reserved", source: "forwarded_for", role: "proxy" }]);
    assert.equal(odd.verdict, "unknown");
    assert.equal(odd.trustedProxyHops, 0);
    assert.equal(odd.suggestHops, null);
});

test("only the chosen hop is coloured", () => {
    const c = parseClientIpCheck(production)!;
    assert.deepEqual(c.chain.map(hopState), ["failed", "waiting", "waiting"]);
    assert.equal(hopState({ ip: "198.51.100.7", scope: "public", source: "forwarded_for", role: "client" }), "ok");
    assert.equal(hopState({ ip: "6.6.6.6", scope: "public", source: "forwarded_for", role: "ignored" }), "waiting");
});

test("the made-up address test says which header leaked through", () => {
    const base = parseClientIpCheck(production)!;
    const at = (ip: string): ClientIpCheck => ({ ...base, ip });
    assert.equal(probeOutcome(at(PROBE_REAL_IP)), "real_ip");
    assert.equal(probeOutcome(at(PROBE_FORWARDED_FOR)), "forwarded_for");
    assert.equal(probeOutcome(at("172.19.0.1")), "safe");
});

test("a CDN counts only when its own header arrived", () => {
    const c = parseClientIpCheck(production)!;
    assert.equal(viaCdn(c), false, "x-real-ip is set by the proxy, not a CDN");
    const cf = parseClientIpCheck({ ...production, headers: [...production.headers, { name: "cf-connecting-ip", value: "203.0.113.9", addresses: [{ ip: "203.0.113.9", scope: "public" }] }] })!;
    assert.equal(viaCdn(cf), true);
    assert.equal(viaCdn({ ...c, headers: [{ name: "True-Client-IP", value: "", addresses: [] }] }), true);
});
