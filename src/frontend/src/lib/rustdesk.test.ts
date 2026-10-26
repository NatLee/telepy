import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMsgbox, inputKeyJson, keyNameFor, mouseButtonName, mouseJson, parsePeerInfo, peerIdFor, qualityToStats, rustdeskCloseFailure, rustdeskWsUrl, wheelSteps } from "./rustdesk.ts";

const start = { session_id: "s", ws_path: "/ws/rustdesk/s/", ticket: "t k", expires_in: 60, target: { host: "127.0.0.1", port: 21118, label: "device", lan_host_id: null }, username: "root" };

test("the core gets one url with the ticket and an ip-looking peer id", () => {
    assert.equal(rustdeskWsUrl("wss://telepy.example", start), "wss://telepy.example/ws/rustdesk/s/?ticket=t%20k");
    assert.equal(peerIdFor(start), "127.0.0.1:21118");
    assert.equal(peerIdFor({ ...start, target: { ...start.target, host: "192.168.1.50", port: 21119 } }), "192.168.1.50:21119");
});

const ev = (key: string, code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing: boolean; keyCode: number }> = {}) => ({ key, code, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });

test("key names follow the core's legacy table", () => {
    assert.equal(keyNameFor(ev("a", "KeyA")), "a");
    assert.equal(keyNameFor(ev("A", "KeyA", { shiftKey: true })), "A", "a printable key is sent as typed");
    assert.equal(keyNameFor(ev("!", "Digit1", { shiftKey: true })), "!");
    assert.equal(keyNameFor(ev("c", "KeyC", { ctrlKey: true })), "c", "Ctrl+C sends the physical key");
    assert.equal(keyNameFor(ev("ç", "KeyC", { altKey: true })), "c", "Alt+C on a Mac sends the physical key, not the composed symbol");
    assert.equal(keyNameFor(ev("Enter", "Enter")), "VK_RETURN");
    assert.equal(keyNameFor(ev(" ", "Space")), "VK_SPACE");
    assert.equal(keyNameFor(ev("Shift", "ShiftLeft")), "VK_SHIFT");
    assert.equal(keyNameFor(ev("Shift", "ShiftRight")), "RShift");
    assert.equal(keyNameFor(ev("Meta", "MetaLeft")), "Meta");
    assert.equal(keyNameFor(ev("Alt", "AltRight")), "RAlt");
    assert.equal(keyNameFor(ev("F5", "F5")), "VK_F5");
    assert.equal(keyNameFor(ev("PageDown", "PageDown")), "VK_NEXT");
    assert.equal(keyNameFor(ev("Process", "KeyA", { isComposing: true })), null, "IME composition is left to input_string");
    assert.equal(keyNameFor(ev("Unidentified", "", { keyCode: 229 })), null);
    assert.equal(keyNameFor(ev("Dead", "Quote")), null);
    assert.equal(keyNameFor(ev("AudioVolumeUp", "AudioVolumeUp")), null, "unknown keys are dropped");
    assert.equal(keyNameFor(ev("中", "KeyZ")), "中", "a composed single character still goes out");
    assert.deepEqual(inputKeyJson("c", true, { altKey: false, ctrlKey: true, shiftKey: false, metaKey: false }), { name: "c", down: true, press: false, alt: false, ctrl: true, shift: false, command: false });
});

test("mouse json only carries held modifiers", () => {
    assert.equal(mouseButtonName(0), "left");
    assert.equal(mouseButtonName(1), "wheel");
    assert.equal(mouseButtonName(2), "right");
    assert.equal(mouseButtonName(7), null);
    assert.deepEqual(mouseJson("down", 10.4, 20.6, "left", { altKey: false, ctrlKey: true, shiftKey: false, metaKey: false }), { type: "down", x: "10", y: "21", buttons: "left", ctrl: "true" });
    assert.deepEqual(mouseJson("", 1, 2, null, { altKey: false, ctrlKey: false, shiftKey: false, metaKey: false }), { type: "", x: "1", y: "2" });
    assert.deepEqual(wheelSteps(0, 100), { x: 0, y: -1 }, "wheel down scrolls down");
    assert.deepEqual(wheelSteps(0, -3), { x: 0, y: 1 });
    assert.deepEqual(wheelSteps(50, 0), { x: 1, y: 0 });
});

test("peer info keeps displays across partial updates", () => {
    const first = parsePeerInfo({ username: "nat", hostname: "box", platform: "Linux", version: "1.5.0", displays: JSON.stringify([{ x: 0, y: 0, width: 1920, height: 1080 }, { x: 1920, y: 0, width: 1280, height: 800 }]), current_display: "1" });
    assert.equal(first.displays.length, 2);
    assert.equal(first.currentDisplay, 1);
    const sync = parsePeerInfo({ displays: "garbage" }, first);
    assert.equal(sync.displays.length, 2, "bad JSON keeps the previous displays");
    assert.equal(sync.platform, "Linux");
    assert.equal(parsePeerInfo({ displays: "[]", current_display: "5" }).currentDisplay, 0);
});

test("quality events become stream stats", () => {
    const s = qualityToStats({ fps: JSON.stringify({ "0": 29, "1": 12 }), delay: "7", target_bitrate: "719" }, 1, 123);
    assert.equal(s.fps, 12);
    assert.equal(s.netMs, 7);
    assert.equal(s.downBps, 89875);
    assert.equal(s.at, 123);
    assert.equal(qualityToStats({ fps: "x", delay: "" }, 0).netMs, null);
});

test("msgboxes and close codes map to actions", () => {
    assert.deepEqual(classifyMsgbox({ type: "insecure-connection-nocancel-hasclose", title: "", text: "" }), { kind: "continue" });
    assert.equal(classifyMsgbox({ type: "re-input-password", title: "Wrong Password", text: "" }).kind, "failure");
    assert.equal(classifyMsgbox({ type: "success", title: "", text: "Connected, waiting for image..." }).kind, "ignore");
    const off = classifyMsgbox({ type: "error", title: "Error", text: "Remote desktop is offline" });
    assert.equal(off.kind === "failure" && off.failure.key, "desktop.err.rdOffline");
    assert.equal(rustdeskCloseFailure(1000), null);
    assert.equal(rustdeskCloseFailure(4014)?.key, "desktop.err.stopped");
    assert.equal(rustdeskCloseFailure(4013)?.key, "desktop.err.rdDeviceClosed");
    assert.equal(rustdeskCloseFailure(4404)?.key, "desktop.err.expired");
});
