import { test } from "node:test";
import assert from "node:assert/strict";
import { arrangeBySize, fitScale, placePositioned, presetChoices, screenChoices, type DetectedScreen } from "./desktopScreens.ts";

const laptop: DetectedScreen = { name: "eDP-1", x: 0, y: 0, width: 1920, height: 1080, primary: true };
const external: DetectedScreen = { name: "HDMI-1", x: 1920, y: 0, width: 2560, height: 1440, primary: false };

test("positioned screens are normalised and scaled to the framebuffer", () => {
    const fb = { width: 4480, height: 1440 };
    assert.deepEqual(placePositioned([laptop, external], fb), [
        { x: 0, y: 0, width: 1920, height: 1080 },
        { x: 1920, y: 0, width: 2560, height: 1440 },
    ]);
    // 負座標（外接在左邊）。/ Negative origin: the external screen on the left.
    const left = { ...external, x: -2560 };
    assert.deepEqual(placePositioned([laptop, left], fb), [
        { x: 2560, y: 0, width: 1920, height: 1080 },
        { x: 0, y: 0, width: 2560, height: 1440 },
    ]);
    // Windows 的 DPI 縮放：座標是 1x、畫面是 2x。/ DPI scaling: coordinates at 1x, the framebuffer at 2x.
    assert.deepEqual(placePositioned([laptop, external], { width: 8960, height: 2880 }), [
        { x: 0, y: 0, width: 3840, height: 2160 },
        { x: 3840, y: 0, width: 5120, height: 2880 },
    ]);
    assert.equal(placePositioned([laptop, external], { width: 1920, height: 1080 }), null, "does not fit");
    assert.equal(placePositioned([{ ...laptop, x: null, y: null }], fb), null, "no positions");
});

test("size-only screens are arranged by the framebuffer shape", () => {
    const mac: DetectedScreen = { name: "Color LCD", x: null, y: null, width: 1728, height: 1117, primary: true };
    const dell: DetectedScreen = { name: "DELL", x: null, y: null, width: 2560, height: 1440, primary: false };
    // 側排、上緣對齊（沒有探測）。/ Side by side, top-aligned without a probe.
    assert.deepEqual(arrangeBySize([mac, dell], { width: 4288, height: 1440 }), [
        { x: 0, y: 0, width: 1728, height: 1117 },
        { x: 1728, y: 0, width: 2560, height: 1440 },
    ]);
    // 探測說上面是黑的 → 筆電貼下緣。/ The probe finds black above the laptop: bottom-aligned.
    const blackAbove = (x: number, y: number) => x < 1728 && y < 323;
    assert.deepEqual(arrangeBySize([mac, dell], { width: 4288, height: 1440 }, blackAbove)?.[0], { x: 0, y: 323, width: 1728, height: 1117 });
    // 疊排。/ Stacked.
    assert.deepEqual(arrangeBySize([dell, mac], { width: 2560, height: 2557 }), [
        { x: 0, y: 0, width: 2560, height: 1440 },
        { x: 0, y: 1440, width: 1728, height: 1117 },
    ]);
    // 2x 畫面（Retina 原生像素）。/ A 2x framebuffer.
    assert.deepEqual(arrangeBySize([mac], { width: 3456, height: 2234 }), [{ x: 0, y: 0, width: 3456, height: 2234 }]);
    assert.equal(arrangeBySize([mac, dell], { width: 1728, height: 1117 }), null, "framebuffer shows one screen only");
    assert.equal(arrangeBySize([], { width: 100, height: 100 }), null);
});

test("presets follow the aspect ratio", () => {
    assert.deepEqual(presetChoices({ width: 1920, height: 1080 }), []);
    const two = presetChoices({ width: 3840, height: 1080 });
    assert.deepEqual(two.map((c) => c.preset), ["left", "right", "third1", "third2", "third3"]);
    assert.deepEqual(two[1].viewport, { x: 1920, y: 0, width: 1920, height: 1080 });
    assert.deepEqual(presetChoices({ width: 2560, height: 1080 }).map((c) => c.preset), ["left", "right"]);
    assert.deepEqual(presetChoices({ width: 1080, height: 2160 }).map((c) => c.preset), ["top", "bottom"]);
    assert.deepEqual(presetChoices({ width: 0, height: 0 }), []);
});

test("screenChoices prefers detected screens and hides a single whole screen", () => {
    const fb = { width: 4480, height: 1440 };
    const detected = screenChoices([laptop, external], fb);
    assert.equal(detected.length, 2);
    assert.equal(detected[0].name, "eDP-1");
    assert.equal(detected[0].primary, true);
    assert.deepEqual(detected[1].viewport, { x: 1920, y: 0, width: 2560, height: 1440 });
    assert.deepEqual(screenChoices([laptop], { width: 1920, height: 1080 }), [], "one screen = the whole picture");
    // Xvfb 會多列一個涵蓋整張畫面的 monitor：它就是「整個桌面」，不另外列。/ Xvfb's whole-screen monitor is dropped.
    const whole: DetectedScreen = { name: "screen", x: 0, y: 0, width: 2048, height: 768, primary: true };
    const left: DetectedScreen = { name: "left-eye", x: 0, y: 0, width: 1024, height: 768, primary: false };
    const right: DetectedScreen = { name: "right-eye", x: 1024, y: 0, width: 1024, height: 768, primary: false };
    assert.deepEqual(screenChoices([left, right, whole], { width: 2048, height: 768 }).map((c) => c.name), ["left-eye", "right-eye"]);
    assert.deepEqual(screenChoices([], { width: 3840, height: 1080 }).map((c) => c.preset), ["left", "right", "third1", "third2", "third3"]);
    assert.deepEqual(screenChoices([laptop, external], { width: 1920, height: 1080 }), [], "detected screens that don't fit, normal ratio: nothing");
});

test("fitScale never upscales past the cap", () => {
    assert.equal(fitScale({ width: 1280, height: 720 }, { x: 0, y: 0, width: 2560, height: 1440 }), 0.5);
    assert.equal(fitScale({ width: 4000, height: 4000 }, { x: 0, y: 0, width: 1920, height: 1080 }), 1);
    assert.equal(fitScale({ width: 4000, height: 4000 }, { x: 0, y: 0, width: 1920, height: 1080 }, 0.5), 0.5);
    assert.equal(fitScale({ width: 0, height: 0 }, { x: 0, y: 0, width: 1920, height: 1080 }), 1);
});
