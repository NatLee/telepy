import { test } from "node:test";
import assert from "node:assert/strict";
import { edgePan, FIT, fitScale, initialZoom, modeScale, percentLabel, PHONE_ZOOM, pinchZoom, remoteAt, scaleRange, stepScale, zoomAround, zoomLayout, type Bounds } from "./desktopZoom.ts";

// 手機上的 VNC：1280×800 塞進 368×230 的框。/ A phone frame showing a 1280×800 VNC desktop.
const frame = { width: 368, height: 230 };
const desk = { width: 1280, height: 800 };
const b: Bounds = { fit: fitScale(frame, desk), unit: 1 };

const near = (a: number, c: number) => assert.ok(Math.abs(a - c) < 1e-6, `${a} ≈ ${c}`);

test("fitScale is the contain scale, never capped", () => {
    near(fitScale(frame, desk), 368 / 1280);
    // 小桌面、大框：放大（以前停在 1:1）。/ A small desktop in a large frame grows (it used to stop at 1:1).
    near(fitScale({ width: 1600, height: 900 }, { width: 1024, height: 768 }), 900 / 768);
    assert.equal(fitScale({ width: 0, height: 0 }, desk), 1);
});

test("modes give their scale and stick across frame sizes", () => {
    const small = { width: 1024, height: 768 };
    const big = { fit: fitScale({ width: 1600, height: 900 }, small), unit: 1 };
    near(modeScale({ mode: "fit", scale: 1 }, big), 900 / 768);
    near(modeScale({ mode: "shrink", scale: 1 }, big), 1);
    near(modeScale({ mode: "actual", scale: 1 }, big), 1);
    // HiDPI：1:1 = 一個裝置像素 = 0.5 CSS px。/ With HiDPI 1:1 is one device pixel.
    near(modeScale({ mode: "actual", scale: 1 }, { fit: 0.8, unit: 0.5 }), 0.5);
    near(modeScale({ mode: "shrink", scale: 1 }, { fit: 0.8, unit: 0.5 }), 0.5);
    near(modeScale({ mode: "scale", scale: 2 }, big), 2);
});

test("zoomLayout at fit fills the frame without panning", () => {
    const l = zoomLayout(frame, desk, b, FIT);
    near(l.scale, b.fit);
    near(l.hostWidth, 368);
    near(l.hostHeight, 230);
    assert.equal(l.ox, 0);
    assert.equal(l.oy, 0);
});

test("zoomLayout clamps the pan to the content", () => {
    const l = zoomLayout(frame, desk, b, { mode: "scale", scale: b.fit * 2, ox: 9999, oy: -50 });
    near(l.hostWidth, 368);
    near(l.ox, 368 * 2 - 368);
    assert.equal(l.oy, 0);
    // 內容比框小：框縮成內容大小、不能平移。/ Smaller than the frame: no pan.
    const small = zoomLayout({ width: 1000, height: 800 }, { width: 400, height: 300 }, { fit: 2.5, unit: 1 }, { mode: "actual", scale: 1, ox: 40, oy: 40 });
    near(small.hostWidth, 400);
    near(small.hostHeight, 300);
    assert.equal(small.ox, 0);
    assert.equal(small.oy, 0);
});

test("pinchZoom keeps the remote point under the fingers", () => {
    const from = { x: 100, y: 60 };
    const before = remoteAt(frame, desk, b, FIT, from);
    const st = pinchZoom(frame, desk, b, FIT, from, from, 2);
    assert.equal(st.mode, "scale");
    near(st.scale, b.fit * 2);
    const after = remoteAt(frame, desk, b, st, from);
    near(after.x, before.x);
    near(after.y, before.y);
});

test("pinchZoom pans when the midpoint moves and stops at the edge", () => {
    const start = { mode: "scale" as const, scale: b.fit * 2, ox: 200, oy: 100 };
    const st = pinchZoom(frame, desk, b, start, { x: 150, y: 100 }, { x: 110, y: 80 }, 1);
    near(st.ox, 240);
    near(st.oy, 120);
    const edge = pinchZoom(frame, desk, b, start, { x: 150, y: 100 }, { x: 900, y: 900 }, 1);
    assert.equal(edge.ox, 0);
    assert.equal(edge.oy, 0);
});

