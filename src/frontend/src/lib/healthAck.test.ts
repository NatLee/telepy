import { test } from "node:test";
import assert from "node:assert/strict";
import { ACK_NOTE_MAX, ackedChecks, ackedSummary, canAcknowledge, cardLook, classifyAckError, noteLength, noteProblem, tileTone } from "./healthAck.ts";
import { countStatuses, type HealthCheck, type HealthCheckId, type HealthStatus } from "./serverHealth.ts";

const ack = { by: "admin", at: "2026-10-30T02:00:00Z", note: "restored from a backup" };
const c = (id: HealthCheckId | null, status: HealthStatus, extra: Partial<HealthCheck> = {}): HealthCheck => ({
    id,
    name: id ?? "new",
    status,
    detail: "",
    fingerprint: "fp",
    checkedAt: null,
    ack: null,
    staleAck: null,
    ...extra,
});

test("card looks: plain, acknowledged, acknowledged earlier", () => {
    assert.equal(cardLook(c("guacd", "fail")), "plain");
    assert.equal(cardLook(c("guacd", "fail", { ack })), "acked");
    assert.equal(cardLook(c("guacd", "warn", { staleAck: ack })), "stale");
    // 變成正常之後就不提舊的確認。/ Once it passes, the old acknowledgement is not mentioned.
    assert.equal(cardLook(c("guacd", "ok", { staleAck: ack })), "plain");
    assert.equal(cardLook(c("guacd", "ok", { ack })), "plain", "only warnings and failures can be acknowledged");
});

test("who gets the Acknowledge button", () => {
    assert.equal(canAcknowledge(c("guacd", "fail")), true);
    assert.equal(canAcknowledge(c("guacd", "warn", { staleAck: ack })), true, "a changed result can be acknowledged again");
    assert.equal(canAcknowledge(c("guacd", "fail", { ack })), false);
    assert.equal(canAcknowledge(c("guacd", "info")), false);
    assert.equal(canAcknowledge(c("guacd", "ok")), false);
    assert.equal(canAcknowledge(c(null, "fail")), false, "unknown checks have no id to send");
    assert.equal(canAcknowledge(c("guacd", "fail", { fingerprint: "" })), false, "older backends send no fingerprint");
});

test("the overview's acknowledged line points at the worst one's tab", () => {
    const checks = [c("kasm", "warn", { ack }), c("audit_log", "fail", { ack }), c("guacd", "fail"), c("database", "ok")];
    assert.deepEqual(ackedChecks(checks).map((x) => x.id), ["audit_log", "kasm"]);
    assert.deepEqual(ackedSummary(checks), { count: 2, group: "storage" });
    assert.equal(ackedSummary([c("guacd", "fail")]), null);
});

test("tile tones: open problems win, acknowledged-only and notes-only are grey", () => {
    assert.equal(tileTone("fail", countStatuses([c("guacd", "fail"), c("kasm", "warn", { ack })])), "fail");
    assert.equal(tileTone("ok", countStatuses([c("guacd", "fail", { ack }), c("kasm", "ok")])), "info");
    assert.equal(tileTone("ok", countStatuses([c("geoip", "info")])), "info");
    assert.equal(tileTone("ok", countStatuses([])), "info");
    assert.equal(tileTone("ok", countStatuses([c("kasm", "ok"), c("geoip", "info")])), "ok");
});

test("the note must say something and fit", () => {
    assert.equal(noteProblem(""), "empty");
    assert.equal(noteProblem("   \n "), "empty");
    assert.equal(noteProblem("restored"), null);
    assert.equal(noteProblem("x".repeat(ACK_NOTE_MAX)), null);
    assert.equal(noteProblem("x".repeat(ACK_NOTE_MAX + 1)), "tooLong");
    // 中文 / emoji 一個字算一個。/ CJK and emoji count as one character each.
    assert.equal(noteLength("  還原備份😀 "), 5);
    assert.equal(noteProblem("😀".repeat(ACK_NOTE_MAX)), null);
});

test("server errors map to what the dialog does next", () => {
    assert.deepEqual(classifyAckError(403, { code: "reauth_required", methods: ["totp", 3, "passkey"] }), { kind: "reauth", methods: ["totp", "passkey"] });
    assert.deepEqual(classifyAckError(403, { code: "reauth_required" }), { kind: "reauth", methods: [] });
    assert.deepEqual(classifyAckError(409, { code: "changed", error: "x" }), { kind: "changed" });
    assert.deepEqual(classifyAckError(400, { code: "not_a_problem" }), { kind: "notAProblem" });
    assert.deepEqual(classifyAckError(400, { note: ["Too long."] }), { kind: "note", message: "Too long." });
    assert.deepEqual(classifyAckError(403, { error: "admin only", code: "admin_only" }), { kind: "other", message: "admin only" });
    assert.deepEqual(classifyAckError(500, null), { kind: "other", message: null });
    assert.deepEqual(classifyAckError(404, { detail: "Not found." }), { kind: "other", message: "Not found." });
});
