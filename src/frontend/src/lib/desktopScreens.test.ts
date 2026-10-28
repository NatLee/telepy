import { test } from "node:test";
import assert from "node:assert/strict";
import { arrangeBySize, guessScreens, parseStoredArea, placePositioned, rectFromPoints, screenChoices, splitChoices, type DetectedScreen } from "./desktopScreens.ts";

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

test("even splits are always on offer", () => {
    const all = splitChoices({ width: 3840, height: 1080 });
    assert.deepEqual(all.map((c) => c.preset), ["left", "right", "third1", "third2", "third3", "top", "bottom"]);
    assert.deepEqual(all[1].viewport, { x: 1920, y: 0, width: 1920, height: 1080 });
    assert.deepEqual(all[4].viewport, { x: 2560, y: 0, width: 1280, height: 1080 });
    assert.deepEqual(all[6].viewport, { x: 0, y: 540, width: 3840, height: 540 });
    // 正常比例的單螢幕也給（兩顆一樣大的螢幕並排就是 2:1 左右）。/ A normal picture gets them too.
    assert.deepEqual(splitChoices({ width: 1920, height: 1080 }).map((c) => c.preset), ["left", "right", "third1", "third2", "third3", "top", "bottom"]);
    assert.deepEqual(splitChoices({ width: 150, height: 100 }).map((c) => c.preset), ["left", "right"], "too narrow for thirds, too short for halves");
    assert.deepEqual(splitChoices({ width: 0, height: 0 }), []);
});

test("screenChoices lists detected screens and hides the whole-screen entry", () => {
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
    assert.deepEqual(screenChoices([], { width: 3840, height: 1080 }).map((c) => [c.guessed, c.viewport.x, c.viewport.width]), [[true, 0, 1920], [true, 1920, 1920]], "nothing detected: guessed from the shape");
    assert.deepEqual(screenChoices([whole], { width: 2048, height: 768 }).map((c) => [c.guessed, c.viewport.width]), [[true, 1024], [true, 1024]], "only a whole-picture monitor reported: guessed too");
    assert.deepEqual(screenChoices([laptop, external], { width: 1920, height: 1080 }), [], "detected screens that don't fit, one common ratio: nothing");
});

test("guessScreens reads the layout off the framebuffer shape", () => {
    const rect = (s: DetectedScreen) => [s.x, s.y, s.width, s.height];
    // 兩顆 16:9 並排。/ Two 16:9 side by side.
    const two = guessScreens({ width: 3840, height: 1080 });
    assert.deepEqual(two.map(rect), [[0, 0, 1920, 1080], [1920, 0, 1920, 1080]]);
    assert.ok(two[0].name.startsWith("16:9") && two[0].primary && !two[1].primary);
    // 三顆、四顆。/ Three and four.
    assert.deepEqual(guessScreens({ width: 5760, height: 1080 }).map(rect), [[0, 0, 1920, 1080], [1920, 0, 1920, 1080], [3840, 0, 1920, 1080]]);
    assert.equal(guessScreens({ width: 7680, height: 1080 }).length, 4);
    // 兩顆 4:3（Xvfb 測試機）。/ Two 4:3 (the Xvfb device).
    assert.deepEqual(guessScreens({ width: 2048, height: 768 }).map(rect), [[0, 0, 1024, 768], [1024, 0, 1024, 768]]);
    // 16:10 + 16:9 等高 → 混合比例也找得到；沒有黑色區域可看時寬的在前。/ Mixed ratios at equal height; wider first.
    const mixed = guessScreens({ width: 1920 + 2133, height: 1200 });
    assert.deepEqual(mixed.map((s) => s.width), [2133, 1920]);
    // 單一常見比例 = 一顆，不猜（含超寬）。/ One common ratio, ultrawide included: one screen.
    assert.deepEqual(guessScreens({ width: 1920, height: 1080 }), []);
    assert.deepEqual(guessScreens({ width: 3440, height: 1440 }), []);
    assert.deepEqual(guessScreens({ width: 2560, height: 1080 }), []);
    assert.deepEqual(guessScreens({ width: 1728, height: 1117 }), [], "MacBook");
    // 疊放。/ Stacked.
    assert.deepEqual(guessScreens({ width: 1920, height: 2160 }).map(rect), [[0, 0, 1920, 1080], [0, 1080, 1920, 1080]]);
    // 怪形狀 → 空。/ Odd shapes: nothing.
    assert.deepEqual(guessScreens({ width: 3000, height: 1080 }), []);
    assert.deepEqual(guessScreens({ width: 100, height: 50 }), []);
});

