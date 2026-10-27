import { test } from "node:test";
import assert from "node:assert/strict";
import {
    controller,
    controlState,
    parseWatchersFrame,
    parseWatchEvent,
    pendingRequests,
    watchCloseReason,
    watcherNames,
    watchPhase,
    watchSpots,
    type WatchersFrame,
} from "./terminalWatch.ts";

const frame: WatchersFrame = {
    type: "watchers",
    watchers: [
        { id: 7, username: "alice", since: "", control: false, requested: true },
        { id: 8, username: "carol", since: "", control: true, requested: false },
        { id: 9, username: "alice", since: "", control: false, requested: false },
    ],
    control: 8,
};

test("parses the watch socket's frames", () => {
    const start = parseWatchEvent(JSON.stringify({ type: "watch", shell: "s1", you: 7, user: { id: 2, username: "bob" }, tunnel: { id: 5, name: "box" }, account: "ubuntu", size: { cols: 120, rows: 40 }, detached: true, can_force: true, watchers: frame }));
    assert.equal(start?.type, "watch");
    if (start?.type !== "watch") return;
    assert.deepEqual(start.size, { cols: 120, rows: 40 });
    assert.equal(start.user.username, "bob");
    assert.equal(start.detached, true);
    assert.equal(start.reset, false);
    assert.equal(start.watchers.control, 8);
    assert.deepEqual(parseWatchEvent(JSON.stringify({ type: "resize", cols: 100, rows: 30 })), { type: "resize", cols: 100, rows: 30 });
    assert.equal(parseWatchEvent(JSON.stringify({ type: "resize", cols: 0, rows: 30 })), null);
    assert.deepEqual(parseWatchEvent(JSON.stringify({ type: "detached", detached: false })), { type: "detached", detached: false });
    assert.equal(parseWatchEvent("pong"), null);
    assert.equal(parseWatchEvent("{nope"), null);
    assert.equal(parseWatchEvent(JSON.stringify({ type: "shell", id: "x" })), null);
});

test("the watched user's socket only yields watchers frames", () => {
    assert.equal(parseWatchersFrame(JSON.stringify(frame))?.control, 8);
    assert.equal(parseWatchersFrame(JSON.stringify({ type: "command", state: "blocked" })), null);
    assert.equal(parseWatchersFrame("pong"), null);
});

test("control state, requests and names", () => {
    assert.equal(controlState(frame, 8), "granted");
    assert.equal(controlState(frame, 7), "requested");
    assert.equal(controlState(frame, 9), "none");
    assert.equal(controlState(null, 7), "none");
    assert.deepEqual(pendingRequests(frame).map((w) => w.id), [7]);
    assert.equal(controller(frame)?.username, "carol");
    assert.equal(controller({ ...frame, control: null }), null);
    assert.deepEqual(watcherNames(frame), ["alice", "carol"], "two windows of one person count once");
});

test("phases and the diagram's spots follow the connection", () => {
    const s = { open: true, closeCode: null, detached: false, control: "none" as const };
    assert.equal(watchPhase({ ...s, open: false }), "connecting");
    assert.equal(watchPhase(s), "watching");
    assert.equal(watchPhase({ ...s, control: "requested" }), "requested");
    assert.equal(watchPhase({ ...s, control: "granted" }), "control");
    assert.equal(watchPhase({ ...s, detached: true, control: "granted" }), "detached", "detached wins: nobody is on the other end");
    assert.equal(watchPhase({ ...s, closeCode: 4015 }), "ended");
    assert.equal(watchPhase({ ...s, closeCode: 4004 }), "refused");
    assert.equal(watchSpots("watching").yourKeys, "off");
    assert.equal(watchSpots("requested").yourKeys, "asking");
    assert.equal(watchSpots("control").yourKeys, "on");
    assert.equal(watchSpots("detached").theirLink, "failed");
    assert.equal(watchSpots("detached").yourLink, "ok", "you keep watching a detached shell");
    assert.equal(watchSpots("refused").yourLink, "failed");
    assert.equal(watchSpots("connecting").yourLink, "active");
});

test("close codes become reasons", () => {
    assert.equal(watchCloseReason(4015, "ended"), "ended");
    assert.equal(watchCloseReason(4015, "shell_gone"), "gone");
    assert.equal(watchCloseReason(4004, ""), "refused");
    assert.equal(watchCloseReason(4009, "alice"), "endedBy");
    assert.equal(watchCloseReason(4010, ""), "signedOut");
    assert.equal(watchCloseReason(1006, ""), "dropped");
});
