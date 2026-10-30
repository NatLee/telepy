import { test } from "node:test";
import assert from "node:assert/strict";
import { liveTransport, matchesOs, matchesVia, platformOf, PLATFORMS, shortOs, wayInOf } from "./devicePlatforms.ts";

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

test("wayInOf: the actual way first, then how it was set up", () => {
    const w = (setup: "ssh" | "websocket" | "auto" | null, last: "ssh" | "websocket" | null, live = false, tls: boolean | null = null) => ({ way_in: { setup, last, live, tls } });
    assert.equal(wayInOf(null), null);
    assert.equal(wayInOf({}), null, "nothing known");
    assert.equal(wayInOf(w(null, null)), null);
    assert.deepEqual(wayInOf(w("ssh", "ssh", true)), { via: "ssh", state: "live", setup: null , auto: false });
    assert.deepEqual(wayInOf(w("websocket", "websocket", true, true)), { via: "wss", state: "live", setup: null , auto: false });
    assert.deepEqual(wayInOf(w("websocket", "websocket", false, false)), { via: "ws", state: "last", setup: null , auto: false }, "Telepy over http");
    assert.deepEqual(wayInOf(w("websocket", null)), { via: "wss", state: "setup", setup: null , auto: false }, "added, not connected yet");
    assert.deepEqual(wayInOf(w("websocket", null), false), { via: "ws", state: "setup", setup: null , auto: false }, "TLS unknown: Telepy's own scheme");
    assert.deepEqual(wayInOf(w("ssh", "websocket", true, true)), { via: "wss", state: "live", setup: "ssh" , auto: false }, "came in another way than set up");
    assert.deepEqual(wayInOf(w(null, "ssh")), { via: "ssh", state: "last", setup: null , auto: false }, "setup unknown");
    assert.equal(wayInOf(w("pigeon" as never, null)), null, "unknown values are ignored");
    // 自動：走哪種都不算跟設定不同；還沒連過時先試 SSH port。/ Automatic: either way matches; never connected = the SSH port first.
    assert.deepEqual(wayInOf(w("auto", "websocket", true, true)), { via: "wss", state: "live", setup: null, auto: true });
    assert.deepEqual(wayInOf(w("auto", "ssh", false)), { via: "ssh", state: "last", setup: null, auto: true });
    assert.deepEqual(wayInOf(w("auto", null)), { via: "ssh", state: "setup", setup: null, auto: true });
});

test("wayInOf falls back to endpoint.transport (older backend)", () => {
    const base = { ip: "1.2.3.4", connected_at: "x", last_seen_at: null };
    assert.deepEqual(wayInOf({ endpoint: { ...base, live: true, transport: "tcp" } }), { via: "ssh", state: "live", setup: null , auto: false });
    assert.deepEqual(wayInOf({ endpoint: { ...base, live: false, transport: "websocket" } }), { via: "wss", state: "last", setup: null , auto: false });
    assert.equal(wayInOf({ endpoint: { ...base, live: false, transport: null } }), null, "connected before the upgrade");
});

test("liveTransport and matchesVia", () => {
    assert.equal(liveTransport({ way_in: { setup: "ssh", last: "ssh", live: true, tls: null } }), "tcp");
    assert.equal(liveTransport({ way_in: { setup: "ssh", last: "websocket", live: true, tls: true } }), "websocket");
    assert.equal(liveTransport({ way_in: { setup: "ssh", last: "ssh", live: false, tls: null } }), null, "offline");
    assert.equal(liveTransport({ way_in: { setup: "websocket", last: null, live: false, tls: null } }), null, "never connected");
    const wss = { via: "wss" as const, state: "live" as const, setup: null, auto: false };
    const ws = { via: "ws" as const, state: "live" as const, setup: null, auto: false };
    const ssh = { via: "ssh" as const, state: "live" as const, setup: null, auto: false };
    assert.ok(matchesVia("ssh", ssh) && !matchesVia("ssh", wss));
    for (const q of ["wss", "ws", "http", "websocket", "web"]) assert.ok(matchesVia(q, wss) && matchesVia(q, ws) && !matchesVia(q, ssh), q);
    assert.ok(!matchesVia("ssh", null));
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
