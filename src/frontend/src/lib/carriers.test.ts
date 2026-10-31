import { test } from "node:test";
import assert from "node:assert/strict";
import { carrierFlow, carrierState, carrierSummary, newer, parseCarriers, parseVersion, platformLabel } from "./carriers.ts";

const raw = {
    auto_update: true,
    releases_url: "https://github.com/NatLee/telepy/releases",
    dir: "/data/carriers",
    keys: [{ fingerprint: "SHA256:abc", comment: "telepy-release" }],
    latest: { tag: "v2.13.0", checked_at: "2026-11-01T00:00:00Z", error: null },
    next_check_at: "2026-11-02T00:00:00Z",
    updating: false,
    targets: [
        { target: "x86_64-unknown-linux-musl", os: "linux", arch: "x86_64", cached: { version: "v2.12.0", sha256: "a".repeat(64), size: 2_000_000, fetched_at: null }, update_available: true, failure: null },
        { target: "aarch64-unknown-linux-musl", os: "linux", arch: "aarch64", cached: { version: "v2.13.0", sha256: "b".repeat(64), size: 2_000_000, fetched_at: null }, update_available: false, failure: null },
        { target: "armv7-unknown-linux-musleabihf", os: "linux", arch: "armv7l", cached: { version: null, sha256: "c".repeat(64), size: 1, fetched_at: null }, update_available: false, failure: null },
        { target: "arm-unknown-linux-musleabihf", os: "linux", arch: "armv6l", cached: null, update_available: false, failure: { at: "2026-11-01T00:00:00Z", error: "HTTP 404" } },
        { target: "aarch64-apple-darwin", os: "darwin", arch: "arm64", cached: null, update_available: false, failure: null },
    ],
    last_run: { at: "2026-11-01T00:00:00Z", trigger: "auto", by: null, tag: "v2.13.0", updated: [{ target: "aarch64-unknown-linux-musl", from: "v2.12.0", was: "release" }], current: [], failed: [["arm-unknown-linux-musleabihf", "HTTP 404"]], error: null },
};

test("versions compare by number like the backend", () => {
    assert.deepEqual(parseVersion("v2.12.0"), [2, 12, 0]);
    assert.deepEqual(parseVersion("2.12"), [2, 12, 0]);
    assert.deepEqual(parseVersion("v2.12.0-rc.1"), [2, 12, 0]);
    assert.equal(parseVersion("vtest"), null);
    assert.ok(newer("v2.10.0", "v2.9.0"));
    assert.ok(!newer("v2.12.0", "v2.12.0"));
    assert.ok(!newer("vtest", "v2.12.0"));
});

test("the view parses and every platform gets a state", () => {
    const v = parseCarriers(raw);
    assert.ok(v);
    assert.equal(parseCarriers({ nope: 1 }), null);
    const states = v.targets.map((t) => carrierState(t, v.latest.tag));
    assert.deepEqual(states, ["update", "current", "manual", "failed", "missing"]);
    assert.equal(carrierState(v.targets[1], null), "unknown", "cached but never checked");
    assert.deepEqual(carrierSummary(v), { total: 5, cached: 3, outdated: 1, manual: 1, failed: 1 });
    assert.equal(v.last_run?.updated[0].was, "release");
    assert.deepEqual(v.last_run?.failed, [["arm-unknown-linux-musleabihf", "HTTP 404"]]);
});

test("platform names", () => {
    assert.equal(platformLabel({ os: "linux", arch: "armv7l" }), "Linux ARMv7 (32-bit)");
    assert.equal(platformLabel({ os: "darwin", arch: "arm64" }), "macOS Apple silicon");
    assert.equal(platformLabel({ os: "darwin", arch: "x86_64" }), "macOS Intel");
    assert.equal(platformLabel({ os: "windows", arch: "x86_64" }), "Windows x86_64");
});

test("the info diagram follows the state", () => {
    assert.deepEqual(carrierFlow(null), { release: "waiting", signature: "waiting", cache: "waiting", devices: "waiting" });
    const v = parseCarriers(raw)!;
    assert.deepEqual(carrierFlow(v), { release: "ok", signature: "ok", cache: "ok", devices: "ok" });
    assert.equal(carrierFlow({ ...v, updating: true }).cache, "active");
    const down = parseCarriers({ ...raw, latest: { tag: null, checked_at: "x", error: "unreachable" } })!;
    assert.equal(carrierFlow(down).release, "failed");
});
