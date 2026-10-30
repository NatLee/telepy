import { test } from "node:test";
import assert from "node:assert/strict";
import { hostProblem, initialScenario, lanes, parseSshHostCheck, tidyHost, verdictTone } from "./sshHost.ts";

test("the host rule matches the backend's", () => {
    assert.equal(tidyHost(" SSH.Example.com. "), "ssh.example.com");
    for (const ok of ["", "ssh.example.com", "telepy-ssh.natlee.info", "203.0.113.9", "localhost"]) assert.equal(hostProblem(ok), null, ok);
    assert.equal(hostProblem("https://ssh.example.com"), "chars");
    assert.equal(hostProblem("ssh.example.com:22"), "chars");
    assert.equal(hostProblem("fe80::1"), "chars", "no IPv6: the join script only takes name characters");
    assert.equal(hostProblem("a b"), "chars");
    assert.equal(hostProblem("-bad.example.com"), "label");
    assert.equal(hostProblem("a..b"), "label");
    assert.equal(hostProblem(`${"a".repeat(64)}.com`), "label");
});

test("the check answer is read defensively", () => {
    assert.equal(parseSshHostCheck(null), null);
    assert.equal(parseSshHostCheck({ verdict: "split" }), null, "an older backend");
    const c = parseSshHostCheck({
        ssh: { host: "ssh.example.com", addresses: ["114.34.69.11", 3], cloudflare: false, error: null, port: "56767", source: "env" },
        web: { host: "t.example.com", addresses: ["104.21.35.8"], cloudflare: true, error: null, from: "public_url", via_cloudflare: true, proxied: true },
        same: false,
        verdict: "split",
    });
    assert.ok(c);
    assert.deepEqual(c.ssh.addresses, ["114.34.69.11"]);
    assert.equal(c.ssh.source, "env");
    assert.equal(c.web.viaCloudflare, true);
    assert.equal(c.verdict, "split");
    assert.equal(verdictTone(c.verdict), "tip");
    assert.equal(parseSshHostCheck({ ssh: {}, web: {}, verdict: "weird" })?.verdict, "same");
    assert.equal(verdictTone("ssh_proxied"), "danger");
    assert.equal(verdictTone("unresolved"), "warning");
});

test("only a proxied name shared with SSH cuts the SSH lane", () => {
    assert.equal(lanes(true, false).ssh.hop, "failed");
    assert.equal(lanes(true, false).ssh.viaProxy, true);
    assert.equal(lanes(true, false).web.hop, "ok", "the web lane works either way");
    for (const [proxied, separate] of [[true, true], [false, false], [false, true]] as const) {
        assert.equal(lanes(proxied, separate).ssh.hop, "ok", `${proxied}/${separate}`);
        assert.equal(lanes(proxied, separate).ssh.viaProxy, false);
    }
});

test("the explainer starts from what the check found", () => {
    assert.deepEqual(initialScenario(null), { proxied: true, separate: true });
    const c = parseSshHostCheck({ ssh: { host: "t", cloudflare: true }, web: { host: "t", proxied: false }, same: true, verdict: "ssh_proxied" });
    assert.deepEqual(initialScenario(c), { proxied: true, separate: false });
});
