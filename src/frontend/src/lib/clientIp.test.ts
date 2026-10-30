import { test } from "node:test";
import assert from "node:assert/strict";
import { VISITOR_SETTINGS_HREF, PROBE_FORWARDED_FOR, PROBE_REAL_IP, checkPassed, hopState, hopsSetting, parseClientIpCheck, probeOutcome, viaCdn, type ClientIpCheck } from "./clientIp.ts";

const production = {
    ip: "172.19.0.1",
    scope: "private",
    from: "chain",
    geo: { scope: "private" },
    hops_mode: "fixed",
    trusted_proxy_hops: 2,
    skipped_hops: 2,
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
    assert.equal(c.hopsMode, "fixed");
    assert.equal(c.trustedProxyHops, 2);
    assert.equal(c.skippedHops, 2);
    assert.equal(hopsSetting(c), "2");
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
    assert.equal(odd.trustedProxyHops, null);
    assert.equal(odd.hopsMode, "auto", "no mode and no count = auto");
    assert.equal(odd.suggestHops, null);
    const auto = parseClientIpCheck({ ...production, hops_mode: "auto", trusted_proxy_hops: null, skipped_hops: 2 })!;
    assert.equal(auto.hopsMode, "auto");
    assert.equal(auto.trustedProxyHops, null);
    assert.equal(hopsSetting(auto), "auto");
    const older = parseClientIpCheck({ ...production, hops_mode: undefined, trusted_proxy_hops: 1 })!;
    assert.equal(older.hopsMode, "fixed", "an older backend only sends the count");
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
    // 自動模式下被採用的假 X-Forwarded-For：你自己在內網，不是層數算錯。/ In auto mode it means you are internal.
    assert.equal(probeOutcome({ ...at(PROBE_FORWARDED_FOR), hopsMode: "auto", trustedProxyHops: null }), "auto_internal");
});

test("a CDN counts only when its own header arrived", () => {
    const c = parseClientIpCheck(production)!;
    assert.equal(viaCdn(c), false, "x-real-ip is set by the proxy, not a CDN");
    const cf = parseClientIpCheck({ ...production, headers: [...production.headers, { name: "cf-connecting-ip", value: "203.0.113.9", addresses: [{ ip: "203.0.113.9", scope: "public" }] }] })!;
    assert.equal(viaCdn(cf), true);
    assert.equal(viaCdn({ ...c, headers: [{ name: "True-Client-IP", value: "", addresses: [] }] }), true);
});

test("the Cloudflare block and the masked hint", () => {
    const old = parseClientIpCheck(production)!;
    assert.equal(old.cloudflare, null, "an older backend has no cloudflare block");
    assert.equal(old.cloudflareMasked, false);

    const used = parseClientIpCheck({ ...production, cloudflare: { mode: "auto", header: "198.51.100.4", edge_seen: true, used: true } })!;
    assert.deepEqual(used.cloudflare, { mode: "auto", header: "198.51.100.4", edgeSeen: true, used: true });
    assert.equal(used.cloudflareMasked, false);

    // 自動 + 有標頭 + 沒看到 Cloudflare 的位址 = 前面的代理換掉了（就算後端沒給提示）。/ Derived even without the hint.
    const masked = parseClientIpCheck({ ...production, cloudflare: { mode: "auto", header: "198.51.100.4", edge_seen: false, used: false } })!;
    assert.equal(masked.cloudflareMasked, true);
    assert.equal(parseClientIpCheck({ ...production, cloudflare_masked: true })!.cloudflareMasked, true);
    assert.equal(parseClientIpCheck({ ...production, hints: ["cloudflare_masked"] })!.cloudflareMasked, true);
    // hints 有給就以它為準（例如訪客位址標頭指定了 CF-Connecting-IP）。/ A hints list is authoritative.
    assert.equal(parseClientIpCheck({ ...production, hints: [], cloudflare: { mode: "auto", header: "198.51.100.4", edge_seen: false, used: false } })!.cloudflareMasked, false);
    // 一律採用 / 關掉時不是「被遮住」。/ Always / off are not "masked".
    const always = parseClientIpCheck({ ...production, cloudflare: { mode: "always", header: "198.51.100.4", edge_seen: false, used: true } })!;
    assert.equal(always.cloudflareMasked, false);
    assert.equal(parseClientIpCheck({ ...production, cloudflare: { mode: "weird", header: "" } })!.cloudflare!.mode, "auto");
    assert.equal(parseClientIpCheck({ ...production, cloudflare: { mode: "off", header: "" } })!.cloudflare!.header, null);
});

test("fixes point at the Server tab", () => {
    assert.equal(VISITOR_SETTINGS_HREF, "/tunnels/settings?tab=server#visitor-addresses");
});
