import { test } from "node:test";
import assert from "node:assert/strict";
import { canReseal, groupReseals, parseReseal, parseResealPlan, resealTotals, tableIssues } from "./auditReseal.ts";
import type { HealthCheck, HealthCheckId, HealthStatus } from "./serverHealth.ts";

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

const record = (id: string, table: string, at: string) => ({
    reseal_id: id,
    at,
    table,
    row_id: 7,
    rehashed: 5,
    from_row: 3,
    retired: 1,
    problem: `${table}: row 3 (hash_mismatch)`,
    user_id: 1,
    username: "admin",
    note: "restored",
});

const raw = {
    status: "fail",
    fingerprint: "abcdabcdabcdabcd",
    detail: "changed after it was written: …",
    can_reseal: true,
    anchors_file: true,
    tables: [
        { table: "telepy_gateway_event", ok: false, checked: 6, chain_broken_at: 3, chain_reason: "hash_mismatch", chain_issues: 1, checkpoint_broken_at: null, checkpoint_reason: null, checkpoints_mismatched: 0, problem: "telepy_gateway_event: row 3 (hash_mismatch)", rehash: 4, from_row: 3, retire: 1 },
        { table: "telepy_sign_in_event", ok: false, checked: 2, chain_broken_at: null, chain_reason: null, chain_issues: 0, checkpoint_broken_at: 1, checkpoint_reason: "checkpoint_mismatch", checkpoints_mismatched: 3, problem: "telepy_sign_in_event: checkpoint at row 1 (checkpoint_mismatch, 3 checkpoints)", rehash: 0, from_row: null, retire: 2 },
        { table: "telepy_ai_audit_event", ok: true, checked: 0, problem: null, rehash: 0, from_row: null, retire: 0 },
        { ok: false },
    ],
    reseals: [record("b", "telepy_gateway_event", "2026-10-30T05:00:00Z"), "junk", record("a", "telepy_sign_in_event", "2026-10-29T05:00:00Z")],
};

test("parses the dry run and drops what doesn't fit", () => {
    const p = parseResealPlan(raw);
    assert.ok(p);
    assert.equal(p.status, "fail");
    assert.equal(p.canReseal, true);
    assert.equal(p.tables.length, 3);
    assert.deepEqual(
        p.tables.map((t) => [t.table, t.ok, t.rehash, t.fromRow, t.retire]),
        [
            ["telepy_gateway_event", false, 4, 3, 1],
            ["telepy_sign_in_event", false, 0, null, 2],
            ["telepy_ai_audit_event", true, 0, null, 0],
        ],
    );
    assert.equal(p.reseals.length, 2);
    assert.equal(parseResealPlan(null), null);
    assert.equal(parseResealPlan({ tables: [] }), null);
    assert.equal(parseResealPlan({ fingerprint: "x", tables: [], status: "odd" })?.status, "info");
    assert.equal(parseReseal({ table: "t" }), null);
});

test("only a failing audit-log card offers a re-seal, acknowledged or not", () => {
    assert.equal(canReseal(c("audit_log", "fail")), true);
    assert.equal(canReseal(c("audit_log", "fail", { ack: { by: "a", at: "2026-10-30T00:00:00Z", note: "n" } })), true);
    assert.equal(canReseal(c("audit_log", "warn")), false);
    assert.equal(canReseal(c("audit_log", "ok")), false);
    assert.equal(canReseal(c("guacd", "fail")), false);
    assert.equal(canReseal(c("audit_log", "fail", { fingerprint: "" })), false);
});

test("totals cover failing tables only", () => {
    const p = parseResealPlan(raw)!;
    assert.deepEqual(resealTotals(p), { tables: 2, rehash: 4, retire: 3, fromRow: 3 });
    assert.deepEqual(resealTotals({ ...p, tables: p.tables.filter((t) => t.ok) }), { tables: 0, rehash: 0, retire: 0, fromRow: null });
});

test("a table's problem splits into the chain and the anchors file", () => {
    const [g, s, a] = parseResealPlan(raw)!.tables;
    assert.deepEqual(tableIssues(g), [{ kind: "chain", row: 3, reason: "hash_mismatch", more: 0 }]);
    assert.deepEqual(tableIssues(s), [{ kind: "checkpoint", row: 1, reason: "checkpoint_mismatch", more: 2 }]);
    assert.deepEqual(tableIssues(a), []);
});

test("re-seal records group per re-seal, newest first", () => {
    const records = [record("a", "telepy_gateway_event", "2026-10-29T05:00:00Z"), record("b", "telepy_gateway_event", "2026-10-30T05:00:00Z"), record("a", "telepy_sign_in_event", "2026-10-29T05:00:00Z")].map(
        (r) => parseReseal(r)!,
    );
    const groups = groupReseals(records);
    assert.deepEqual(
        groups.map((g) => [g.id, g.tables.length]),
        [
            ["b", 1],
            ["a", 2],
        ],
    );
    assert.equal(groups[1].note, "restored");
});