test("the scale stays inside its range", () => {
    const { min, max } = scaleRange(b);
    near(min, 0.25);
    near(max, 4);
    // 塞進框比 25% 還小：最小就是塞進框。/ When fit is below 25 %, fit is the minimum.
    near(scaleRange({ fit: 0.1, unit: 1 }).min, 0.1);
    const out = pinchZoom(frame, desk, b, FIT, { x: 10, y: 10 }, { x: 10, y: 10 }, 0.01);
    near(out.scale, min);
    const big = pinchZoom(frame, desk, b, FIT, { x: 10, y: 10 }, { x: 10, y: 10 }, 100);
    near(big.scale, max);
    // 大框：可以縮到 25%。/ A large frame can go down to 25 %.
    near(scaleRange({ fit: 1.2, unit: 1 }).min, 0.25);
});

test("stepScale walks percent stops and the fit stop", () => {
    const big: Bounds = { fit: 0.8, unit: 1 };
    near(stepScale(1, 1, big), 1.1);
    near(stepScale(1, -1, big), 0.9);
    near(stepScale(0.9, -1, big), 0.8);
    near(stepScale(0.8, -1, big), 0.75);
    near(stepScale(4, 1, big), 4);
    near(stepScale(0.25, -1, big), 0.25);
    // HiDPI：站點是 1:1 的百分比。/ With HiDPI the stops are percentages of 1:1.
    near(stepScale(0.5, 1, { fit: 0.3, unit: 0.5 }), 0.55);
});

test("zoomAround the centre keeps the centre", () => {
    const c = { x: frame.width / 2, y: frame.height / 2 };
    const before = remoteAt(frame, desk, b, FIT, c);
    const st = zoomAround(frame, desk, b, FIT, c, { mode: "actual", scale: 1 });
    assert.equal(st.mode, "actual");
    const after = remoteAt(frame, desk, b, st, c);
    near(after.x, before.x);
    near(after.y, before.y);
});

test("initialZoom follows the preference and enlarges shrunk pictures on phones", () => {
    assert.deepEqual(initialZoom({ mode: "fit", percent: 100 }, b, false), FIT);
    assert.equal(initialZoom({ mode: "actual", percent: 100 }, b, true).mode, "actual");
    const phone = initialZoom({ mode: "fit", percent: 100 }, b, true);
    assert.equal(phone.mode, "scale");
    near(phone.scale, b.fit * PHONE_ZOOM);
    // 沒被縮小（RDP 跟著框）就不放大。/ Not shrunk (RDP sized to the frame): no enlarging.
    assert.equal(initialZoom({ mode: "fit", percent: 100 }, { fit: 1, unit: 1 }, true).mode, "fit");
    const custom = initialZoom({ mode: "custom", percent: 150 }, { fit: 0.8, unit: 0.5 }, false);
    near(custom.scale, 0.75);
});

test("percentLabel is relative to 1:1", () => {
    assert.equal(percentLabel(1, 1), "100%");
    assert.equal(percentLabel(0.5, 0.5), "100%");
    assert.equal(percentLabel(0.6667, 1), "67%");
});

test("edgePan scrolls near the clip box edges only", () => {
    const f = { width: 1000, height: 600 };
    const l = { hostWidth: 1000, hostHeight: 600 };
    assert.deepEqual(edgePan({ x: 500, y: 300 }, f, l), { x: 0, y: 0 });
    const left = edgePan({ x: 0, y: 300 }, f, l);
    near(left.x, -16);
    assert.equal(left.y, 0);
    const corner = edgePan({ x: 1000 - 8, y: 600 - 16 }, f, l);
    near(corner.x, 12);
    near(corner.y, 8);
    // 裁切框比框窄（置中）：框的空白處不捲。/ A narrower clip box is centred; the empty band does not scroll.
    assert.deepEqual(edgePan({ x: 50, y: 300 }, f, { hostWidth: 800, hostHeight: 600 }), { x: 0, y: 0 });
});
