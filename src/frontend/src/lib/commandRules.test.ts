import { test } from "node:test";
import assert from "node:assert/strict";
import { bannerLifetime, countByFilter, countdown, decisionPath, dropRequest, matchesFilter, nextBanner, parseTerminalFrame, secondsLeft, showsInCenter, upsertRequest, verdictToDraw } from "./commandRules.ts";
import type { CheckVerdict, CommandRequest, MatchedRule, ScopeVerdict } from "../types/commandRules.ts";

const req = (over: Partial<CommandRequest> = {}): CommandRequest => ({
    id: 1,
    tunnel_id: 7,
    tunnel_name: "box",
    user: { id: 2, username: "bob" },
    source: "terminal",
    client: null,
    account: "ubuntu",
    lan_host: null,
    command: "sudo ls",
    rule: { id: 3, scope: "tunnel", kind: "command", pattern: "sudo", note: "" },
    status: "pending",
    created_at: "2026-10-24T01:00:00Z",
    expires_at: "2026-10-24T01:05:00Z",
    decided_by: null,
    decided_at: null,
    reason: "",
    used: false,
    ...over,
});

test("terminal binary frames: pong, command notices, junk", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    assert.equal(parseTerminalFrame(enc("pong")), "pong");
    const n = parseTerminalFrame(enc(JSON.stringify({ type: "command", state: "blocked", command: "reboot", rule: { pattern: "reboot" } })));
    assert.ok(n && n !== "pong" && n.state === "blocked");
    assert.equal(parseTerminalFrame(enc("{nope")), null);
    assert.equal(parseTerminalFrame(enc(JSON.stringify({ type: "other" }))), null);
    assert.equal(parseTerminalFrame(enc("pong").buffer as ArrayBuffer), "pong");
});

test("the approval center shows what I can decide, except my own terminal commands", () => {
    assert.equal(showsInCenter(req(), 1, [1]), true);
    assert.equal(showsInCenter(req(), 1, [5]), false);
    assert.equal(showsInCenter(req({ can_decide: true }), 1, undefined), true);
    assert.equal(showsInCenter(req({ status: "approved" }), 1, [1]), false);
    assert.equal(showsInCenter(req({ user: { id: 1, username: "me" } }), 1, [1]), false, "my own terminal command: the banner handles it");
    assert.equal(showsInCenter(req({ user: { id: 1, username: "me" }, source: "agent" }), 1, [1]), true, "my own agent still needs my click");
    assert.equal(showsInCenter(req(), undefined, [1]), false);
});

test("upsert keeps one row per id, newest first; drop removes", () => {
    let list = upsertRequest([], req({ id: 1 }));
    list = upsertRequest(list, req({ id: 3 }));
    list = upsertRequest(list, req({ id: 1, command: "sudo ls -la" }));
    assert.deepEqual(list.map((r) => r.id), [3, 1]);
    assert.equal(list[1].command, "sudo ls -la");
    assert.deepEqual(dropRequest(list, 3).map((r) => r.id), [1]);
    assert.equal(dropRequest(list, 99), list, "unchanged list keeps its identity");
});

test("countdowns", () => {
    const now = Date.parse("2026-10-24T01:00:00Z");
    assert.equal(secondsLeft("2026-10-24T01:04:05Z", now), 245);
    assert.equal(secondsLeft("2026-10-24T00:59:00Z", now), 0);
    assert.equal(secondsLeft(null, now), null);
    assert.equal(countdown(245), "4:05");
    assert.equal(countdown(3723), "1:02:03");
    assert.equal(countdown(-3), "0:00");
});

test("history filter", () => {
    const list = [req({ status: "blocked" }), req({ status: "pending" }), req({ status: "approved" }), req({ status: "denied" }), req({ status: "expired" }), req({ status: "cancelled" })];
    assert.deepEqual(countByFilter(list), { all: 6, pending: 1, blocked: 1, approved: 1, notRun: 3 });
    assert.equal(matchesFilter(req({ status: "expired" }), "notRun"), true);
    assert.equal(matchesFilter(req({ status: "approved" }), "notRun"), false);
});

