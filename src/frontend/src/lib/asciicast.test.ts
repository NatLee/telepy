import { test } from "node:test";
import assert from "node:assert/strict";
import { clock, countUntil, parseCast, parseSize } from "./asciicast.ts";

const file = [
    JSON.stringify({ version: 2, width: 120, height: 40, title: "bob on box" }),
    JSON.stringify([0.5, "o", "hello"]),
    JSON.stringify([1.0, "r", "100x30"]),
    JSON.stringify([31.0, "o", "after a long pause"]),
    '[31.5, "o", "half writ', // 還在錄的檔最後一行可能不完整 / a live file's partial last line
].join("\n");

test("parses the header and squeezes long pauses", () => {
    const c = parseCast(file, 2);
    assert.deepEqual([c.width, c.height, c.title], [120, 40, "bob on box"]);
    assert.deepEqual(c.events.map((e) => e.kind), ["o", "r", "o"]);
    assert.deepEqual(c.events.map((e) => e.t), [0.5, 1.0, 3.0], "the 30 s pause becomes 2 s");
    assert.equal(c.duration, 3.0);
});

test("seek helpers", () => {
    const { events } = parseCast(file, 2);
    assert.equal(countUntil(events, 0), 0);
    assert.equal(countUntil(events, 1.0), 2);
    assert.equal(countUntil(events, 99), 3);
    assert.deepEqual(parseSize("100x30"), { cols: 100, rows: 30 });
    assert.equal(parseSize("bad"), null);
    assert.equal(clock(65), "1:05");
    assert.equal(clock(3723), "1:02:03");
});
