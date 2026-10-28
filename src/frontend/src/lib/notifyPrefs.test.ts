import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMine, applyMute, cellChip, groupEvents, hasOverride, muteCovers, notificationKind, notificationTunnel, notifyFlow, parsePrefs, resolveNotify, shouldShow, type NotifyEvent, type NotifyPrefs } from "./notifyPrefs.ts";

const ev = (event: string, over: Partial<NotifyEvent> = {}): NotifyEvent => ({
    event,
    group: "device",
    audience: "tunnel",
    tunnel: true,
    status: false,
    channels: ["toast", "desktop"],
    locked: false,
    site: { toast: null, desktop: null },
    mine: { toast: null, desktop: null },
    ...over,
});

test("layers resolve like the backend: locked > mute > mine > site > built-in", () => {
    assert.deepEqual(resolveNotify(ev("tunnel.ip_changed"), "toast"), { on: true, source: "builtin" });
    assert.deepEqual(resolveNotify(ev("x", { site: { toast: false } }), "toast"), { on: false, source: "site" });
    assert.deepEqual(resolveNotify(ev("x", { site: { toast: false }, mine: { toast: true } }), "toast"), { on: true, source: "mine" });
    assert.deepEqual(resolveNotify(ev("x", { mine: { toast: true } }), "toast", "all"), { on: false, source: "muted" });
    assert.deepEqual(resolveNotify(ev("x", { locked: true, site: { toast: false }, mine: { toast: false } }), "toast", "all"), { on: true, source: "locked" });
});

test("mutes cover tunnel events only; status mutes only status events", () => {
    assert.equal(muteCovers("all", { tunnel: true, status: false }), true);
    assert.equal(muteCovers("status", { tunnel: true, status: false }), false);
    assert.equal(muteCovers("status", { tunnel: true, status: true }), true);
    assert.equal(muteCovers("all", { tunnel: false, status: false }), false);
    assert.equal(muteCovers(null, { tunnel: true, status: true }), false);
});

test("shouldShow: unknown, unlisted or missing channels are never gated", () => {
    const prefs: NotifyPrefs = { events: [ev("tunnel.ip_changed", { mine: { toast: false } }), ev("tunnel.online", { status: true, channels: ["desktop"] })], mutes: [{ tunnel_id: 7, tunnel_name: "dev", scope: "status" }] };
    assert.equal(shouldShow(null, "tunnel.ip_changed", "toast"), true);
    assert.equal(shouldShow(prefs, null, "toast"), true);
    assert.equal(shouldShow(prefs, "session.started", "toast"), true);
    assert.equal(shouldShow(prefs, "tunnel.ip_changed", "toast"), false);
    assert.equal(shouldShow(prefs, "tunnel.ip_changed", "desktop"), true);
    assert.equal(shouldShow(prefs, "tunnel.online", "toast"), true, "no toast channel → not gated");
    assert.equal(shouldShow(prefs, "tunnel.online", "desktop", 7), false, "status mute");
    assert.equal(shouldShow(prefs, "tunnel.online", "desktop", 8), true);
});

test("notification actions map to catalogue events", () => {
    assert.equal(notificationKind({ action: "UPDATE-TUNNEL-STATUS", status: "connected" }), "tunnel.online");
    assert.equal(notificationKind({ action: "UPDATE-TUNNEL-STATUS", status: "disconnected" }), "tunnel.offline");
    assert.equal(notificationKind({ action: "UPDATE-TUNNEL-HEALTH", health: "degraded" }), "tunnel.degraded");
    assert.equal(notificationKind({ action: "HOST-KEY-CHANGED" }), "tunnel.host_key_changed");
    assert.equal(notificationKind({ action: "TUNNEL-SHARED" }), "share.received");
    assert.equal(notificationKind({ action: "SIGN-IN-NEW-DEVICE" }), "account.sign_in_new_device");
    assert.equal(notificationKind({ action: "TERMINAL-WATCHED", watching: false }), null);
    assert.equal(notificationKind({ action: "TERMINAL-WATCHED", watching: true }), "session.watched");
    // 只是刷新用的不擋。/ Refresh-only notifications are never gated.
    for (const action of ["UPDATED-TUNNELS", "UPDATE-TUNNEL-LATENCY", "DEVICE-KEYS-UPDATED", "SESSION-ENDED", "WEBHOOK-PAUSED"]) {
        assert.equal(notificationKind({ action }), null, action);
    }
    assert.equal(notificationTunnel({ tunnel_id: 3 }), 3);
    assert.equal(notificationTunnel({ tunnel_id: "3" }), null);
});

test("cell chips, overrides and grouping", () => {
    assert.equal(cellChip(ev("x", { locked: true, mine: { toast: true } }), "toast"), "locked");
    assert.equal(cellChip(ev("x", { mine: { toast: false } }), "toast"), "overrides");
    assert.equal(cellChip(ev("x"), "toast"), "follows");
    assert.equal(hasOverride(ev("x")), false);
    assert.equal(hasOverride(ev("x", { mine: { desktop: true } })), true);
    const g = groupEvents([ev("a", { group: "account" }), ev("b", { group: "status" }), ev("c", { group: "status" })], ["status", "device", "account"]);
    assert.deepEqual(g.map((x) => [x.group, x.events.map((e) => e.event)]), [["status", ["b", "c"]], ["account", ["a"]]]);
});

test("local updates and parsing", () => {
    const p: NotifyPrefs = { events: [ev("a")], mutes: [] };
    assert.equal(applyMine(p, "a", "toast", false).events[0].mine?.toast, false);
    const m = applyMute(applyMute(p, 2, "zeta", "all"), 1, "alpha", "status");
    assert.deepEqual(m.mutes.map((x) => x.tunnel_name), ["alpha", "zeta"]);
    assert.deepEqual(applyMute(m, 2, "zeta", null).mutes.map((x) => x.tunnel_id), [1]);
    assert.equal(parsePrefs({ nope: 1 }), null);
    assert.deepEqual(parsePrefs({ events: [] }), { events: [], mutes: [] });
});

test("the diagram marks the deciding layer", () => {
    // 我的覆寫贏過全站的關。/ My override beats the site's off.
    let f = notifyFlow(ev("x", { site: { toast: false }, mine: { toast: true } }), "toast");
    assert.deepEqual([f.site.role, f.mine.role, f.tunnel.role, f.result.on], ["overridden", "decides", "unset", true]);
    // 什麼都沒設：內建。/ Nothing set: built-in.
    f = notifyFlow(ev("x"), "toast");
    assert.deepEqual([f.site.role, f.mine.role, f.result.source], ["unset", "unset", "builtin"]);
    // 靜音蓋過我的開。/ A mute beats my on.
    f = notifyFlow(ev("x", { mine: { toast: true } }), "toast", "all");
    assert.deepEqual([f.mine.role, f.tunnel.value, f.tunnel.role, f.result.on], ["overridden", "muted", "decides", false]);
    // 強制：全站決定，後面跳過。/ Enforced: the site decides, the rest is skipped.
    f = notifyFlow(ev("x", { locked: true, mine: { toast: false } }), "toast", "all");
    assert.deepEqual([f.site.value, f.site.role, f.mine.role, f.tunnel.role, f.result.on], ["locked", "decides", "skipped", "skipped", true]);
    // 沒有這個管道。/ No such channel.
    assert.equal(notifyFlow(ev("x", { channels: ["desktop"] }), "toast").noChannel, true);
});