test("guessScreens measures a shorter screen from the black area", () => {
    // 1920×1080 筆電在左、2560×1440 螢幕在右，筆電貼下緣：左段上方 360px 是黑的。
    // A 1920×1080 laptop left of a 2560×1440 monitor, bottom-aligned: the top 360px of the left segment are black.
    const fb = { width: 4480, height: 1440 };
    const probe = (x: number, y: number) => x < 1920 && y < 360;
    const got = guessScreens(fb, probe);
    assert.deepEqual(got.map((s) => [s.x, s.y, s.width, s.height]), [[0, 360, 1920, 1080], [1920, 0, 2560, 1440]]);
    assert.ok(got[0].name.startsWith("16:9 · 1920×1080"), got[0].name);
    // 全黑桌布：量到的高度湊不出常見比例就不採用，保留整張高。/ A black wallpaper: no common ratio, keep the full height.
    const dark = (x: number, y: number) => !(x >= 100 && x < 700 && y >= 200 && y < 500);
    assert.deepEqual(guessScreens({ width: 3840, height: 1080 }, dark).map((s) => s.height), [1080, 1080]);
    // MacBook（1728×1117）在右、2560×1440 在左、貼上緣：1728 ÷ 1440 不是任何比例，只有量黑色區域才找得到。
    // A MacBook right of a 2560×1440 monitor, top-aligned: only the black area reveals it.
    const mac = { width: 4288, height: 1440 };
    const macProbe = (x: number, y: number) => x >= 2560 && y >= 1117;
    assert.deepEqual(guessScreens(mac, macProbe).map((s) => [s.x, s.y, s.width, s.height]), [[0, 0, 2560, 1440], [2560, 0, 1728, 1117]]);
    assert.deepEqual(guessScreens(mac), [], "without a probe that shape is unknown");
});

test("a dragged rectangle becomes a custom area", () => {
    const fb = { width: 2048, height: 768 };
    assert.deepEqual(rectFromPoints({ x: 1100.4, y: 50.6 }, { x: 1900, y: 700 }, fb), { x: 1100, y: 51, width: 800, height: 649 });
    assert.deepEqual(rectFromPoints({ x: 1900, y: 700 }, { x: 1100, y: 51 }, fb), { x: 1100, y: 51, width: 800, height: 649 }, "any corner order");
    assert.deepEqual(rectFromPoints({ x: -50, y: -50 }, { x: 3000, y: 3000 }, fb), { x: 0, y: 0, width: 2048, height: 768 }, "clamped to the picture");
    assert.equal(rectFromPoints({ x: 10, y: 10 }, { x: 40, y: 400 }, fb), null, "too narrow = a click, not an area");
});

test("stored custom areas are validated against the picture", () => {
    const fb = { width: 2048, height: 768 };
    assert.deepEqual(parseStoredArea('{"x":100,"y":0,"width":900,"height":768}', fb), { x: 100, y: 0, width: 900, height: 768 });
    assert.equal(parseStoredArea('{"x":1500,"y":0,"width":900,"height":768}', fb), null, "sticks out of the picture");
    assert.equal(parseStoredArea('{"x":0,"y":0,"width":10,"height":10}', fb), null, "too small");
    assert.equal(parseStoredArea("garbage", fb), null);
    assert.equal(parseStoredArea(null, fb), null);
    assert.equal(parseStoredArea('{"x":"0","y":0,"width":900,"height":768}', fb), null);
});

