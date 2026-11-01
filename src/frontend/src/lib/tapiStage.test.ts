import { test } from "node:test";
import assert from "node:assert/strict";
import { MASCOT_POSES } from "./mascot.ts";
import {
    FLASH_MS,
    MOOD_MOTION,
    MOOD_POSE,
    PEARL_LAYERS,
    PEARL_SPRITE,
    SLEEP_AFTER_SECS,
    backView,
    makePearls,
    moodFor,
    moodLine,
    moodSprite,
    pearlAt,
    pearlCount,
    pixelGlyph,
    pixelWord,
    type StageInput,
} from "./tapiStage.ts";

const calm: StageInput = { focus: null, passwordShown: false, submitting: false, flash: null, hovering: false, idleSecs: 0 };

test("Tapi follows the form", () => {
    assert.equal(moodFor(calm), "idle");
    assert.equal(moodFor({ ...calm, focus: "username" }), "watching");
    assert.equal(moodFor({ ...calm, focus: "password" }), "shy");
    assert.equal(moodFor({ ...calm, focus: "password", passwordShown: true }), "peek");
    assert.equal(moodFor({ ...calm, focus: "code" }), "mfa");
    assert.equal(moodFor({ ...calm, focus: "other" }), "idle");
    assert.equal(moodFor({ ...calm, hovering: true }), "wave");
    assert.equal(moodFor({ ...calm, idleSecs: SLEEP_AFTER_SECS }), "sleepy");
});

test("reactions and signing in come first", () => {
    assert.equal(moodFor({ ...calm, focus: "password", submitting: true }), "thinking");
    assert.equal(moodFor({ ...calm, focus: "password", submitting: true, flash: "oops" }), "oops");
    assert.equal(moodFor({ ...calm, flash: "yay", idleSecs: 999 }), "yay");
    assert.equal(moodFor({ ...calm, focus: "username", hovering: true }), "watching"); // 打字時不揮手 / no waving while typing
    assert.equal(moodFor({ ...calm, hovering: true, idleSecs: 999 }), "wave"); // 滑鼠來了就醒 / the pointer wakes it up
    for (const ms of Object.values(FLASH_MS)) assert.ok(ms >= 1000 && ms <= 4000);
});

test("every mood has a sprite, a motion, and a line unless it shows the typed lines", () => {
    for (const mood of Object.keys(MOOD_POSE) as (keyof typeof MOOD_POSE)[]) {
        assert.ok(moodSprite(mood).length > 0, mood);
        assert.ok(MOOD_MOTION[mood], mood);
        assert.equal(moodLine(mood) === null, mood === "idle" || mood === "sleepy", mood);
    }
});

test("turned around: mirrored, no face, clips kept", () => {
    const back = backView(MASCOT_POSES.idle);
    assert.equal(back.length, MASCOT_POSES.idle.length);
    assert.ok(back.every((r) => !/[EPTH]/.test(r)));
    const clips = (rows: readonly string[]) => rows.join("").split("").filter((c) => c === "F").length;
    assert.equal(clips(back), clips(MASCOT_POSES.idle));
    // 輪廓左右對稱翻過來。/ The silhouette is the mirror image.
    const shape = (rows: readonly string[]) => rows.map((r) => r.replace(/[^.]/g, "#"));
    assert.deepEqual(shape(back), shape(MASCOT_POSES.idle).map((r) => [...r].reverse().join("")));
});

test("pixel wordmark", () => {
    const { glyphs, advance } = pixelWord("Telepy");
    assert.equal(glyphs.length, 6);
    assert.ok(advance > 0);
    for (const g of glyphs) {
        assert.equal(new Set(g.rows.map((r) => r.length)).size, 1);
        const cells = g.rows.join("");
        assert.ok(cells.includes("F") && cells.includes("D") && cells.includes("S"));
        assert.ok(/^[.FDS]+$/.test(cells));
    }
    // 下伸部的字母（p、y）比 T 往下長。/ Descenders reach lower than the T.
    const lowest = (rows: string[]) => rows.reduce((m, r, y) => (r.includes("F") ? y : m), 0);
    assert.ok(lowest(pixelGlyph("p")!.rows) > lowest(pixelGlyph("T")!.rows));
    assert.equal(pixelGlyph("?"), null);
    // 比例字寬：l 比 T 窄。/ Proportional widths: l is narrower than T.
    assert.ok(pixelGlyph("l")!.rows[0].length < pixelGlyph("T")!.rows[0].length);
});

test("pearls: seeded, in three layers, crisp and inside the cup", () => {
    assert.deepEqual(makePearls(20, 3), makePearls(20, 3));
    assert.notDeepEqual(makePearls(20, 3), makePearls(20, 4));
    const pearls = makePearls(30);
    assert.deepEqual(new Set(pearls.map((p) => p.layer)), new Set([0, 1, 2]));
    assert.ok(pearls.filter((p) => p.layer === 0).length > pearls.filter((p) => p.layer === 2).length);
    assert.equal(PEARL_SPRITE.length, 8);
    for (const p of pearls) {
        for (const t of [0, 1.3, 17, 400]) {
            const at = pearlAt(p, t, 1280, 800);
            const unit = PEARL_LAYERS[p.layer].unit;
            assert.equal(at.size, 8 * unit);
            assert.equal(Math.abs(at.x % unit), 0);
            assert.equal(Math.abs(at.y % unit), 0);
            assert.ok(at.y >= -at.size - unit && at.y <= 800 + at.size + unit, `${at.y}`);
            assert.ok(at.x >= -PEARL_LAYERS[p.layer].sway - unit && at.x <= 1280, `${at.x}`);
        }
    }
});

test("pearls rise, then come back from below", () => {
    const p = { x: 0.5, y0: 0, layer: 2 as const, phase: 0 };
    const a = pearlAt(p, 1, 1000, 600);
    const b = pearlAt(p, 2, 1000, 600);
    assert.ok(b.y < a.y);
    const loop = (600 + a.size * 2) / PEARL_LAYERS[2].speed;
    assert.ok(Math.abs(pearlAt(p, 1 + loop, 1000, 600).y - a.y) <= PEARL_LAYERS[2].unit);
});

test("pearl count follows the area", () => {
    assert.equal(pearlCount(0, 0), 10);
    assert.equal(pearlCount(390, 844), 10);
    assert.equal(pearlCount(1280, 800), 26);
    assert.equal(pearlCount(3840, 2160), 36);
});
