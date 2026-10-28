import { test } from "node:test";
import assert from "node:assert/strict";
import { clampPercent, clampSize, DEFAULT_DISPLAY, followsWindow, fromServer, parseDisplayPrefs, sameDisplay, toServer, pixelRatioFor, requestedSize, resolutionStatus, serializeDisplayPrefs, validDimension } from "./desktopDisplay.ts";

test("parseDisplayPrefs falls back field by field", () => {
    assert.deepEqual(parseDisplayPrefs(null), DEFAULT_DISPLAY);
    assert.deepEqual(parseDisplayPrefs("not json"), DEFAULT_DISPLAY);
    assert.deepEqual(parseDisplayPrefs("[1,2]"), DEFAULT_DISPLAY);
    const p = parseDisplayPrefs(JSON.stringify({ scale: "actual", percent: 999, resolution: "fixed", fixed: { width: 2560, height: 1440 }, hidpi: true, vncResize: "yes" }));
    assert.equal(p.scale, "actual");
    assert.equal(p.percent, 400);
    assert.equal(p.resolution, "fixed");
    assert.deepEqual(p.fixed, { width: 2560, height: 1440 });
    assert.equal(p.hidpi, true);
    assert.equal(p.vncResize, false, "only a real true turns it on");
    assert.equal(parseDisplayPrefs(JSON.stringify({ scale: "zoomy", fixed: { width: 50, height: 99999 } })).scale, "fit");
    assert.deepEqual(parseDisplayPrefs(JSON.stringify({ fixed: { width: 50, height: 1080 } })).fixed, DEFAULT_DISPLAY.fixed);
    assert.deepEqual(parseDisplayPrefs(serializeDisplayPrefs(p)), p);
});

test("clampPercent and validDimension", () => {
    assert.equal(clampPercent("150"), 150);
    assert.equal(clampPercent(10), 25);
    assert.equal(clampPercent("abc"), 100);
    assert.equal(validDimension("1920"), 1920);
    assert.equal(validDimension(199), null);
    assert.equal(validDimension(16385), null);
});

test("HiDPI is a separate switch, capped at 2", () => {
    assert.equal(pixelRatioFor(false, 2), 1);
    assert.equal(pixelRatioFor(true, 2), 2);
    assert.equal(pixelRatioFor(true, 3), 2);
    assert.equal(pixelRatioFor(true, 1.25), 1.25);
    assert.equal(pixelRatioFor(true, 0), 1);
});

test("who follows the window", () => {
    assert.equal(followsWindow(DEFAULT_DISPLAY, "rdp"), true);
    assert.equal(followsWindow({ ...DEFAULT_DISPLAY, resolution: "fixed" }, "rdp"), false);
    assert.equal(followsWindow(DEFAULT_DISPLAY, "vnc"), false);
    assert.equal(followsWindow({ ...DEFAULT_DISPLAY, vncResize: true }, "vnc"), true);
    assert.equal(followsWindow({ ...DEFAULT_DISPLAY, vncResize: true }, "rustdesk"), false);
    assert.equal(resolutionStatus("rdp", true), "follows");
    assert.equal(resolutionStatus("rdp", false), "fixed");
    assert.equal(resolutionStatus("vnc", true), "asked");
    assert.equal(resolutionStatus("vnc", false), "remote");
    assert.equal(resolutionStatus("rustdesk", true), "remote");
});

test("clampSize keeps the shape like the backend", () => {
    assert.deepEqual(clampSize(3840, 2160, 2560), { width: 2560, height: 1440 });
    assert.deepEqual(clampSize(2880, 1800, 2560), { width: 2560, height: 1600 });
    assert.deepEqual(clampSize(1280, 720, 2560), { width: 1280, height: 720 });
    assert.deepEqual(clampSize(10, 10, 2560), { width: 200, height: 200 });
});

test("requestedSize: the frame, HiDPI, a fixed size and the ceiling", () => {
    const frame = { width: 1100.4, height: 660 };
    assert.deepEqual(requestedSize(DEFAULT_DISPLAY, "rdp", frame, 1, 2560), { width: 1100, height: 660, dpi: 96 });
    assert.deepEqual(requestedSize(DEFAULT_DISPLAY, "rdp", frame, 2, 2560), { width: 2201, height: 1320, dpi: 192 });
    assert.deepEqual(requestedSize(DEFAULT_DISPLAY, "rdp", { width: 1500, height: 900 }, 2, 2560), { width: 2560, height: 1536, dpi: 192 });
    const fixed = { ...DEFAULT_DISPLAY, resolution: "fixed" as const, fixed: { width: 1600, height: 900 } };
    assert.deepEqual(requestedSize(fixed, "rdp", frame, 1, 2560), { width: 1600, height: 900, dpi: 96 });
    assert.deepEqual(requestedSize(fixed, "rdp", frame, 1, 1280), { width: 1280, height: 720, dpi: 96 });
    // VNC 用框的大小（只有開了跟著視窗時 guacd 才會用）。/ VNC asks for the frame (used only when following).
    assert.deepEqual(requestedSize(fixed, "vnc", frame, 1, null), { width: 1100, height: 660, dpi: 96 });
    assert.deepEqual(requestedSize(DEFAULT_DISPLAY, "rdp", { width: 100, height: 50 }, 1, null), { width: 320, height: 240, dpi: 96 });
});

test("account shape round-trips and the old quality / sound keys fill in", () => {
    const p = { ...DEFAULT_DISPLAY, scale: "custom" as const, percent: 150, resolution: "fixed" as const, fixed: { width: 1600, height: 900 }, hidpi: true, vncResize: true, quality: "sharp" as const, audio: true };
    const server = toServer(p);
    assert.deepEqual(server, { scale: "custom", percent: 150, resolution: "fixed", width: 1600, height: 900, hidpi: true, vnc_resize: true, quality: "sharp", audio: true });
    assert.deepEqual(fromServer(server), p);
    assert.equal(fromServer(null), null);
    assert.equal(fromServer([1]), null);
    assert.equal(fromServer({ quality: "ultra" })?.quality, "auto");
    assert.equal(parseDisplayPrefs(null, "speed", "on").quality, "speed");
    assert.equal(parseDisplayPrefs(null, "speed", "on").audio, true);
    assert.equal(parseDisplayPrefs(JSON.stringify({ quality: "sharp", audio: false }), "speed", "on").quality, "sharp", "the new format wins");
    assert.ok(sameDisplay(p, fromServer(server)!));
    assert.ok(!sameDisplay(p, DEFAULT_DISPLAY));
});