test("the terminal banner carries the command from pending to its outcome", () => {
    const rule = { id: 3, scope: "tunnel" as const, kind: "command" as const, pattern: "sudo", note: "why" };
    const pending = nextBanner(null, { type: "command", state: "pending", command: "sudo ls", rule, request: req({ id: 9 }), can_decide: false });
    assert.equal(pending.state, "pending");
    assert.equal(pending.requestId, 9);
    assert.equal(pending.expiresAt, "2026-10-24T01:05:00Z");
    const denied = nextBanner(pending, { type: "command", state: "denied", request_id: 9, by: "alice", reason: "no" });
    assert.equal(denied.command, "sudo ls");
    assert.equal(denied.rule?.pattern, "sudo");
    assert.equal(denied.by, "alice");
    assert.equal(denied.reason, "no");
    const other = nextBanner(pending, { type: "command", state: "approved", request_id: 10, by: "alice", reason: null });
    assert.equal(other.command, "", "an outcome for another request does not borrow this one's command");
    const blocked = nextBanner(denied, { type: "command", state: "blocked", command: "reboot", rule });
    assert.equal(blocked.requestId, null);
    assert.equal(bannerLifetime("pending"), null);
    assert.equal(bannerLifetime("approved"), 4000);
});

test("decision path: which scope decided, exemptions, approvers", () => {
    const rule = (over: Partial<MatchedRule>): MatchedRule => ({ id: 1, scope: "site", kind: "command", pattern: "rm -rf", note: "", action: "block", ...over });
    const none: ScopeVerdict = { hit: null, allowed_by: null, exempted: false };
    // 全站擋下 / A site block.
    let p = decisionPath({ action: "block", rule: rule({}), site: { hit: rule({}), allowed_by: null, exempted: false }, tunnel: none });
    assert.equal(p.outcome, "block");
    assert.equal(p.site, "block");
    assert.equal(p.tunnel, "none");
    assert.equal(p.decidedBy, "site");
    assert.equal(p.approvers, null);
    // 全站被豁免、隧道要核准 → 要核准，核准人是隧道的擁有者 + Admin。/ Site exempted, tunnel approve → approve by default approvers.
    const sudo = rule({ id: 3, scope: "tunnel", pattern: "sudo", action: "approve" });
    p = decisionPath({
        action: "approve",
        rule: sudo,
        allowed_by: null,
        site: { hit: rule({}), allowed_by: rule({ id: 2, action: "allow", pattern: "rm -rf /tmp/*" }), exempted: true },
        tunnel: { hit: sudo, allowed_by: null, exempted: false },
        approvers: { default: true, users: [{ id: 1, username: "alice" }, { id: 4, username: "carol" }] },
    });
    assert.equal(p.outcome, "approve");
    assert.equal(p.site, "exempted");
    assert.equal(p.tunnel, "approve");
    assert.equal(p.decidedBy, "tunnel");
    assert.deepEqual(p.approvers, { byDefault: true, names: ["alice", "carol"] });
    // 放行是因為允許規則。/ Allowed thanks to an allow rule.
    const allow = rule({ id: 2, action: "allow", pattern: "rm -rf /tmp/*" });
    p = decisionPath({ action: "allow", rule: null, allowed_by: allow, site: { hit: rule({}), allowed_by: allow, exempted: true }, tunnel: { hit: null, allowed_by: rule({ id: 9, scope: "tunnel", action: "allow", pattern: "rm" }), exempted: false } });
    assert.equal(p.outcome, "allow");
    assert.equal(p.site, "exempted");
    assert.equal(p.tunnel, "allowOnly");
    assert.equal(p.decidedBy, null);
    assert.equal(p.allowedBy?.id, 2);
    assert.equal(p.scopes.site.hit?.pattern, "rm -rf");
    assert.equal(p.scopes.tunnel.allowedBy?.id, 9);
    // 規則指定的核准人。/ A rule's own approvers.
    p = decisionPath({ action: "approve", rule: sudo, approvers: { default: false, users: [{ id: 4, username: "carol" }] } });
    assert.equal(p.tunnel, "approve", "an older verdict lights only the deciding scope");
    assert.equal(p.site, "none");
    assert.equal(p.scopes.tunnel.hit?.id, 3);
    assert.deepEqual(p.approvers, { byDefault: false, names: ["carol"] });
    // 什麼都沒符合。/ Nothing matched.
    p = decisionPath({ action: "allow", rule: null, site: none, tunnel: none });
    assert.deepEqual([p.outcome, p.site, p.tunnel, p.decidedBy, p.allowedBy], ["allow", "none", "none", null, null]);
});

test("verdictToDraw follows whether you approve", () => {
    const v = (action: CheckVerdict["action"]): CheckVerdict => ({ action, rule: null });
    const base = { commands: [], for_approvers: v("allow"), for_sharees: v("approve") };
    assert.equal(verdictToDraw({ ...base, you_approve: true }).action, "allow");
    assert.equal(verdictToDraw({ ...base, you_approve: false }).action, "approve");
});
