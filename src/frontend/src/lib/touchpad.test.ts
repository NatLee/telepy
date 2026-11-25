import { test } from "node:test";
import assert from "node:assert/strict";
import { moveCursor, PAD_IDLE, padStep, readTouchMode, type PadAction, type PadEvent } from "./touchpad.ts";

test("pointer mode is the default", () => {
    assert.equal(readTouchMode(null), "pointer");
    assert.equal(readTouchMode("touch"), "touch");
    assert.equal(readTouchMode("nonsense"), "pointer");
});

test("slow moves are 1:1, flicks speed up, and the cursor stays on the screen", () => {
    const size = { width: 400, height: 600 };
    assert.deepEqual(moveCursor({ x: 100, y: 100 }, 3, 0, size), { x: 103, y: 100 });
    const fast = moveCursor({ x: 100, y: 100 }, 40, 0, size);
    assert.ok(fast.x > 140 && fast.x <= 220, String(fast.x));
    assert.deepEqual(moveCursor({ x: 10, y: 590 }, -200, 200, size), { x: 0, y: 599 });
});

function run(events: PadEvent[]): PadAction[] {
    let s = PAD_IDLE; const out: PadAction[] = [];
    for (const e of events) { const r = padStep(s, e); s = r.state; out.push(...r.actions); }
    return out;
}
const at = (x: number, y: number) => ({ x, y });

test("a quick tap clicks; a slow one doesn't", () => {
    assert.deepEqual(run([{ type: "start", at: at(10, 10), fingers: 1, t: 0 }, { type: "end", at: at(10, 10), fingers: 0, t: 120 }]), [{ kind: "click", button: "left" }]);
    assert.deepEqual(run([{ type: "start", at: at(10, 10), fingers: 1, t: 0 }, { type: "end", at: at(10, 10), fingers: 0, t: 900 }]), []);
});

test("small moves count once past 8 px, and nothing clicks", () => {
    const a = run([
        { type: "start", at: at(100, 100), fingers: 1, t: 0 },
        { type: "move", at: at(104, 100), fingers: 1, t: 10 },
        { type: "move", at: at(110, 100), fingers: 1, t: 20 },
        { type: "move", at: at(113, 100), fingers: 1, t: 30 },
        { type: "end", at: at(113, 100), fingers: 0, t: 40 },
    ]);
    assert.deepEqual(a, [{ kind: "move", dx: 10, dy: 0 }, { kind: "move", dx: 3, dy: 0 }]);
});

test("holding still presses the button, moving drags, lifting releases", () => {
    const a = run([
        { type: "start", at: at(0, 0), fingers: 1, t: 0 },
        { type: "hold", t: 450 },
        { type: "move", at: at(0, 20), fingers: 1, t: 500 },
        { type: "end", at: at(0, 20), fingers: 0, t: 600 },
    ]);
    assert.deepEqual(a, [{ kind: "down" }, { kind: "move", dx: 0, dy: 20 }, { kind: "up" }]);
});

test("two fingers: a tap right-clicks, a slide scrolls a step per 30 px", () => {
    assert.deepEqual(run([
        { type: "start", at: at(0, 0), fingers: 1, t: 0 }, { type: "start", at: at(20, 0), fingers: 2, t: 10 },
        { type: "end", at: at(0, 0), fingers: 1, t: 100 }, { type: "end", at: at(0, 0), fingers: 0, t: 110 },
    ]), [{ kind: "click", button: "right" }]);
    assert.deepEqual(run([
        { type: "start", at: at(0, 0), fingers: 2, t: 0 },
        { type: "move", at: at(0, 40), fingers: 2, t: 10 },
        { type: "move", at: at(0, 75), fingers: 2, t: 20 },
        { type: "end", at: at(0, 75), fingers: 0, t: 30 },
    ]), [{ kind: "scroll", x: 0, y: 1 }, { kind: "scroll", x: 0, y: 1 }]);
});
