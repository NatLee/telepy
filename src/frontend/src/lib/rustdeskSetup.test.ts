import { test } from "node:test";
import assert from "node:assert/strict";
import { allReady, nextStep, setupStatus, tunnelProblem } from "./rustdeskSetup.ts";

test("nothing known yet: the first step is next and nothing is marked", () => {
    const s = setupStatus({ probe: "idle", connected: false });
    assert.deepEqual(s, { directIp: "unknown", password: "unknown", permissions: "unknown", service: "advice" });
    assert.equal(nextStep(s), "directIp");
    assert.equal(allReady(s), false);
});

test("a refused port points at direct IP access, from the probe or from a connect", () => {
    const probe = setupStatus({ probe: "failed", probeFailure: "desktop.err.rdDirectIpOff", connected: false });
    assert.equal(probe.directIp, "failed");
    assert.equal(nextStep(probe), "directIp");
    const connect = setupStatus({ probe: "idle", failure: "desktop.err.rdDirectIpOff", connected: false });
    assert.equal(connect.directIp, "failed");
    assert.equal(setupStatus({ probe: "checking", connected: false }).directIp, "checking");
});

test("the port answers: the password is next", () => {
    const s = setupStatus({ probe: "ok", connected: false });
    assert.equal(s.directIp, "ok");
    assert.equal(nextStep(s), "password");
});

test("a rejected password or a missing screen is pinned to its step", () => {
    const pw = setupStatus({ probe: "ok", failure: "desktop.err.rdPassword", connected: false });
    assert.equal(pw.password, "failed");
    assert.equal(nextStep(pw), "password");
    const screen = setupStatus({ probe: "ok", failure: "desktop.err.rdNoDisplay", connected: false });
    assert.equal(screen.permissions, "failed");
    assert.equal(nextStep(screen), "permissions", "a known failure wins over earlier unknown steps");
});

test("after a session the checklist is ready and only the service advice is left", () => {
    const s = setupStatus({ probe: "idle", connected: true });
    assert.equal(allReady(s), true);
    assert.equal(nextStep(s), "service");
    assert.equal(s.service, "advice");
});

test("tunnel problems are told apart from RustDesk problems", () => {
    assert.equal(tunnelProblem({ probe: "failed", probeFailure: "desktop.err.deviceOffline" }), true);
    assert.equal(tunnelProblem({ probe: "failed", probeFailure: "desktop.err.rdDirectIpOff" }), false);
    assert.equal(tunnelProblem({ probe: "ok" }), false);
    const s = setupStatus({ probe: "failed", probeFailure: "desktop.err.deviceOffline", connected: false });
    assert.equal(s.directIp, "unknown", "an offline device says nothing about RustDesk");
});
