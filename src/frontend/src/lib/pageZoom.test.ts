import { test } from "node:test";
import assert from "node:assert/strict";
import { cappedViewport, isZoomed, resetPageZoom, zoomBarStyle } from "./pageZoom.ts";

test("a page counts as zoomed a little over 1, not on rounding", () => {
    assert.equal(isZoomed(1), false);
    assert.equal(isZoomed(1.01), false);
    assert.equal(isZoomed(1.5), true);
    assert.equal(isZoomed(undefined), false);
});

test("the bar sits on the visible area at its normal size", () => {
    assert.deepEqual(zoomBarStyle({ scale: 2, offsetLeft: 100, offsetTop: 40, width: 180 }), { left: 100, top: 40, width: 360, transform: "scale(0.5)", transformOrigin: "0 0" });
    assert.equal(zoomBarStyle({ scale: 0, offsetLeft: 0, offsetTop: 0, width: 300 }).width, 300);
});

test("the reset pins the viewport to 1x without losing the rest", () => {
    assert.equal(cappedViewport("width=device-width, initial-scale=1"), "width=device-width, initial-scale=1, maximum-scale=1");
    assert.equal(cappedViewport("width=device-width, maximum-scale=5, initial-scale=2"), "width=device-width, initial-scale=1, maximum-scale=1");
});

function fakePage(scale: { v: number }, follows: boolean) {
    const meta = { content: "width=device-width, initial-scale=1", parentNode: { insertBefore() {} } };
    const doc = { querySelector: () => meta } as unknown as Document;
    const win = { visualViewport: { get scale() { return scale.v; } } } as unknown as Window;
    // 跟著 viewport 走的瀏覽器：一被定在 1 倍就縮回去。/ A browser that follows the viewport zooms back once it is pinned.
    const watch = setInterval(() => { if (follows && meta.content.includes("maximum-scale=1")) scale.v = 1; }, 20);
    return { meta, doc, win, stop: () => clearInterval(watch) };
}

test("the reset says whether the page really got back to 1x, and always restores the viewport", async () => {
    const a = fakePage({ v: 3 }, true);
    assert.equal(await resetPageZoom(a.doc, a.win), true);
    assert.equal(a.meta.content, "width=device-width, initial-scale=1");
    a.stop();
    const b = fakePage({ v: 3 }, false);
    assert.equal(await resetPageZoom(b.doc, b.win), false);
    assert.equal(b.meta.content, "width=device-width, initial-scale=1");
    b.stop();
});
