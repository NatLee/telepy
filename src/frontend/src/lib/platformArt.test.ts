import { test } from "node:test";
import assert from "node:assert/strict";
import { PLATFORMS } from "./devicePlatforms.ts";
import { PLATFORM_ART, pixelRuns } from "./platformArt.ts";

test("every platform has art, rectangular and fully coloured", () => {
    for (const { id } of PLATFORMS) {
        const art = PLATFORM_ART[id];
        assert.ok(art, id);
        const width = art.rows[0].length;
        assert.ok(width <= 16 && art.rows.length <= 16, `${id} stays tiny`);
        for (const row of art.rows) {
            assert.equal(row.length, width, `${id}: ${row}`);
            for (const ch of row) assert.ok(ch === "." || /^#[0-9a-f]{6}$/i.test(art.palette[ch] ?? ""), `${id}: ${ch}`);
        }
    }
});

test("pixelRuns merges runs and skips transparency", () => {
    const runs = pixelRuns({ rows: ["aa.b", "...."], palette: { a: "#000000", b: "#ffffff" } });
    assert.deepEqual(runs, [
        { x: 0, y: 0, w: 2, fill: "#000000" },
        { x: 3, y: 0, w: 1, fill: "#ffffff" },
    ]);
});
