import { test } from "node:test";
import assert from "node:assert/strict";
import { anyInternal, connectionAddress, internalExample } from "./connectionAddress.ts";

const geo = (scope: string, country: string | null = null) => ({ scope, country, org: null, asn: null, source: null });

test("a public peer is shown as it is", () => {
    assert.deepEqual(connectionAddress({ ip: "60.250.78.16", geo: geo("public", "TW") }), { kind: "direct", ip: "60.250.78.16", geo: geo("public", "TW") });
    // 舊後端沒有 geo：照舊顯示。/ An older backend without geo: shown as before.
    assert.deepEqual(connectionAddress({ ip: "192.168.167.1" }), { kind: "direct", ip: "192.168.167.1", geo: null });
});

test("behind an internal peer the device's own report is shown, with what the gateway saw", () => {
    assert.deepEqual(connectionAddress({ ip: "192.168.167.1", geo: geo("private"), public_ip: "114.34.69.11", public_source: "device", public_geo: geo("public", "TW") }), {
        kind: "reported",
        ip: "114.34.69.11",
        geo: geo("public", "TW"),
        saw: "192.168.167.1",
        source: "device",
    });
    assert.deepEqual(connectionAddress({ ip: "192.168.167.1", geo: geo("private") }), { kind: "internal", saw: "192.168.167.1" });
    assert.deepEqual(connectionAddress({ ip: null }), { kind: "hidden" });
});

test("whether to explain, and the example the diagram uses", () => {
    const rows = [
        { ip: "60.250.78.16", geo: geo("public") },
        { ip: "192.168.167.1", geo: geo("private") },
        { ip: "192.168.167.1", geo: geo("private"), public_ip: "52.199.214.132" },
    ];
    assert.equal(anyInternal(rows), true);
    assert.equal(anyInternal([rows[0]]), false);
    assert.deepEqual(internalExample(rows), { saw: "192.168.167.1", reported: null }, "the newest internal row");
    assert.deepEqual(internalExample([rows[2]]), { saw: "192.168.167.1", reported: "52.199.214.132" });
    assert.equal(internalExample([rows[0]]), null);
});
