import { test } from "node:test";
import assert from "node:assert/strict";
import {
    canResume,
    detachChoiceAllowed,
    detachLayers,
    detachTimeline,
    effectiveDetach,
    isDetachChoice,
    parseShellFrame,
    parseShellList,
    reconnectDelay,
    remainingSecs,
    shellStoreKey,
    withShell,
    withoutShell,
} from "./terminalDetach.ts";

test("the narrowest layer wins, like the backend", () => {
    assert.deepEqual(effectiveDetach(300, 1800), { secs: 300, by: "user" });
    assert.deepEqual(effectiveDetach(3600, 1800), { secs: 1800, by: "site" });
    assert.deepEqual(effectiveDetach(0, 1800), { secs: 0, by: "user" });
    assert.deepEqual(effectiveDetach(900, 0), { secs: 0, by: "site" });
    assert.deepEqual(effectiveDetach(900, 1800, "never"), { secs: 0, by: "tunnel" });
    assert.deepEqual(effectiveDetach(1800, 1800, "user"), { secs: 1800, by: "user" });
});

test("choices above the ceiling are disabled; 0 always works", () => {
    assert.equal(detachChoiceAllowed(0, 0), true);
    assert.equal(detachChoiceAllowed(60, 0), false, "the site switched it off");
    assert.equal(detachChoiceAllowed(1800, 1800), true);
    assert.equal(detachChoiceAllowed(3600, 1800), false);
    assert.equal(isDetachChoice(300), true);
    assert.equal(isDetachChoice(42), false);
});

test("the shell frame", () => {
    const f = parseShellFrame(JSON.stringify({ type: "shell", id: "abc123", resumed: true, offset: 42, reset: false, detach: { secs: 300, by: "site" } }));
    assert.deepEqual(f, { type: "shell", id: "abc123", resumed: true, offset: 42, reset: false, detach: { secs: 300, by: "site" } });
    assert.equal(parseShellFrame(JSON.stringify({ type: "command", state: "blocked" })), null);
    assert.equal(parseShellFrame("pong"), null);
    const odd = parseShellFrame(JSON.stringify({ type: "shell", id: "x", offset: -1, detach: { secs: -5, by: "nobody" } }));
    assert.deepEqual(odd?.detach, { secs: 0, by: "user" });
    assert.equal(odd?.offset, 0);
});

test("only drops within the grace are resumed", () => {
    const grace = { secs: 60, by: "user" as const };
    assert.equal(canResume(1006, grace, 0, 59_000), true, "network drop");
    assert.equal(canResume(1001, grace, 0, 1000), true, "server going away");
    assert.equal(canResume(1006, grace, 0, 60_000), false, "time is up");
    assert.equal(canResume(1005, grace, 0, 1000), false, "the shell exited");
    assert.equal(canResume(1000, grace, 0, 1000), false);
    assert.equal(canResume(4009, grace, 0, 1000), false, "ended from the live sessions page");
    assert.equal(canResume(4010, grace, 0, 1000), false, "signed out");
    assert.equal(canResume(1006, { secs: 0, by: "tunnel" }, 0, 1), false, "kept 0 s");
    assert.equal(canResume(1006, null, 0, 1), false, "no shell frame yet");
    assert.equal(remainingSecs(0, 60, 1500), 59);
    assert.equal(remainingSecs(0, 60, 90_000), 0);
    assert.deepEqual([0, 1, 2, 3, 4, 9].map(reconnectDelay), [500, 1000, 2000, 4000, 5000, 5000]);
});

test("shell ids per tab in sessionStorage", () => {
    assert.equal(shellStoreKey(7, "ubuntu"), "telepy.shells.7.ubuntu");
    assert.equal(shellStoreKey("7", "ubuntu", "3", "backup"), "telepy.shells.7.ubuntu.lan3.backup");
    assert.notEqual(shellStoreKey(7, "ubuntu", 3, null), shellStoreKey(7, "ubuntu"));
    assert.deepEqual(parseShellList(null), []);
    assert.deepEqual(parseShellList("not json"), []);
    assert.deepEqual(parseShellList(JSON.stringify(["a1", "a1", "bad id!", 5, "b2"])), ["a1", "b2"]);
    let list = withShell([], "a");
    list = withShell(list, "b");
    list = withShell(list, "a");
    assert.deepEqual(list, ["b", "a"], "re-adding moves to the end, no duplicates");
    assert.deepEqual(withoutShell(list, "b"), ["a"]);
    let many: string[] = [];
    for (let i = 0; i < 9; i++) many = withShell(many, `s${i}`);
    assert.equal(many.length, 6);
    assert.equal(many[0], "s3", "the oldest fall off");
});

test("the timeline follows the phase", () => {
    const states = (phase: Parameters<typeof detachTimeline>[0], secs: number) => detachTimeline(phase, secs).map((s) => `${s.id}:${s.state}`);
    assert.deepEqual(states("detached", 300), ["connected:done", "drop:done", "kept:active", "resume:waiting", "end:waiting"]);
    assert.deepEqual(states("resumed", 300), ["connected:done", "drop:done", "kept:done", "resume:done", "end:skipped"]);
    assert.deepEqual(states("ended", 300), ["connected:done", "drop:done", "kept:done", "resume:skipped", "end:failed"]);
    // 0 秒：保留與接回都跳過，斷線就結束。/ 0 s: no keeping, no resuming.
    assert.deepEqual(states("preview", 0), ["connected:done", "drop:waiting", "kept:skipped", "resume:skipped", "end:waiting"]);
    assert.deepEqual(states("connected", 60)[0], "connected:active");
});

test("the layers say who decided", () => {
    const l = detachLayers(3600, 1800, "user");
    assert.deepEqual(l.map((x) => [x.layer, x.decides]), [["user", false], ["site", true], ["tunnel", false]]);
    assert.equal(detachLayers(300, 1800, "never").find((x) => x.decides)?.layer, "tunnel");
    assert.equal(detachLayers(300, 1800, null).find((x) => x.decides)?.layer, "user", "no device in view = assume user");
    assert.equal(detachLayers(300, 1800, null)[2].value, null);
});
