import { test } from "node:test";
import assert from "node:assert/strict";
import {
    bannerLifetime,
    countByFilter,
    countdown,
    coversTunnel,
    decisionPath,
    dropRequest,
    flipOffHere,
    formatWait,
    matchesFilter,
    newRuleInput,
    nextBanner,
    parseTerminalFrame,
    pickableIds,
    ruleCoverage,
    ruleLayers,
    ruleSource,
    ruleToInput,
    secondsLeft,
    showsInCenter,
    timeoutChoices,
    tunnelPickable,
    upsertRequest,
    verdictToDraw,
} from "./commandRules.ts";
import type { CheckVerdict, CommandRequest, CommandRule, MatchedRule, ScopeVerdict } from "../types/commandRules.ts";

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
    rule: { id: 3, scope: "personal", kind: "command", pattern: "sudo", note: "" },
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
    let p = decisionPath({ action: "block", rule: rule({}), site: { hit: rule({}), allowed_by: null, exempted: false }, personal: none });
    assert.equal(p.outcome, "block");
    assert.equal(p.site, "block");
    assert.equal(p.personal, "none");
    assert.equal(p.decidedBy, "site");
    assert.equal(p.approvers, null);
    // 全站被豁免、個人規則要核准 → 要核准，核准人是隧道的擁有者 + Admin。/ Site exempted, personal approve → approve by default approvers.
    const sudo = rule({ id: 3, scope: "personal", pattern: "sudo", action: "approve", owner: { id: 1, username: "alice" } });
    p = decisionPath({
        action: "approve",
        rule: sudo,
        allowed_by: null,
        site: { hit: rule({}), allowed_by: rule({ id: 2, action: "allow", pattern: "rm -rf /tmp/*" }), exempted: true },
        personal: { hit: sudo, allowed_by: null, exempted: false },
        approvers: { default: true, users: [{ id: 1, username: "alice" }, { id: 4, username: "carol" }] },
    });
    assert.equal(p.outcome, "approve");
    assert.equal(p.site, "exempted");
    assert.equal(p.personal, "approve");
    assert.equal(p.decidedBy, "personal");
    assert.deepEqual(p.approvers, { byDefault: true, names: ["alice", "carol"] });
    // 放行是因為允許規則。/ Allowed thanks to an allow rule.
    const allow = rule({ id: 2, action: "allow", pattern: "rm -rf /tmp/*" });
    p = decisionPath({ action: "allow", rule: null, allowed_by: allow, site: { hit: rule({}), allowed_by: allow, exempted: true }, personal: { hit: null, allowed_by: rule({ id: 9, scope: "personal", action: "allow", pattern: "rm" }), exempted: false } });
    assert.equal(p.outcome, "allow");
    assert.equal(p.site, "exempted");
    assert.equal(p.personal, "allowOnly");
    assert.equal(p.decidedBy, null);
    assert.equal(p.allowedBy?.id, 2);
    assert.equal(p.scopes.site.hit?.pattern, "rm -rf");
    assert.equal(p.scopes.personal.allowedBy?.id, 9);
    // 規則指定的核准人；舊格式只亮決定的那格（「只有我」與升級前的隧道規則都算個人）。
    // A rule's own approvers; an older verdict lights only the deciding box ("only me" and pre-upgrade tunnel rules count as personal).
    p = decisionPath({ action: "approve", rule: { ...sudo, scope: "tunnel" }, approvers: { default: false, users: [{ id: 4, username: "carol" }] } });
    assert.equal(p.personal, "approve", "an older verdict lights only the deciding scope");
    assert.equal(p.site, "none");
    assert.equal(p.scopes.personal.hit?.id, 3);
    assert.deepEqual(p.approvers, { byDefault: false, names: ["carol"] });
    p = decisionPath({ action: "block", rule: rule({ scope: "self" }), site: none, tunnel: { hit: rule({ scope: "self" }), allowed_by: null, exempted: false } });
    assert.equal(p.decidedBy, "personal");
    assert.equal(p.personal, "block", "a pre-upgrade backend's tunnel verdict is the personal box");
    // 什麼都沒符合。/ Nothing matched.
    p = decisionPath({ action: "allow", rule: null, site: none, personal: none });
    assert.deepEqual([p.outcome, p.site, p.personal, p.decidedBy, p.allowedBy], ["allow", "none", "none", null, null]);
});

