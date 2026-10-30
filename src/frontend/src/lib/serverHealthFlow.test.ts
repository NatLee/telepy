import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECK_IDS, type HealthCheck, type HealthCheckId, type HealthStatus, type ServerHealth } from "./serverHealth.ts";
import { HEALTH_SPOTS, SPOT_CHECKS, effectiveStatus, healthNow, healthSpots, spotOf, stateOf } from "./serverHealthFlow.ts";

const c = (id: HealthCheckId | null, status: HealthStatus, name = id ?? "new check"): HealthCheck => ({ id, name, status, detail: `${name} detail`, fingerprint: `${name}-fp`, ack: null, staleAck: null });
const ack = { by: "admin", at: "2026-10-30T02:00:00Z", note: "restored from a backup" };
const health = (checks: HealthCheck[]): ServerHealth => ({ checks, ok: 0, info: 0, warnings: 0, failures: 0, ranAt: null });
const allOk = () => CHECK_IDS.map((id) => c(id, "ok"));

test("every check id sits on exactly one spot", () => {
    for (const id of CHECK_IDS) {
        const spots = HEALTH_SPOTS.filter((s) => SPOT_CHECKS[s]?.includes(id));
        assert.equal(spots.length, 1, id);
    }
});

test("states: fail = failed, warn = warn, ok and info = ok, nothing = waiting", () => {
    assert.equal(stateOf("fail"), "failed");
    assert.equal(stateOf("warn"), "warn");
    assert.equal(stateOf("ok"), "ok");
    assert.equal(stateOf("info"), "ok");
    assert.equal(stateOf(null), "waiting");
});

test("not loaded = every spot waiting, and the summary says loading", () => {
    const spots = healthSpots(null);
    for (const s of HEALTH_SPOTS) assert.equal(spots[s].state, "waiting", s);
    assert.deepEqual(healthNow(null), { kind: "loading" });
});

test("all fine: every checked spot ok, devices stay unchecked, the visitor is ok", () => {
    const spots = healthSpots(health(allOk()));
    assert.equal(spots.visitor.state, "ok");
    assert.equal(spots.devices.state, "waiting");
    assert.equal(spots.devices.unchecked, true);
    for (const s of ["proxy", "backend", "disk", "gateway", "guacd", "kasm", "lookups"] as const) assert.equal(spots[s].state, "ok", s);
    assert.deepEqual(healthNow(health(allOk())), { kind: "ok" });
});

test("a spot takes its worst check, and its checks are sorted worst first", () => {
    const checks = allOk().map((x) => (x.id === "geoip" ? c("geoip", "info") : x.id === "oui" ? c("oui", "warn") : x));
    const spots = healthSpots(health(checks));
    assert.equal(spots.lookups.state, "warn");
    assert.equal(spots.lookups.status, "warn");
    assert.equal(spots.lookups.checks[0].id, "oui");
    assert.equal(spots.lookups.tab, "services");
});

test("notes alone keep a spot ok but report the info level", () => {
    const checks = allOk().map((x) => (x.id === "public_url" ? c("public_url", "info") : x));
    const spots = healthSpots(health(checks));
    assert.equal(spots.backend.state, "ok");
    assert.equal(spots.backend.status, "info");
    assert.deepEqual(healthNow(health(checks)), { kind: "ok" });
});

test("where it stopped: the first failure along the request path wins over later ones and over warnings", () => {
    const checks = allOk().map((x) =>
        x.id === "client_addresses" ? c("client_addresses", "warn") : x.id === "guacd" ? c("guacd", "fail") : x.id === "database" ? c("database", "fail") : x,
    );
    const now = healthNow(health(checks));
    assert.equal(now.kind, "fail");
    if (now.kind !== "fail") return;
    assert.equal(now.spot, "disk");
    assert.equal(now.check.id, "database");
    assert.equal(now.tab, "storage");
    assert.equal(now.more, 1);
});

test("only warnings: the first one along the path", () => {
    const checks = allOk().map((x) => (x.id === "kasm" ? c("kasm", "warn") : x.id === "secret_key" ? c("secret_key", "warn") : x));
    const now = healthNow(health(checks));
    assert.equal(now.kind, "warn");
    if (now.kind !== "warn") return;
    assert.equal(now.spot, "backend");
    assert.equal(now.check.id, "secret_key");
    assert.equal(now.more, 1);
});

test("an unknown check from a newer backend lands on the backend", () => {
    assert.equal(spotOf(c(null, "fail")), "backend");
    const spots = healthSpots(health([...allOk(), c(null, "fail")]));
    assert.equal(spots.backend.state, "failed");
});

test("a loaded answer missing a spot's checks leaves that spot waiting", () => {
    const spots = healthSpots(health(allOk().filter((x) => x.id !== "kasm")));
    assert.equal(spots.kasm.state, "waiting");
    assert.equal(spots.kasm.status, null);
});

test("an acknowledged problem does not colour its spot; it is listed as acknowledged", () => {
    const checks = allOk().map((x) => (x.id === "audit_log" ? { ...c("audit_log", "fail"), ack } : x.id === "guacd" ? c("guacd", "warn") : x));
    assert.equal(effectiveStatus(checks.find((x) => x.id === "audit_log")!), "info");
    const spots = healthSpots(health(checks));
    assert.equal(spots.disk.state, "ok");
    assert.equal(spots.disk.status, "info");
    assert.deepEqual(spots.disk.acked.map((x) => x.id), ["audit_log"]);
    assert.equal(spots.guacd.state, "warn");
    assert.deepEqual(spots.guacd.acked, []);
    const now = healthNow(health(checks));
    assert.equal(now.kind, "warn");
    if (now.kind === "warn") assert.equal(now.spot, "guacd");
});

test("a stale acknowledgement keeps the spot red", () => {
    const checks = allOk().map((x) => (x.id === "audit_log" ? { ...c("audit_log", "fail"), staleAck: ack } : x));
    const spots = healthSpots(health(checks));
    assert.equal(spots.disk.state, "failed");
    assert.deepEqual(spots.disk.acked, []);
    assert.equal(healthNow(health(checks)).kind, "fail");
});

test("only acknowledged problems everywhere = all fine", () => {
    const checks = allOk().map((x) => (x.id === "kasm" ? { ...c("kasm", "warn"), ack } : x));
    assert.deepEqual(healthNow(health(checks)), { kind: "ok" });
});
