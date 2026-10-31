// node --test（Node 23 會直接拿掉型別）。/ Run with `npm test` (Node strips the types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { TIDY_STEPS, failureKey, groupParts, offerAutomatic, lanes, mapRows, needsAttention, noteOf, rootCommands, stepStates, untouched, type InstallPart, type RenameReport, type ReportedStep } from "./deviceInstall.ts";

const part = (kind: InstallPart["kind"], name: string, priv = false): InstallPart => ({ kind, what: "x", name, account: "pi", private: priv, earlier: false });

test("parts are grouped with services first", () => {
    const groups = groupParts([part("file", "/k"), part("process", "ssh -NR …"), part("service", "telepy-natlee.service")]);
    assert.deepEqual(groups.map((g) => g.kind), ["service", "process", "file"]);
});

test("steps follow the report, the next one runs, a failure stops the rest", () => {
    const done = (id: ReportedStep["id"]): ReportedStep => ({ id, state: "done" });
    let s = stepStates([], true);
    assert.equal(s.survey, "active");
    assert.equal(s.install, "waiting");
    s = stepStates([done("survey"), done("install")], true);
    assert.deepEqual([s.survey, s.install, s.standby, s.check], ["ok", "ok", "active", "waiting"]);
    s = stepStates([done("survey"), done("install"), { id: "standby", state: "failed" }], true);
    assert.deepEqual([s.standby, s.check], ["failed", "waiting"], "nothing runs after a failure");
    // 移除失敗不擋「再確認」。/ A failed removal still lets the confirmation run.
    s = stepStates(["survey", "install", "standby", "check", "switch"].map((id) => done(id as ReportedStep["id"])).concat([{ id: "remove", state: "failed" }]), true);
    assert.equal(s.confirm, "active");
});

test("the old lane carries the tunnel until the switch, the new one waits as a standby", () => {
    const done = (...ids: ReportedStep["id"][]) => ids.map((id): ReportedStep => ({ id, state: "done" }));
    assert.deepEqual(lanes(done("survey"), true), { old: "ok", new: "active", carrying: "old" });
    assert.deepEqual(lanes(done("survey", "install", "standby"), true), { old: "ok", new: "active", carrying: "old" });
    assert.deepEqual(lanes(done("survey", "install", "standby", "check", "switch"), true), { old: "active", new: "ok", carrying: "new" });
    assert.deepEqual(lanes(done("survey", "install", "standby", "check", "switch", "remove", "confirm"), false), { old: "waiting", new: "ok", carrying: "new" });
    // 新服務沒連上：舊的照舊。/ The new one never connected: the old one is untouched.
    const failed = [...done("survey", "install"), { id: "standby", state: "failed" } as ReportedStep];
    assert.deepEqual(lanes(failed, false), { old: "ok", new: "failed", carrying: "old" });
});

test("failures are explained and say whether anything changed", () => {
    assert.equal(failureKey("standby_timeout"), "deviceInstall.fail.standby_timeout");
    assert.equal(failureKey("needs_root"), "deviceInstall.block.needs_root");
    assert.equal(failureKey("weird"), "deviceInstall.fail.other");
    const r = (steps: ReportedStep[], ok = false): RenameReport => ({ ok, steps, old: [] });
    assert.equal(untouched(r([{ id: "survey", state: "done" }, { id: "install", state: "failed" }])), true);
    assert.equal(untouched(r([{ id: "switch", state: "done" }, { id: "remove", state: "failed", detail: "sudo rm -f /a\nsudo kill 4" }])), false);
    assert.deepEqual(rootCommands(r([{ id: "remove", state: "failed", detail: "sudo rm -f /a\nsudo kill 4" }])), ["sudo rm -f /a", "sudo kill 4"]);
});

test("the device map has this tunnel first, then one row per other server", () => {
    const rows = mapRows({
        server_port: "56767",
        parts: [
            { kind: "service", what: "systemd", name: "telepy-k7m2q9xd.service", account: "root", private: true, earlier: false },
            { kind: "process", what: "process", name: "ssh -NT …", account: "root", private: false, earlier: false },
        ],
        others: [
            { name: "telepy-tunnel.service", port: 57575, process: false, account: "root" },
            { name: "812 ssh -N -p 57575 …", port: 57575, process: true, account: "root" },
            { name: "ssh -N -p 2200 …", port: 2200, process: true, account: "pi" },
        ],
    });
    assert.deepEqual(rows.map((r) => [r.kind, r.port, r.services.map((s) => `${s.name}:${s.note}`)]), [
        ["this", "56767", ["telepy-k7m2q9xd.service:private"]],
        ["other", "57575", ["telepy-tunnel.service:other"]],
        ["other", "2200", ["ssh:process"]],
    ]);
    // 只有在跑的 ssh、沒有服務名稱：那一列寫 ssh。/ Only a running ssh: the row says ssh.
    assert.deepEqual(mapRows({ server_port: "1", parts: [{ kind: "process", what: "process", name: "x", account: "a", private: false, earlier: false }], others: [] })[0].services, [{ name: "ssh", note: "process" }]);
});

test("an extra copy is told apart from a name to change, whatever it is called", () => {
    const extra = { ...part("service", "telepy-6m35fshq"), extra: true };
    assert.equal(noteOf(extra), "extra");
    assert.equal(noteOf({ ...extra, earlier: true }), "extra", "an earlier name that is a second copy is still extra");
    assert.equal(noteOf(part("service", "telepy-natlee.service")), "older");
    assert.equal(noteOf(part("service", "telepy-47xzwr2e", true)), "private");
    const rows = mapRows({ parts: [part("service", "telepy-47xzwr2e", true), extra], others: [], server_port: "56767" });
    assert.deepEqual(rows[0].services.map((s) => s.note), ["private", "extra"]);
    assert.deepEqual(needsAttention({ id: "x", older: ["a"], extra: ["b"] }), ["b", "a"]);
    assert.deepEqual(needsAttention({ id: "x", older: [] }), [], "an older backend sends no extra");
    assert.equal(failureKey("extra"), "deviceInstall.block.extra");
    assert.equal(failureKey("connection_lost"), "deviceInstall.fail.connection_lost");
});

test("removing an extra copy has three steps of its own", () => {
    const s = stepStates([{ id: "survey", state: "done" }], true, TIDY_STEPS);
    assert.deepEqual([s.survey, s.remove, s.confirm], ["ok", "active", "waiting"]);
});

test("switching to automatic is offered only when possible and not automatic yet", () => {
    const v = (possible: boolean, way_in: "ssh" | "websocket" | "auto" | null) => ({ online: true, switch: { possible, blocker: null, way_in } });
    assert.equal(offerAutomatic(v(true, "ssh")), true);
    assert.equal(offerAutomatic(v(true, null)), true, "unknown way in");
    assert.equal(offerAutomatic(v(true, "websocket")), true);
    assert.equal(offerAutomatic(v(true, "auto")), false, "already automatic");
    assert.equal(offerAutomatic(v(false, "ssh")), false, "a blocker (Windows, no service found…)");
    assert.equal(offerAutomatic({ online: true }), false, "an older backend");
    assert.equal(failureKey("no_carrier"), "deviceInstall.fail.no_carrier");
});
