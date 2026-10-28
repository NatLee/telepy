import { test } from "node:test";
import assert from "node:assert/strict";
import {
    BURST_PUSH,
    CYCLE_SECS,
    FIELD_DOTS,
    FIELD_HALF,
    FIELD_RADIUS,
    MAX_RATIO,
    ORBITS,
    PUSH,
    PUSH_RADIUS,
    RIPPLE_SECS,
    WAVE_DELAY,
    alphaStep,
    approach,
    backingRatio,
    burst,
    cubicBezier,
    dotTarget,
    fieldDots,
    orbitPoint,
    pulse,
    spinAngle,
    toField,
    wave,
} from "./discreetField.ts";

const close = (a: number, b: number, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test("cubic-bezier matches CSS at the ends, is monotonic and linear when it should be", () => {
    const ease = cubicBezier(0.22, 0.61, 0.36, 1);
    assert.equal(ease(0), 0);
    assert.equal(ease(1), 1);
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
        const v = ease(i / 100);
        assert.ok(v >= prev - 1e-9, "monotonic");
        prev = v;
    }
    const linear = cubicBezier(0, 0, 1, 1);
    for (const x of [0.1, 0.37, 0.5, 0.9]) close(linear(x), x);
    // easeOutCubic ≈ cubic-bezier(0.33, 1, 0.68, 1)
    const out = cubicBezier(0.33, 1, 0.68, 1);
    for (const x of [0.2, 0.5, 0.8]) close(out(x), 1 - (1 - x) ** 3, 0.03);
});

test("a dot flashes once per cycle after its delay: brightest and doubled at 5 %, gone by 22 %", () => {
    const delay = 1.2;
    assert.deepEqual(pulse(delay - 0.01, delay), { alpha: 0, scale: 1 }, "nothing before the ripple arrives");
    const peak = pulse(delay + 0.05 * CYCLE_SECS, delay);
    close(peak.alpha, 1);
    close(peak.scale, 2);
    assert.equal(pulse(delay + 0.3 * CYCLE_SECS, delay).alpha, 0);
    // 下一輪一樣。/ The next cycle repeats.
    close(pulse(delay + CYCLE_SECS + 0.05 * CYCLE_SECS, delay).alpha, 1);
    // 中途是平滑的（沒有跳格）。/ Smooth in between (no jumps).
    let prev = pulse(delay, delay).alpha;
    for (let i = 1; i <= 200; i++) {
        const a = pulse(delay + (i / 200) * 0.25 * CYCLE_SECS, delay).alpha;
        assert.ok(Math.abs(a - prev) < 0.12, `step ${i}: ${prev} → ${a}`);
        prev = a;
    }
});

test("the wavefront travels with the dots' flashes", () => {
    assert.equal(wave(WAVE_DELAY - 0.01), null);
    const start = wave(WAVE_DELAY);
    assert.ok(start && start.r < 0.02 && start.alpha > 0.8);
    // 中間的點閃到最亮時，波前剛好在那裡。/ When a mid dot peaks, the front is there.
    const t = 0.5;
    const w = wave(t * RIPPLE_SECS + WAVE_DELAY);
    assert.ok(w);
    close(w.r, t, 0.01);
    close(pulse(t * RIPPLE_SECS + WAVE_DELAY, t * RIPPLE_SECS).alpha, 1);
    assert.equal(wave(WAVE_DELAY + RIPPLE_SECS + 0.01), null, "gone after crossing the radius");
    assert.ok(wave(WAVE_DELAY + CYCLE_SECS), "and back next cycle");
});

test("a ring from the word grows, fades and ends", () => {
    const a = burst(0);
    assert.ok(a && a.r < 0.05 && a.alpha > 0.85 && a.strength === 1);
    const mid = burst(1.1);
    assert.ok(mid && mid.r > 0.8 && mid.alpha < 0.2);
    assert.equal(burst(2.2), null);
    assert.equal(burst(-0.1), null);
});

test("the pointer pushes nearby dots away and lights them; far dots stay", () => {
    const dot = { x: 100, y: 0, r: 100 };
    const near = dotTarget(dot, { x: 90, y: 0 }, []);
    assert.ok(near.x > 0 && near.x <= PUSH && Math.abs(near.y) < 1e-9, "pushed straight away from the pointer");
    assert.ok(near.heat > 0.9);
    assert.deepEqual(dotTarget(dot, { x: 100 - PUSH_RADIUS - 1, y: 0 }, []), { x: 0, y: 0, heat: 0 });
    assert.deepEqual(dotTarget(dot, null, []), { x: 0, y: 0, heat: 0 });
    // 波經過：往外推。/ A passing ring pushes outward.
    const ring = dotTarget(dot, null, [{ r: 100, strength: 1 }]);
    close(ring.x, BURST_PUSH);
    close(ring.heat, 1);
    // 中心那點不會被波推（沒有方向）。/ The centre dot has no outward direction.
    assert.deepEqual(dotTarget({ x: 0, y: 0, r: 0 }, null, [{ r: 0, strength: 1 }]), { x: 0, y: 0, heat: 0 });
});

test("screen offsets rotate into the turning field", () => {
    const a = Math.PI / 2;
    const p = toField(0, 10, a);
    close(p.x, 10);
    close(p.y, 0);
    close(spinAngle(0), 0);
    close(spinAngle(80), Math.PI / 2);
});

test("orbits start at the top and turn their own way", () => {
    const [inner, outer] = ORBITS;
    const top = orbitPoint(inner.r, inner.period, 0);
    close(top.x, 0);
    close(top.y, -inner.r);
    assert.ok(orbitPoint(inner.r, inner.period, inner.period / 4).x > 0, "clockwise");
    assert.ok(orbitPoint(outer.r, outer.period, -outer.period / 4).x < 0, "reverse");
});

test("easing approaches the target without overshooting, at any frame rate", () => {
    let v = 0;
    for (let i = 0; i < 6; i++) v = approach(v, 10, 1 / 60, 0.1);
    let w = 0;
    for (let i = 0; i < 12; i++) w = approach(w, 10, 1 / 120, 0.1);
    close(v, w, 1e-9);
    assert.ok(v > 0 && v < 10);
    assert.equal(approach(3, 10, 0, 0.1), 3);
    assert.ok(approach(0, 10, 5, 0.1) > 9.99);
});

test("the canvas draws at real screen pixels, inside the preview's scale too", () => {
    assert.equal(backingRatio(2, []), 2);
    close(backingRatio(2, [0.4]), 0.8);
    assert.equal(backingRatio(3, []), MAX_RATIO);
    assert.equal(backingRatio(2, [0.01]), 0.25);
    assert.equal(backingRatio(Number.NaN, [Number.NaN]), 1);
});

test("the field fits the canvas and fades toward the rim", () => {
    const dots = fieldDots();
    assert.equal(dots.length, FIELD_DOTS);
    for (const d of dots) assert.ok(d.r <= FIELD_RADIUS + 0.2 && d.r + PUSH < FIELD_HALF);
    assert.equal(dots[0].o, 0.35, "the centre sits under the word");
    assert.equal(dots[dots.length - 1].o, 0, "the rim fades out");
    close(dots[dots.length - 1].delay, RIPPLE_SECS);
    assert.equal(alphaStep(0), 0);
    assert.equal(alphaStep(1), 32);
    assert.equal(alphaStep(2), 32);
});
