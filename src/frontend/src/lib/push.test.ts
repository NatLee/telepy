import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bytesToB64url, isIos, keyBytes, lastDelivery, PUSH_SERVICES, pushSpots, pushSupport, type PushEnv } from "./push.ts";

const env = (over: Partial<PushEnv> = {}): PushEnv => ({ secure: true, serviceWorker: true, pushManager: true, notification: true, ios: false, standalone: false, ...over });

test("a browser can receive pushes only over HTTPS, with a service worker, and on iOS only from the Home Screen", () => {
    assert.equal(pushSupport(env()), "ok");
    assert.equal(pushSupport(env({ secure: false })), "insecure");
    assert.equal(pushSupport(env({ ios: true, pushManager: false })), "iosInstall", "Safari in a tab has no PushManager");
    assert.equal(pushSupport(env({ ios: true, standalone: true })), "ok");
    assert.equal(pushSupport(env({ pushManager: false })), "unsupported");
    assert.equal(pushSupport(env({ notification: false })), "unsupported");
    assert.equal(isIos("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 5), true);
    assert.equal(isIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5), true, "iPad Safari says Macintosh");
    assert.equal(isIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0), false);
});

test("the VAPID key round-trips between base64url and bytes", () => {
    const key = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    const bytes = keyBytes(key);
    assert.equal(bytes.length, 65);
    assert.equal(bytes[0], 4, "an uncompressed point");
    assert.equal(bytesToB64url(bytes), key);
    assert.equal(bytesToB64url(bytes.buffer), key);
    assert.equal(bytesToB64url(null), "");
});

test("the newer of the last success and the last error wins", () => {
    assert.equal(lastDelivery({ last_success_at: null, last_error_at: null }), "none");
    assert.equal(lastDelivery({ last_success_at: "2026-11-03T10:00:00Z", last_error_at: null }), "ok");
    assert.equal(lastDelivery({ last_success_at: "2026-11-03T10:00:00Z", last_error_at: "2026-11-03T11:00:00Z" }), "failed");
    assert.equal(lastDelivery({ last_success_at: "2026-11-03T12:00:00Z", last_error_at: "2026-11-03T11:00:00Z" }), "ok");
});

test("the diagram lights up as far as the last push got", () => {
    assert.deepEqual(pushSpots(false, "ok"), { telepy: "waiting", service: "waiting", device: "waiting" });
    assert.deepEqual(pushSpots(true, "none"), { telepy: "ok", service: "waiting", device: "waiting" });
    assert.deepEqual(pushSpots(true, "ok"), { telepy: "ok", service: "ok", device: "ok" });
    assert.deepEqual(pushSpots(true, "failed"), { telepy: "ok", service: "failed", device: "waiting" });
});

test("the push services match the backend's list", () => {
    const rust = readFileSync(new URL("../../../backend-api/src/push/notice.rs", import.meta.url), "utf8");
    const names = [...rust.matchAll(/\("[a-z.]+", "([a-z]+)"\)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(names)].sort(), [...PUSH_SERVICES].sort());
});
