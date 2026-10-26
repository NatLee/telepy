import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFormat, effectiveFormat, errorKey, groupCatalog, hasStatusEvent, hasTunnelEvent, hookState, maskUrl, orderEvents, presetEvents, presetsFor, prettyBody, sameEvents } from "./webhooks.ts";
import type { CatalogEvent } from "../types/webhooks.ts";

const ev = (event: string, group: CatalogEvent["group"], over: Partial<CatalogEvent> = {}): CatalogEvent => ({
    event,
    group,
    audience: "tunnel",
    status: group === "status",
    tunnel: group !== "account" && group !== "admin",
    severity: "info",
    ...over,
});

const personal: CatalogEvent[] = [
    ev("tunnel.offline", "status"),
    ev("tunnel.online", "status"),
    ev("tunnel.degraded", "status"),
    ev("tunnel.recovered", "status"),
    ev("tunnel.ip_changed", "device"),
    ev("share.received", "sharing"),
    ev("access.requested", "sharing"),
    ev("command.approval_requested", "commands"),
    ev("account.sign_in", "account"),
];
const site: CatalogEvent[] = [ev("tunnel.offline", "status"), ev("tunnel.ip_changed", "device"), ev("user.created", "admin")];

test("services are recognised from the URL like the backend does", () => {
    assert.equal(detectFormat("https://hooks.slack.com/services/T0/B0/x"), "slack");
    assert.equal(detectFormat("https://discord.com/api/webhooks/1/abc"), "discord");
    assert.equal(detectFormat("https://canary.discord.com/api/webhooks/1/abc"), "discord");
    assert.equal(detectFormat("https://discord.com/channels/1"), "json");
    assert.equal(detectFormat("https://chat.googleapis.com/v1/spaces/X/messages?key=k"), "google_chat");
    assert.equal(detectFormat("https://prod-01.westus.logic.azure.com/workflows/x"), "teams");
    assert.equal(detectFormat("https://api.telegram.org/bot1:x/sendMessage?chat_id=1"), "telegram");
    assert.equal(detectFormat("https://ntfy.sh/my-topic"), "ntfy");
    assert.equal(detectFormat("https://evilhooks.slack.com.example.com/x"), "json");
    assert.equal(detectFormat("ftp://example.com"), null);
    assert.equal(detectFormat("not a url"), null);
    assert.equal(effectiveFormat("auto", "https://ntfy.sh/x"), "ntfy");
    assert.equal(effectiveFormat("discord", "https://example.com"), "discord");
    assert.equal(effectiveFormat("auto", "garbage"), "json");
});

test("catalogue groups and presets", () => {
    assert.deepEqual(groupCatalog(personal).map((g) => g.group), ["status", "device", "sharing", "commands", "account"]);
    assert.deepEqual(presetsFor(personal), ["status", "security", "approvals", "all"]);
    assert.deepEqual(presetsFor(site), ["status", "security", "all"], "no approvals on the site catalogue");
    assert.deepEqual(presetEvents("security", personal), ["tunnel.ip_changed", "account.sign_in"]);
    assert.deepEqual(presetEvents("security", site), ["tunnel.ip_changed", "user.created"]);
    assert.equal(presetEvents("all", personal).length, personal.length);
    assert.ok(sameEvents(["a", "b"], ["b", "a"]));
    assert.ok(!sameEvents(["a"], ["a", "b"]));
    assert.deepEqual(orderEvents(["share.received", "bogus", "tunnel.offline"], personal), ["tunnel.offline", "share.received"]);
});

test("status and tunnel events decide which fields the form shows", () => {
    assert.ok(hasStatusEvent(["tunnel.online"], personal));
    assert.ok(!hasStatusEvent(["share.received"], personal));
    assert.ok(hasTunnelEvent(["share.received"], personal));
    assert.ok(!hasTunnelEvent(["account.sign_in"], personal), "account events have no tunnel");
});

test("card state", () => {
    assert.equal(hookState({ enabled: false, paused_reason: "failing", last: null }), "paused");
    assert.equal(hookState({ enabled: false, paused_reason: null, last: null }), "off");
    assert.equal(hookState({ enabled: true, paused_reason: null, last: null }), "never");
    assert.equal(hookState({ enabled: true, paused_reason: null, last: { status: "failed", at: null, http_status: 500, error: "HTTP 500" } }), "failing");
    assert.equal(hookState({ enabled: true, paused_reason: null, last: { status: "ok", at: null, http_status: 204, error: "" } }), "ok");
});

test("urls are masked and bodies pretty-printed", () => {
    assert.equal(maskUrl("https://hooks.slack.com/services/T0123456789/B0123456789/abcdefghijklmnop"), "hooks.slack.com/services/T01…/B01…/abc…");
    assert.equal(maskUrl("https://ntfy.sh/alerts"), "ntfy.sh/alerts");
    assert.equal(maskUrl("https://chat.googleapis.com/v1/spaces/X/messages?key=secret"), "chat.googleapis.com/v1/spaces/X/messages?…");
    assert.equal(prettyBody('{"a":1}'), '{\n  "a": 1\n}');
    assert.equal(prettyBody("plain text"), "plain text");
    assert.equal(errorKey("private_target"), "webhooks.err.privateTarget");
    assert.equal(errorKey("nope"), null);
    assert.equal(errorKey(undefined), null);
});
