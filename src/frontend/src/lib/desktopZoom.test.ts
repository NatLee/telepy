import { test } from "node:test";
import assert from "node:assert/strict";
import { FIT, maxZoom, pinchZoom, remoteAt, stepZoom, zoomAround, zoomLabel, zoomLayout } from "./desktopZoom.ts";

// 手機上的 VNC：1280×800 塞進 368×230 的框。/ A phone frame showing a 1280×800 VNC desktop.
const frame = { width: 368, height: 230 };
const desk = { width: 1280, height: 800 };
const fit = 368 / 1280;

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);

test("zoomLayout at fit fills the frame without panning", () => {
    const l = zoomLayout(frame, desk, fit, FIT);
    near(l.scale, fit);
    near(l.hostWidth, 368);
    near(l.hostHeight, 230);
    assert.equal(l.ox, 0);
    assert.equal(l.oy, 0);
});

test("zoomLayout clamps the pan to the content", () => {
    const l = zoomLayout(frame, desk, fit, { zoom: 2, ox: 9999, oy: -50 });
    near(l.hostWidth, 368);
    near(l.ox, 368 * 2 - 368);
    assert.equal(l.oy, 0);
    // 內容比框小（小桌面、大框）：框縮成內容大小、不能平移。/ Smaller than the frame: no pan.
    const small = zoomLayout({ width: 1000, height: 800 }, { width: 400, height: 300 }, 1, { zoom: 1.5, ox: 40, oy: 40 });
    near(small.hostWidth, 600);
    near(small.hostHeight, 450);
    assert.equal(small.ox, 0);
    assert.equal(small.oy, 0);
});

test("pinchZoom keeps the remote point under the fingers", () => {
    const from = { x: 100, y: 60 };
    const before = remoteAt(frame, desk, fit, FIT, from);
    const st = pinchZoom(frame, desk, fit, FIT, from, from, 2);
    near(st.zoom, 2);
    const after = remoteAt(frame, desk, fit, st, from);
    near(after.x, before.x);
    near(after.y, before.y);
});

test("pinchZoom pans when the midpoint moves", () => {
    const start = { zoom: 2, ox: 200, oy: 100 };
    const st = pinchZoom(frame, desk, fit, start, { x: 150, y: 100 }, { x: 110, y: 80 }, 1);
    near(st.zoom, 2);
    near(st.ox, 240);
    near(st.oy, 120);
    // 拖到邊界就停。/ Panning stops at the edge.
    const edge = pinchZoom(frame, desk, fit, start, { x: 150, y: 100 }, { x: 900, y: 900 }, 1);
    assert.equal(edge.ox, 0);
    assert.equal(edge.oy, 0);
});

test("pinchZoom never goes below fit or above the maximum", () => {
    const out = pinchZoom(frame, desk, fit, { zoom: 1.5, ox: 50, oy: 20 }, { x: 10, y: 10 }, { x: 10, y: 10 }, 0.2);
    assert.deepEqual(out, FIT);
    const big = pinchZoom(frame, desk, fit, FIT, { x: 10, y: 10 }, { x: 10, y: 10 }, 100);
    near(big.zoom, maxZoom(fit));
});

test("maxZoom allows about two CSS pixels per remote pixel on small screens", () => {
    near(maxZoom(fit), 2 / fit);
    assert.equal(maxZoom(1), 4);
    assert.equal(maxZoom(0), 4);
});

test("stepZoom walks the steps and stops at the ends", () => {
    assert.equal(stepZoom(1, 1, fit), 1.5);
    assert.equal(stepZoom(1.5, 1, fit), 2);
    assert.equal(stepZoom(1.7, -1, fit), 1.5);
    assert.equal(stepZoom(1, -1, fit), 1);
    near(stepZoom(6.5, 1, fit), maxZoom(fit));
    assert.equal(stepZoom(4, 1, 1), 4);
});

test("zoomAround the centre keeps the centre", () => {
    const c = { x: frame.width / 2, y: frame.height / 2 };
    const before = remoteAt(frame, desk, fit, FIT, c);
    const st = zoomAround(frame, desk, fit, FIT, c, 3);
    const after = remoteAt(frame, desk, fit, st, c);
    near(after.x, before.x);
    near(after.y, before.y);
});

test("zoomLabel", () => {
    assert.equal(zoomLabel(1), "1×");
    assert.equal(zoomLabel(1.5), "1.5×");
    assert.equal(zoomLabel(2.04), "2×");
    assert.equal(zoomLabel(6.96), "7×");
});
