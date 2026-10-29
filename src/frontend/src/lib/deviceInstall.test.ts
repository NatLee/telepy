// node --test（Node 23 會直接拿掉型別）。/ Run with `npm test` (Node strips the types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { failureKey, groupParts, lanes, rootCommands, stepStates, untouched, type InstallPart, type RenameReport, type ReportedStep } from "./deviceInstall.ts";

const part = (kind: InstallPart["kind"], name: string, priv = false): InstallPart => ({ kind, what: "x", name, account: "pi", private: priv });

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