test("rule source: site, mine, someone's, unknown", () => {
    assert.deepEqual(ruleSource({ scope: "site" }, 1), { key: "commands.matchedSiteRule" });
    assert.deepEqual(ruleSource({ scope: "self" }, 1), { key: "commands.matchedOwnRule" });
    assert.deepEqual(ruleSource({ scope: "personal", owner: { id: 1, username: "alice" } }, 1), { key: "commands.matchedOwnRule" });
    assert.deepEqual(ruleSource({ scope: "personal", owner: { id: 2, username: "bob" } }, 1), { key: "commands.matchedRuleBy", name: "bob" });
    assert.deepEqual(ruleSource({ scope: "tunnel" }, 1), { key: "commands.matchedPersonalRule" });
});

test("rule reach: every tunnel of which kind, or the listed ones", () => {
    const base: CommandRule = {
        id: 1,
        scope: "personal",
        owner: { id: 1, username: "alice" },
        mine: true,
        all_tunnels: true,
        tunnels: [],
        hidden_tunnels: 0,
        action: "block",
        kind: "command",
        pattern: "reboot",
        who: "everyone",
        via: "all",
        note: "",
        enabled: true,
        approver_ids: [],
        approvers: [],
        created_at: "",
        updated_at: "",
        mode: "default",
        approval_timeout: null,
    };
    assert.deepEqual(ruleCoverage(base), { kind: "every", whose: "managed" });
    assert.deepEqual(ruleCoverage({ ...base, who: "me" }), { kind: "every", whose: "used" });
    assert.deepEqual(ruleCoverage({ ...base, mine: false }), { kind: "every", whose: "theirs" });
    assert.deepEqual(ruleCoverage({ ...base, scope: "site", owner: null, mine: false }), { kind: "every", whose: "site" });
    const some = { ...base, all_tunnels: false, tunnels: [{ id: 7, name: "box", applies: true }, { id: 8, name: "nas", applies: false }], hidden_tunnels: 2 };
    assert.deepEqual(ruleCoverage(some), { kind: "some", tunnels: [{ id: 7, name: "box", applies: true }, { id: 8, name: "nas", applies: false }], hidden: 2 });
    assert.equal(coversTunnel(some, 8), true);
    assert.equal(coversTunnel(some, 9), false);
    assert.equal(coversTunnel(base, 9), true);
    // 表單：新規則從畫面上的隧道開始；管別人的規則只能勾自己管的。/ The form: start from the tunnel on screen; others-rules only on managed tunnels.
    assert.deepEqual(newRuleInput(7).tunnel_ids, [7]);
    assert.equal(newRuleInput(null).all_tunnels, true);
    assert.deepEqual(ruleToInput(some).tunnel_ids, [7, 8]);
    const choices = [{ id: 7, name: "box", manage: true }, { id: 8, name: "nas", manage: false }];
    assert.equal(tunnelPickable(choices[1], "everyone", false, false), false);
    assert.equal(tunnelPickable(choices[1], "me", false, false), true);
    assert.equal(tunnelPickable(choices[1], "sharees", true, false), true, "site rules take any tunnel");
    assert.equal(tunnelPickable(choices[1], "everyone", false, true), true, "already on the rule");
    assert.deepEqual(pickableIds([7, 8, 99], choices, "everyone", false, []), [7]);
    assert.deepEqual(pickableIds([7, 8, 99], choices, "me", false, [99]), [7, 8, 99]);
});

test("verdictToDraw follows whether you approve", () => {
    const v = (action: CheckVerdict["action"]): CheckVerdict => ({ action, rule: null });
    const base = { commands: [], for_approvers: v("allow"), for_sharees: v("approve") };
    assert.equal(verdictToDraw({ ...base, you_approve: true }).action, "allow");
    assert.equal(verdictToDraw({ ...base, you_approve: false }).action, "approve");
});

