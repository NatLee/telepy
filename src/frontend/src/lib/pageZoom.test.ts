import { test } from "node:test";
import assert from "node:assert/strict";
import { isZoomed, withMaxScale, zoomBarStyle } from "./pageZoom.ts";

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

test("the reset caps the zoom at 1 without losing the rest of the viewport", () => {
    assert.equal(withMaxScale("width=device-width, initial-scale=1"), "width=device-width, initial-scale=1, maximum-scale=1");
    assert.equal(withMaxScale("width=device-width, maximum-scale=5"), "width=device-width, maximum-scale=1");
});
