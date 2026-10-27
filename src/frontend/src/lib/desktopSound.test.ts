import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SNAPSHOT, isMacPlatform, NONE_AFTER_MS, pcmPeak, rawBytesPerSample, soundNeedsAttention, soundReport, type SoundInput } from "./desktopSound.ts";

const base: SoundInput = { mode: "rdp", wanted: true, decoder: true, connectedMs: 3000, snapshot: EMPTY_SNAPSHOT };
const report = (i: Partial<SoundInput>) => soundReport({ ...base, ...i });
const playing = { opened: true, receiving: true, loud: true, context: "running" };

test("ways without sound, sound off and muted come first", () => {
    assert.equal(report({ mode: "vnc", snapshot: playing }).state, "unsupported");
    assert.equal(report({ mode: "vnc" }).reason, "desktop.streams.reason.soundVnc");
    assert.equal(report({ mode: "rustdesk", decoder: false }).reason, "desktop.streams.reason.soundNoDecoder");
    assert.equal(report({ wanted: false, snapshot: playing }).state, "off");
    assert.equal(report({ mode: "rustdesk", wanted: false }).reason, "desktop.streams.reason.soundOffRd");
    assert.equal(report({ muted: true, snapshot: playing }).state, "muted");
});

test("arriving sound with a suspended or missing context is blocked by the browser", () => {
    assert.equal(report({ snapshot: { ...playing, context: "suspended" } }).state, "blocked");
    assert.equal(report({ snapshot: { ...playing, context: null } }).state, "blocked");
    assert.equal(report({ snapshot: { ...playing, loud: false, context: "interrupted" } }).reason, "desktop.sound.reason.blocked");
    assert.ok(soundNeedsAttention("blocked"));
});

test("playing needs audible data and a running context", () => {
    assert.equal(report({ snapshot: playing }).state, "playing");
    assert.equal(report({ mode: "rustdesk", snapshot: playing }).reason, "desktop.streams.reason.soundRd");
    // 通道開著但全靜音、或一陣子沒資料 = 遠端沒在出聲。/ Silent data, or an open channel with nothing arriving.
    assert.equal(report({ snapshot: { ...playing, loud: false } }).state, "quiet");
    assert.equal(report({ snapshot: { ...EMPTY_SNAPSHOT, opened: true } }).state, "quiet");
    assert.equal(report({ mode: "rustdesk", peerPlatform: "Mac OS", snapshot: { ...EMPTY_SNAPSHOT, opened: true } }).reason, "desktop.sound.reason.quietMac");
    assert.ok(!soundNeedsAttention("quiet"));
});

test("no channel: waiting at first, then the remote sends nothing with a per-way reason", () => {
    assert.equal(report({}).state, "waiting");
    const late = { connectedMs: NONE_AFTER_MS };
    assert.deepEqual(report(late), { state: "none", reason: "desktop.sound.reason.noneRdp" });
    assert.equal(report({ ...late, mode: "rustdesk", peerPlatform: "Linux" }).reason, "desktop.sound.reason.noneRd");
    assert.equal(report({ ...late, mode: "rustdesk", peerPlatform: "Mac OS" }).reason, "desktop.sound.reason.noneRdMac");
    assert.ok(soundNeedsAttention("none"));
});

test("macOS platform strings", () => {
    assert.ok(isMacPlatform("Mac OS"));
    assert.ok(isMacPlatform("macOS"));
    assert.ok(!isMacPlatform("Linux"));
    assert.ok(!isMacPlatform("Windows"));
    assert.ok(!isMacPlatform(""));
    assert.ok(!isMacPlatform(null));
});

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

test("PCM peaks: L16 little-endian signed, L8 signed, garbage is silent", () => {
    assert.equal(pcmPeak(b64([0, 0, 0, 0, 0, 0, 0, 0]), 2, 1), 0);
    // 0x4000 = 16384 → 0.5；0x8000 = -32768 → 1。
    assert.equal(pcmPeak(b64([0x00, 0x40, 0, 0]), 2, 1), 0.5);
    assert.equal(pcmPeak(b64([0, 0, 0x00, 0x80]), 2, 1), 1);
    assert.equal(pcmPeak(b64([0x40, 0xc0]), 1, 1), 0.5);
    assert.equal(pcmPeak("not base64!!", 2), 0);
    // 一個奇數尾巴不讀。/ A trailing odd byte is ignored.
    assert.equal(pcmPeak(b64([0, 0, 0x7f]), 2, 1), 0);
});

test("raw audio mimetypes", () => {
    assert.equal(rawBytesPerSample("audio/L16;rate=44100,channels=2"), 2);
    assert.equal(rawBytesPerSample("audio/L8;rate=8000"), 1);
    assert.equal(rawBytesPerSample("audio/ogg"), null);
});
