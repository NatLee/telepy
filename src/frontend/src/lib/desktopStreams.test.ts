import { test } from "node:test";
import assert from "node:assert/strict";
import { hasAudioDecoder, STREAM_IDS, streamFlows, streamRows, type StreamInput } from "./desktopStreams.ts";

const base: StreamInput = { mode: "rdp", clipboard: "both", clipboardLimit: "both", sound: false, soundDecoder: true, fileTransfer: true, filesOpen: false };
const row = (i: Partial<StreamInput>, id: string) => streamRows({ ...base, ...i }).find((r) => r.id === id)!;

test("five streams in a fixed order, picture down and input up", () => {
    assert.deepEqual(streamRows(base).map((r) => r.id), [...STREAM_IDS]);
    assert.equal(row({}, "picture").dir, "toBrowser");
    assert.equal(row({}, "input").dir, "toDesktop");
    assert.equal(row({ mode: "rustdesk" }, "picture").reason, "desktop.streams.reason.pictureRd");
});

test("clipboard follows the direction and says when the site set it", () => {
    assert.equal(row({}, "clipboard").state, "on");
    assert.deepEqual([row({ clipboard: "to_remote" }, "clipboard").state, row({ clipboard: "to_remote" }, "clipboard").dir], ["oneWay", "toDesktop"]);
    assert.equal(row({ clipboard: "to_remote", clipboardLimit: "to_remote" }, "clipboard").reason, "desktop.streams.reason.clipboardLimited");
    assert.equal(row({ clipboard: "off" }, "clipboard").state, "off");
    assert.equal(row({ clipboard: "off", clipboardLimit: "off" }, "clipboard").state, "blocked");
});

test("sound: RDP when asked, never on VNC, RustDesk needs a decoder", () => {
    assert.equal(row({}, "sound").state, "off");
    assert.equal(row({ sound: true }, "sound").state, "on");
    assert.equal(row({ sound: true, muted: true }, "sound").reason, "desktop.streams.reason.soundMuted");
    assert.equal(row({ mode: "vnc", sound: true }, "sound").state, "unsupported");
    assert.equal(row({ mode: "rustdesk", sound: true }, "sound").state, "on");
    assert.equal(row({ mode: "rustdesk", sound: true, soundDecoder: false }, "sound").reason, "desktop.streams.reason.soundNoDecoder");
});

test("files: only RustDesk, blocked by the site switch, on while the panel is open", () => {
    assert.equal(row({}, "files").state, "unsupported");
    assert.equal(row({ mode: "vnc" }, "files").state, "unsupported");
    assert.equal(row({ mode: "rustdesk" }, "files").state, "off");
    assert.equal(row({ mode: "rustdesk", filesOpen: true }, "files").state, "on");
    assert.equal(row({ mode: "rustdesk", filesOpen: true, fileTransfer: false }, "files").state, "blocked");
});

test("only on and one-way streams move", () => {
    assert.deepEqual(["on", "oneWay", "off", "blocked", "unsupported"].map((s) => streamFlows(s as never)), [true, true, false, false, false]);
    assert.equal(hasAudioDecoder({ AudioDecoder: function () {}, AudioContext: function () {} }), true);
    assert.equal(hasAudioDecoder({ AudioContext: function () {} }), false);
    assert.equal(hasAudioDecoder(undefined), false);
});
