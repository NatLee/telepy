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

test("each page has its own scene", async () => {
    const { sceneFor, TAPI_SCENES, SCENE_LINES } = await import("./tapiStage.ts");
    assert.deepEqual(["signin", "oauth", "cli", "consent"].map((p) => sceneFor(p as "signin")), ["tea", "mail", "terminal", "desk"]);
    for (const s of TAPI_SCENES) assert.equal(new Set(SCENE_LINES[s]).size, 3);
});

test("scene accessories: centred sunglasses at the counter, a letter for the post, nothing on the back", async () => {
    const { sceneSprite, SUNGLASSES, SUNGLASSES_AT } = await import("./tapiStage.ts");
    const cells = (rows: string[]) => rows.join("");
    // 墨鏡在臉的正中間：眼睛（第 8–10 與 15–17 欄）的中線是 12.5，鏡框也是。/ Centred on the face: the eyes' centre line is 12.5, so is the frame's.
    const eyes = [...MASCOT_POSES.idle[11]].flatMap((c, x) => (c === "E" ? [x] : []));
    const eyeMid = (Math.min(...eyes) + Math.max(...eyes)) / 2;
    assert.equal(SUNGLASSES_AT.x + (SUNGLASSES[0].length - 1) / 2, eyeMid);
    for (const mood of ["idle", "stamp", "careful", "bye"] as const) {
        const s = sceneSprite(mood, "desk");
        const lenses = s.slice(9, 13).join("");
        assert.ok(lenses.includes("K") && lenses.includes("Q"), mood);
        // 眼睛整個被墨鏡蓋住，嘴巴還在。/ The eyes are fully covered; the mouth is still there.
        assert.ok(!s.slice(9, 13).some((r) => r.slice(6, 20).includes("E")), mood);
        assert.ok(s.slice(13, 16).join("").includes("E"), mood);
    }
    // 黑色鏡片左右對稱。/ The black lenses mirror each other.
    const k = sceneSprite("idle", "desk").slice(9, 13).map((r) => r.slice(6, 20).replace(/[^K]/g, "."));
    assert.ok(k.every((r, y) => [...r].every((c, x) => c === "." || ["K", "Q"].includes(sceneSprite("idle", "desk")[9 + y][6 + 13 - x]))));
    assert.ok(cells(sceneSprite("idle", "mail")).includes("W"));
    assert.ok(!/[KQW]/.test(cells(sceneSprite("shy", "desk"))));
    assert.ok(!/[QW]/.test(cells(sceneSprite("shy", "mail"))));
    assert.deepEqual(sceneSprite("idle", "tea"), [...MASCOT_POSES.idle]);
    // 大小不變。/ Same size.
    for (const scene of ["tea", "mail", "terminal", "desk"] as const) {
        const s = sceneSprite("idle", scene);
        assert.equal(s.length, MASCOT_POSES.idle.length);
        assert.ok(s.every((r) => r.length === MASCOT_POSES.idle[0].length));
    }
});

test("approval-page reactions", () => {
    assert.equal(moodFor({ ...calm, flash: "careful" }), "careful");
    assert.equal(moodFor({ ...calm, flash: "stamp", hovering: true }), "stamp");
    assert.equal(moodFor({ ...calm, flash: "bye" }), "bye");
    assert.equal(MOOD_POSE.careful, "surprised");
    assert.equal(moodLine("done"), "done");
});

test("paper planes fly right, come back from the left and leave a trail", async () => {
    const { makePlanes, planeAt, planeCount, PLANE_LAYERS } = await import("./tapiStage.ts");
    assert.deepEqual(makePlanes(8, 2), makePlanes(8, 2));
    assert.equal(planeCount(390, 844), 5);
    assert.equal(planeCount(3840, 2160), 14);
    const p = { y: 0.5, x0: 0, layer: 2 as const, phase: 0 };
    const a = planeAt(p, 1, 1200, 800);
    const b = planeAt(p, 2, 1200, 800);
    assert.ok(b.x > a.x);
    assert.equal(Math.abs(a.x % a.unit), 0);
    assert.equal(a.trail.length, 5);
    assert.ok(a.trail.every((d, k) => d.x < a.x && (k === 0 || d.x < a.trail[k - 1].x)));
    const loop = (1200 + a.size * 2 + 160) / PLANE_LAYERS[2].speed;
    assert.ok(Math.abs(planeAt(p, 1 + loop, 1200, 800).x - a.x) <= PLANE_LAYERS[2].unit);
    for (const f of makePlanes(20)) for (const t of [0, 3, 50]) {
        const at = planeAt(f, t, 1200, 800);
        assert.ok(at.y > -40 && at.y < 840, `${at.y}`);
    }
});

test("terminal glyphs come from the set and change now and then", async () => {
    const { glyphAt, GLYPHS } = await import("./tapiStage.ts");
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
        assert.equal(glyphAt(i, 0.1), glyphAt(i, 0.2));
        for (const t of [0, 10, 20, 30]) seen.add(glyphAt(i, t));
    }
    assert.ok([...seen].every((c) => GLYPHS.includes(c)));
    assert.ok(seen.size > 8);
});

test("stamps: appear, settle, fade, at most one per slot", async () => {
    const { stampAt, STAMP_SLOTS, STAMP_ROUND, STAMP_OK, STAMP_CHECK } = await import("./tapiStage.ts");
    assert.equal(STAMP_OK.length, 9);
    assert.ok(STAMP_OK.every((r) => r.length === 16));
    assert.ok(STAMP_CHECK.every((r) => r.length === STAMP_CHECK[0].length));
    let shown = 0;
    for (let i = 0; i < 200; i++) {
        const t = i * 0.37;
        const visible = Array.from({ length: STAMP_SLOTS }, (_, s) => stampAt(s, t)).filter(Boolean);
        shown = Math.max(shown, visible.length);
        for (const m of visible) {
            assert.ok(m!.x >= 0 && m!.x <= 1 && m!.y >= 0 && m!.y <= 1);
            assert.ok(m!.alpha >= 0 && m!.alpha <= 1 && m!.scale >= 1 && m!.scale <= 1.35);
        }
    }
    assert.ok(shown >= 3 && shown <= STAMP_SLOTS);
    // 同一輪的位置固定，下一輪換地方。/ Fixed within a round, somewhere else the next.
    const a = stampAt(0, 1)!;
    assert.deepEqual([a.x, a.y], [stampAt(0, 2)!.x, stampAt(0, 2)!.y]);
    const next = stampAt(0, 1 + STAMP_ROUND)!;
    assert.notDeepEqual([a.x, a.y], [next.x, next.y]);
});
