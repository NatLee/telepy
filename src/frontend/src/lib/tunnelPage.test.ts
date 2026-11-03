import { test } from "node:test";
import assert from "node:assert/strict";
import { TUNNEL_TABS, attentionItems, isTunnelPagePath, parseTunnelId, parseTunnelTab, tunnelPageUrl } from "./tunnelPage.ts";
import { en } from "../locales/en.ts";

test("tabs and URLs", () => {
    assert.equal(TUNNEL_TABS[0], "overview");
    assert.equal(parseTunnelTab(null), "overview");
    assert.equal(parseTunnelTab("connection"), "connection");
    assert.equal(parseTunnelTab("pigeon"), "overview");
    // 舊的詳細資訊分頁名稱。/ The old details dialog's tab names.
    assert.equal(parseTunnelTab("general"), "settings");
    assert.equal(parseTunnelTab("connections"), "history");
    assert.equal(tunnelPageUrl(12), "/tunnels/12");
    assert.equal(tunnelPageUrl(12, "overview"), "/tunnels/12");
    assert.equal(tunnelPageUrl(12, "access"), "/tunnels/12?tab=access");
    for (const tab of TUNNEL_TABS) assert.ok(`tunnelPage.tab.${tab}` in en, tab);
});

test("only positive integer ids", () => {
    assert.equal(parseTunnelId("12"), 12);
    assert.equal(parseTunnelId(["7"]), 7);
    for (const bad of ["0", "-1", "1.5", "abc", "12abc", "", undefined, null, "9999999999999"]) assert.equal(parseTunnelId(bad as string), null, String(bad));
});

test("a tunnel page path is /tunnels/<digits> only", () => {
    assert.equal(isTunnelPagePath("/tunnels/12"), true);
    assert.equal(isTunnelPagePath("/tunnels/12/"), true);
    for (const p of ["/tunnels", "/tunnels/keys", "/tunnels/12/x", "/tunnels/terminal"]) assert.equal(isTunnelPagePath(p), false, p);
});

test("the overview flags the most urgent things first, each with its tab", () => {
    assert.deepEqual(attentionItems({}), []);
    const all = attentionItems({ hostKeyChanged: true, degraded: true, deviceWarnings: 2, olderInstall: 1, nameOk: false, accessRequests: 3 });
    assert.deepEqual(all.map((a) => [a.kind, a.tab]), [
        ["host_key", "identity"],
        ["degraded", "device"],
        ["device_warning", "device"],
        ["older_install", "connection"],
        ["old_name", "settings"],
        ["access_requests", "access"],
    ]);
    // 機器是別人的就不再說主機金鑰；多出來的服務比舊名稱要緊。/ Claimed replaces the host-key line; an extra copy beats an old name.
    assert.deepEqual(attentionItems({ deviceClaimed: true, hostKeyChanged: true, extraInstall: 1, olderInstall: 2 }).map((a) => a.kind), ["claimed", "extra_install"]);
    for (const a of attentionItems({ deviceClaimed: true, degraded: true, deviceWarnings: 1, extraInstall: 1, nameOk: false, accessRequests: 1 })) assert.ok(a.key in en, a.key);
    assert.equal(attentionItems({ nameOk: true }).length, 0);
});
