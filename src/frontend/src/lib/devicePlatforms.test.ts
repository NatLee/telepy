import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesOs, platformOf, PLATFORMS, shortOs, viaOf } from "./devicePlatforms.ts";

test("platformOf reads the device facts", () => {
    assert.equal(platformOf(null), null);
    assert.equal(platformOf({}), null);
    assert.equal(platformOf({ os: "Ubuntu 24.04.1 LTS", kernel: "Linux 6.8.0-45-generic" }), "linux");
    assert.equal(platformOf({ os: "Alpine Linux v3.20" }), "linux");
    assert.equal(platformOf({ kernel: "Linux 5.15.0" }), "linux", "no os-release, kernel only");
    assert.equal(platformOf({ os: "macOS 15.1", kernel: "Darwin 24.1.0" }), "macos");
    assert.equal(platformOf({ os: null, kernel: "Darwin 23.0.0" }), "macos");
    assert.equal(platformOf({ os: "Microsoft Windows 11 Pro 10.0.22631", kernel: "Windows 10.0.22631" }), "windows");
    assert.equal(platformOf({ os: "OpenWrt 23.05.5", kernel: "Linux 5.15.167" }), "openwrt");
    assert.equal(platformOf({ os: "Raspbian GNU/Linux 11 (bullseye)" }), "raspberrypi");
    assert.equal(platformOf({ os: "Debian GNU/Linux 12 (bookworm)", cpu_model: "Raspberry Pi 4 Model B Rev 1.4" }), "raspberrypi");
    assert.equal(platformOf({ kernel: "FreeBSD 14.1-RELEASE" }), "unix");
    assert.equal(platformOf({ os: "FreeBSD 14.1-RELEASE", kernel: "FreeBSD 14.1-RELEASE" }), "unix");
});

test("shortOs keeps the name and major.minor", () => {
    assert.equal(shortOs("Ubuntu 24.04.1 LTS"), "Ubuntu 24.04");
    assert.equal(shortOs("Debian GNU/Linux 12 (bookworm)"), "Debian 12");
    assert.equal(shortOs("Microsoft Windows 11 Pro 10.0.22631"), "Windows 11 Pro");
    assert.equal(shortOs("macOS 15.1.1"), "macOS 15.1");
    assert.equal(shortOs("OpenWrt 23.05.5"), "OpenWrt 23.05");
    assert.equal(shortOs("  "), null);
    assert.equal(shortOs(null), null);
    assert.ok(shortOs("A very long distribution name that goes on and on")!.length <= 28);
});

test("viaOf maps the gateway transport", () => {
    assert.equal(viaOf(null), null);
    const base = { ip: "1.2.3.4", live: false, connected_at: "x", last_seen_at: null };
    assert.equal(viaOf({ ...base, transport: "tcp" }), "ssh");
    assert.equal(viaOf({ ...base, transport: "websocket" }), "http");
    assert.equal(viaOf({ ...base, transport: null }), null, "connected before the upgrade");
});

test("os:linux includes a Raspberry Pi", () => {
    assert.ok(matchesOs("linux", "raspberrypi"));
    assert.ok(!matchesOs("raspberrypi", "linux"));
    assert.ok(!matchesOs("linux", null));
});

test("every platform can be added one way or another", () => {
    for (const p of PLATFORMS) assert.ok(p.join !== "no" || p.scripts.length > 0, p.id);
    assert.equal(new Set(PLATFORMS.map((p) => p.id)).size, PLATFORMS.length);
});
