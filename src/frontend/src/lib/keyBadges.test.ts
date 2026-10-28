import { test } from "node:test";
import assert from "node:assert/strict";
import { cardDevices, deviceBadgeText, deviceState, keyBadges } from "./keyBadges.ts";

const NOW = Date.parse("2026-10-29T00:00:00Z");
const day = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

test("warnings come first, then the device key, then the group", () => {
    const key = { expires_at: iso(NOW - day), device_of: [{ id: 1, name: "laptop" }] };
    assert.deepEqual(
        keyBadges(key, "work", true, NOW).map((b) => b.kind),
        ["expired", "device", "group"],
    );
    assert.equal(keyBadges({ expires_at: iso(NOW + 3 * day), device_of: [] }, null, true, NOW)[0].kind, "expiring");
});

test("expiry is a chip only when the layout has no expiry field, and only when it needs attention", () => {
    const soon = { expires_at: iso(NOW + 3 * day), device_of: [] };
    assert.deepEqual(keyBadges(soon, null, false, NOW), []);
    assert.deepEqual(keyBadges({ expires_at: iso(NOW + 60 * day), device_of: [] }, null, true, NOW), []);
    assert.deepEqual(keyBadges({ expires_at: null, device_of: undefined }, null, true, NOW), []);
});

test("the device-key chip names one tunnel and counts several", () => {
    assert.deepEqual(deviceBadgeText(["laptop"]), { one: "laptop" });
    assert.deepEqual(deviceBadgeText(["a", "b", "c"]), { count: 3 });
    const badge = keyBadges({ expires_at: null, device_of: [{ id: 1, name: "a" }, { id: 2, name: "b" }] }, null, false, NOW)[0];
    assert.deepEqual(badge, { kind: "device", names: ["a", "b"] });
});

test("a device is installed only when every account is, failed when any account failed", () => {
    assert.equal(deviceState([{ status: "installed" }, { status: "installed" }]), "installed");
    assert.equal(deviceState([{ status: "installed" }, { status: "pending" }]), "pending");
    assert.equal(deviceState([{ status: "pending" }, { status: "error" }]), "error");
    assert.equal(deviceState([]), "pending");
});

test("cards list what needs a look first and fold the rest, never as '1 more'", () => {
    const d = (name: string, state: "installed" | "error" | "pending") => ({ name, state });
    const all = [d("web-2", "installed"), d("web-1", "installed"), d("db", "error"), d("cache", "pending"), d("edge", "installed"), d("lb", "installed")];
    const r = cardDevices(all, 4);
    assert.deepEqual(r.shown.map((x) => x.name), ["db", "cache", "edge", "lb"]);
    assert.deepEqual(r.more.map((x) => x.name), ["web-1", "web-2"]);
    const five = cardDevices(all.slice(0, 5), 4);
    assert.equal(five.shown.length, 5);
    assert.equal(five.more.length, 0);
});
