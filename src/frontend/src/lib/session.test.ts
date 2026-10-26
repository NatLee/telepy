import { test } from "node:test";
import assert from "node:assert/strict";

import {
    accessTokenExpiring,
    canRetryAfterRefresh,
    MIN_REFRESH_DELAY_MS,
    REFRESH_LEAD_MS,
    refreshDelayMs,
    refreshLeadMs,
    tokenTimes,
    UNKNOWN_EXPIRY_DELAY_MS,
} from "./session.ts";

/** 假 JWT：只有 payload 要對，簽章隨便。/ A fake JWT: only the payload matters. */
function jwt(payload: Record<string, unknown>): string {
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `eyJhbGciOiJIUzI1NiJ9.${b64}.sig`;
}

const NOW = 1_700_000_000_000;

test("tokenTimes reads exp and iat in milliseconds", () => {
    assert.deepEqual(tokenTimes(jwt({ exp: 1_700_003_600, iat: 1_700_000_000, user_id: 1 })), { exp: 1_700_003_600_000, iat: 1_700_000_000_000 });
    assert.deepEqual(tokenTimes(jwt({ exp: 1_700_003_600 })), { exp: 1_700_003_600_000, iat: null });
    assert.equal(tokenTimes(jwt({ iat: 1 })), null, "no exp");
    assert.equal(tokenTimes("not.a-jwt"), null);
    assert.equal(tokenTimes("a.!!!.c"), null, "undecodable payload");
    assert.equal(tokenTimes(null), null);
    assert.equal(tokenTimes(""), null);
});

test("the lead is two minutes, capped at half the lifetime", () => {
    assert.equal(refreshLeadMs({ exp: NOW + 3_600_000, iat: NOW }), REFRESH_LEAD_MS);
    assert.equal(refreshLeadMs({ exp: NOW + 60_000, iat: NOW }), 30_000, "a one-minute token renews halfway");
    assert.equal(refreshLeadMs({ exp: NOW + 60_000, iat: null }), REFRESH_LEAD_MS, "no iat: the default lead");
});

test("accessTokenExpiring: within the lead, expired, or unreadable", () => {
    const hour = jwt({ exp: (NOW + 3_600_000) / 1000, iat: NOW / 1000 });
    assert.equal(accessTokenExpiring(hour, NOW), false);
    assert.equal(accessTokenExpiring(hour, NOW + 3_600_000 - REFRESH_LEAD_MS + 1), true);
    assert.equal(accessTokenExpiring(hour, NOW + 4_000_000), true, "already expired");
    assert.equal(accessTokenExpiring("garbage", NOW), true, "let the server decide");
    assert.equal(accessTokenExpiring(null, NOW), true);
});

test("refreshDelayMs schedules the renewal before expiry with a floor", () => {
    const hour = jwt({ exp: (NOW + 3_600_000) / 1000, iat: NOW / 1000 });
    assert.equal(refreshDelayMs(hour, NOW), 3_600_000 - REFRESH_LEAD_MS);
    assert.equal(refreshDelayMs(hour, NOW + 3_599_000), MIN_REFRESH_DELAY_MS, "never a tight loop");
    assert.equal(refreshDelayMs("garbage", NOW), UNKNOWN_EXPIRY_DELAY_MS);
    const minute = jwt({ exp: (NOW + 60_000) / 1000, iat: NOW / 1000 });
    assert.equal(refreshDelayMs(minute, NOW), 30_000, "half the lifetime for short tokens");
});

test("canRetryAfterRefresh skips login endpoints and token-less requests", () => {
    assert.equal(canRetryAfterRefresh("/api/reverse/server/dashboard", true), true);
    assert.equal(canRetryAfterRefresh("/api/reverse/server/dashboard?x=1", true), true);
    assert.equal(canRetryAfterRefresh("http://localhost:8787/api/sessions", true), true);
    assert.equal(canRetryAfterRefresh("/api/reverse/server/dashboard", false), false, "no token was sent");
    assert.equal(canRetryAfterRefresh("/api/auth/token", true), false, "a wrong password is not an expired token");
    assert.equal(canRetryAfterRefresh("/api/auth/token/refresh", true), false);
    assert.equal(canRetryAfterRefresh("/api/auth/passkey/login", true), false);
});