test("who decides: locked, turned off here, muted, and the result", () => {
    const base: CommandRule = {
        id: 1,
        scope: "site",
        owner: null,
        mine: false,
        all_tunnels: true,
        tunnels: [],
        hidden_tunnels: 0,
        action: "approve",
        kind: "command",
        pattern: "sudo",
        who: "everyone",
        via: "all",
        note: "",
        enabled: true,
        approver_ids: [],
        approvers: [],
        created_at: "",
        updated_at: "",
        mode: "default",
        approval_timeout: null,
        my_override: { off: null, muted: false },
    };
    const here = { tunnelId: 7, managesSome: true };
    // 強制：第二、三層都鎖住，結果生效。/ Enforced: layers 2 and 3 are locked.
    let l = ruleLayers({ ...base, mode: "enforced", action: "warn" }, here);
    assert.deepEqual([l.source, l.tunnel.state, l.me.state, l.result], [{ kind: "site", locked: true }, "locked", "locked", "applies"]);
    // 允許覆寫、在這裡被關掉。/ Overridable and turned off here.
    l = ruleLayers({ ...base, off_here: [{ id: 2, username: "alice" }] }, here);
    assert.deepEqual(l.tunnel, { state: "off", by: ["alice"] });
    assert.equal(l.result, "off");
    assert.equal(l.me.state, "na", "only reminders can be muted");
    // 提醒被我靜音。/ A reminder I muted.
    l = ruleLayers({ ...base, action: "warn", my_override: { off: null, muted: true } }, here);
    assert.deepEqual([l.tunnel.state, l.me.state, l.result], ["follows", "muted", "muted"]);
    // 沒選隧道：我的隧道全部 / 幾條 / 沒有（我沒管任何隧道）。/ No tunnel: all / some / none of mine.
    const none = { tunnelId: null, managesSome: true };
    assert.equal(ruleLayers({ ...base, my_override: { off: { all_tunnels: true, tunnels: [] }, muted: false } }, none).result, "offOnMine");
    assert.deepEqual(ruleLayers({ ...base, my_override: { off: { all_tunnels: false, tunnels: [{ id: 7, name: "box" }] }, muted: false } }, none).tunnel, { state: "mineSome", count: 1 });
    assert.deepEqual(ruleLayers(base, { tunnelId: null, managesSome: false }).tunnel, { state: "mineNone", canChange: false });
    // 個人規則與例外：第二層不適用；沒套用到這條隧道。/ Personal rules and exceptions; a rule not covering the tunnel.
    assert.equal(ruleLayers({ ...base, scope: "personal", owner: { id: 3, username: "bob" } }, here).tunnel.state, "na");
    assert.equal(ruleLayers({ ...base, action: "allow" }, here).tunnel.state, "na");
    assert.equal(ruleLayers({ ...base, all_tunnels: false, tunnels: [{ id: 8, name: "nas" }] }, here).result, "notHere");
});

test("turning a site rule off on one tunnel keeps the rest of mine", () => {
    assert.deepEqual(flipOffHere(null, 7, [7, 8], true), { all_tunnels: false, tunnel_ids: [7] });
    assert.equal(flipOffHere({ all_tunnels: false, tunnels: [{ id: 7 }] }, 7, [7, 8], false), null);
    assert.deepEqual(flipOffHere({ all_tunnels: true, tunnels: [] }, 7, [7, 8, 9], false), { all_tunnels: false, tunnel_ids: [8, 9] });
    assert.deepEqual(flipOffHere({ all_tunnels: true, tunnels: [] }, 7, [7, 8], true), { all_tunnels: true, tunnel_ids: [] });
    assert.deepEqual(flipOffHere({ all_tunnels: false, tunnels: [{ id: 8 }] }, 7, [7, 8], true), { all_tunnels: false, tunnel_ids: [7, 8] });
    assert.deepEqual(timeoutChoices(300), [60, 120, 300]);
    assert.equal(formatWait(300, "en"), "5 minutes");
    assert.equal(formatWait(3600, "en"), "1 hour");
});

test("a reminder banner and the decision path", () => {
    const rule = { id: 5, scope: "site" as const, kind: "command" as const, pattern: "systemctl restart", note: "Tell #ops", action: "warn" as const };
    const b = nextBanner(null, { type: "command", state: "warned", command: "systemctl restart nginx", rule });
    assert.equal(b.state, "warned");
    assert.equal(b.rule?.id, 5);
    assert.equal(bannerLifetime("warned"), 15000);
    const p = decisionPath({ action: "warn", rule, site: { hit: rule, allowed_by: null, exempted: false } });
    assert.deepEqual([p.outcome, p.site, p.decidedBy], ["warn", "warn", "site"]);
});

