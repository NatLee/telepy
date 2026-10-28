import { test } from "node:test";
import assert from "node:assert/strict";
import { activeOptOuts, defaultInput, hookMode, optOutChoices, optOutPath, optedOutTunnelCount, toInput, detectFormat, effectiveFormat, errorKey, knownEventOrder, siteCoverage, siteHookState, sortSiteSummary, groupCatalog, hasStatusEvent, hasTunnelEvent, headerProblem, headersToSave, hookState, maskUrl, orderEvents, presetEvents, presetsFor, prettyBody, sameEvents } from "./webhooks.ts";
import type { CatalogEvent, SiteWebhookSummary, Webhook } from "../types/webhooks.ts";

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

test("custom headers follow the backend's rules", () => {
    const h = (name: string, value: string) => ({ name, value });
    const ok = h("Authorization", "Bearer abc");
    assert.equal(headerProblem(ok, [ok]), null);
    assert.equal(headerProblem(h("", ""), []), null, "a blank row is ignored");
    assert.equal(headerProblem(h("bad name", "x"), []), "webhooks.headers.badName");
    assert.equal(headerProblem(h("", "x"), []), "webhooks.headers.badName");
    assert.equal(headerProblem(h("Content-Type", "x"), []), "webhooks.headers.reserved");
    assert.equal(headerProblem(h("Webhook-Signature", "x"), []), "webhooks.headers.reserved");
    const a = h("X-A", "1");
    assert.equal(headerProblem(a, [a, h("x-a", "2")]), "webhooks.headers.duplicate");
    assert.equal(headerProblem(h("X-A", ""), []), "webhooks.headers.badValue");
    assert.equal(headerProblem(h("X-A", "中文"), []), "webhooks.headers.badValue");
    assert.equal(headerProblem(h("X-A", "a\nb"), []), "webhooks.headers.badValue");
    assert.deepEqual(headersToSave([h(" X-A ", "1"), h("", "")]), [h("X-A", "1")]);
});

const summary = (over: Partial<SiteWebhookSummary>): SiteWebhookSummary => ({
    id: 1,
    name: "Ops",
    service: "slack",
    events: [],
    all_tunnels: false,
    tunnels: [],
    hidden_tunnels: 0,
    enabled: true,
    paused: false,
    ...over,
});

test("site webhook coverage says which of my tunnels it reports on", () => {
    assert.deepEqual(siteCoverage(summary({ all_tunnels: true, hidden_tunnels: 0 })), { kind: "all" });
    assert.deepEqual(siteCoverage(summary({ tunnels: [{ id: 2, name: "a" }, { id: 3, name: "b" }], hidden_tunnels: 4 })), { kind: "some", names: ["a", "b"], hidden: 4 });
    assert.deepEqual(siteCoverage(summary({ hidden_tunnels: 2 })), { kind: "none", hidden: 2 });
});

test("site webhook state: paused wins, then on / off", () => {
    assert.equal(siteHookState({ enabled: false, paused: true }), "paused");
    assert.equal(siteHookState({ enabled: true, paused: false }), "on");
    assert.equal(siteHookState({ enabled: false, paused: false }), "off");
});

test("site webhooks sort running first, then by name", () => {
    const list = [summary({ id: 1, name: "b", enabled: false }), summary({ id: 2, name: "z" }), summary({ id: 3, name: "a", enabled: false, paused: true }), summary({ id: 4, name: "c" })];
    assert.deepEqual(sortSiteSummary(list).map((h) => h.id), [4, 2, 3, 1]);
});

test("events are ordered like the event table, unknown ones last", () => {
    assert.deepEqual(knownEventOrder(["user.created", "made.up", "tunnel.offline"]), ["tunnel.offline", "user.created", "made.up"]);
});

const siteHook = (over: Partial<SiteWebhookSummary> = {}): SiteWebhookSummary => ({
    id: 1,
    name: "Ops",
    service: "slack",
    events: ["tunnel.offline"],
    all_tunnels: true,
    tunnels: [],
    hidden_tunnels: 0,
    enabled: true,
    paused: false,
    mode: "default",
    my_optout: [],
    managed: [
        { id: 5, name: "box", opted_out: true, by: ["alice"], mine: true },
        { id: 6, name: "lab", opted_out: false, by: [], mine: false },
    ],
    ...over,
});

test("site webhooks are default unless enforced, older backends included", () => {
    assert.equal(hookMode({}), "default");
    assert.equal(hookMode({ mode: null }), "default");
    assert.equal(hookMode({ mode: "enforced" }), "enforced");
    assert.equal(defaultInput("site", "en").mode, "default");
    assert.equal(defaultInput("user", "en").mode, undefined, "personal webhooks don't send a mode");
    const hook = { scope: "site", mode: "enforced", name: "x", url: "", format: "auto", language: "en", events: [], all_tunnels: true, tunnels: [], delay: 0, enabled: true, headers: [] } as unknown as Webhook;
    assert.equal(toInput(hook).mode, "enforced");
    assert.equal(toInput({ ...hook, scope: "user" }).mode, undefined);
});

test("the opt-out path says whether an event goes out and which layer decided", () => {
    const opted = optOutPath(siteHook(), 5);
    assert.deepEqual([opted.sends, opted.layer, opted.by], [false, "optedOut", ["alice"]]);
    assert.equal(opted.spots.optout, "failed");
    assert.equal(opted.spots.channel, "waiting");
    const free = optOutPath(siteHook(), 6);
    assert.deepEqual([free.sends, free.layer], [true, "followsDefault"]);
    assert.equal(free.spots.channel, "ok");
    const locked = optOutPath(siteHook({ mode: "enforced" }), 5);
    assert.deepEqual([locked.sends, locked.layer, locked.by], [true, "locked", ["alice"]], "enforced ignores the opt-out but still says whose it was");
    assert.equal(optOutPath(siteHook({ enabled: false }), 6).layer, "off");
    assert.equal(optOutPath(siteHook({ paused: true }), 6).sends, false);
    const limited = siteHook({ all_tunnels: false, tunnels: [{ id: 9, name: "other" }], managed: [] });
    assert.equal(optOutPath(limited, 6).layer, "notCovered");
    assert.equal(optOutPath(limited, 9).layer, "followsDefault");
});

test("only default webhooks offer opt-out choices; counts use opt-outs that still count", () => {
    assert.equal(optOutChoices(siteHook()).length, 2);
    assert.deepEqual(optOutChoices(siteHook({ mode: "enforced" })), []);
    assert.deepEqual(optOutChoices({ mode: "default" }), [], "older backends: nothing to choose");
    const optouts = [
        { tunnel_id: 5, tunnel_name: "box", by: "alice", at: "", active: true },
        { tunnel_id: 5, tunnel_name: "box", by: "bob", at: "", active: true },
        { tunnel_id: 6, tunnel_name: "lab", by: "carol", at: "", active: false },
    ];
    assert.equal(activeOptOuts({ optouts }).length, 2);
    assert.equal(optedOutTunnelCount({ optouts }), 1, "box opted out twice is one tunnel; carol's no longer counts");
    assert.equal(optedOutTunnelCount({}), 0);
});
