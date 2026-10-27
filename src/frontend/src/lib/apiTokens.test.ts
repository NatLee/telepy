import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeAbilities, sortTokens, tokenExamples, tokenExpiryValue, tokenLanes, tokenState, type ApiToken } from "./apiTokens.ts";

const NOW = new Date(2026, 9, 27, 10, 0, 0); // local 2026-10-27 10:00

test("expiry presets end at the end of a local day, at most a year away", () => {
    assert.equal(tokenExpiryValue("30", "", NOW), new Date(2026, 10, 26, 23, 59, 59).toISOString());
    assert.equal(tokenExpiryValue("custom", "2026-12-31", NOW), new Date(2026, 11, 31, 23, 59, 59).toISOString());
    assert.equal(tokenExpiryValue("custom", "", NOW), undefined);
    assert.equal(tokenExpiryValue("custom", "2026-10-26", NOW), undefined, "the past");
    assert.equal(tokenExpiryValue("custom", "2027-12-01", NOW), undefined, "more than a year");
    assert.ok(tokenExpiryValue("365", "", NOW));
});

test("state and ordering", () => {
    const now = NOW.getTime();
    const day = 86_400_000;
    const tok = (id: number, expiresIn: number, revoked = false) => ({ id, revoked_at: revoked ? "x" : null, expires_at: new Date(now + expiresIn).toISOString() }) as ApiToken;
    assert.equal(tokenState(tok(1, 30 * day), now), "active");
    assert.equal(tokenState(tok(1, 3 * day), now), "soon");
    assert.equal(tokenState(tok(1, -day), now), "expired");
    assert.equal(tokenState(tok(1, 30 * day, true), now), "revoked");
    const sorted = sortTokens([tok(1, 30 * day), tok(2, -day), tok(3, 2 * day), tok(4, day, true)], now).map((t) => t.id);
    assert.deepEqual(sorted, [3, 1, 4, 2]);
});

test("a revoke cuts only the token lane", () => {
    const live = tokenLanes(false);
    assert.deepEqual(live.map((l) => l.id), ["token", "web", "apps"]);
    assert.ok(live.every((l) => !l.cut && l.devices === "ok"));
    const cut = tokenLanes(true);
    assert.equal(cut[0].credential, "failed");
    assert.equal(cut[0].devices, "waiting");
    assert.ok(cut[0].cut);
    assert.ok(cut.slice(1).every((l) => l.credential === "ok" && !l.cut), "web sign-in and MCP apps keep working");
});

test("abilities keep the canonical order; examples", () => {
    assert.deepEqual(scopeAbilities(["tunnels:manage", "tunnels:read", "bogus"]), ["tunnels:read", "tunnels:manage"]);
    const ex = tokenExamples("https://t.example/", "tpt_abc");
    assert.equal(ex.cli, "telepy login https://t.example --token tpt_abc");
    assert.ok(ex.curl.includes("Bearer tpt_abc") && ex.curl.endsWith("/api/reverse/server/dashboard"));
    assert.equal(JSON.parse(ex.mcp).mcpServers.telepy.url, "https://t.example/mcp");
});
