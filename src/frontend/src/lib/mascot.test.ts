import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MASCOT_PALETTE, MASCOT_POSES, mirrored, pixelRuns, spriteSize } from "./mascot.ts";

// 與後端 / CLI 共用的像素格必須一模一樣。/ The grids must match the backend / CLI copy exactly.
const RUST = readFileSync(new URL("../../../backend-api/src/mascot.rs", import.meta.url), "utf8");

function rustSprite(name: string): string[] {
    const m = new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`).exec(RUST);
    assert.ok(m, `${name} in mascot.rs`);
    return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

test("sprites match mascot.rs", () => {
    const names = { idle: "IDLE", happy: "HAPPY", wave: "WAVE", surprised: "SURPRISED", sideA: "SIDE_A", sideB: "SIDE_B" } as const;
    for (const [pose, rust] of Object.entries(names)) {
        assert.deepEqual([...MASCOT_POSES[pose as keyof typeof names]], rustSprite(rust), pose);
    }
});

test("palette matches mascot.rs", () => {
    const rust = Object.fromEntries(
        [...RUST.matchAll(/\('(\w)', \[0x(\w\w), 0x(\w\w), 0x(\w\w)\]\)/g)].map((m) => [m[1], `#${m[2]}${m[3]}${m[4]}`]),
    );
    assert.deepEqual(rust, MASCOT_PALETTE);
});

test("runs cover every coloured pixel once", () => {
    for (const sprite of Object.values(MASCOT_POSES)) {
        const { w, h } = spriteSize(sprite);
        const seen = new Set<string>();
        for (const r of pixelRuns(sprite)) {
            for (let x = r.x; x < r.x + r.w; x++) {
                const k = `${x},${r.y}`;
                assert.ok(!seen.has(k));
                seen.add(k);
                assert.equal(MASCOT_PALETTE[sprite[r.y][x]], r.fill);
            }
        }
        const coloured = sprite.join("").replace(/\./g, "").length;
        assert.equal(seen.size, coloured);
        assert.ok(w > 0 && h > 0);
    }
    assert.deepEqual(pixelRuns(["OO.D"]), [
        { x: 0, y: 0, w: 2, fill: MASCOT_PALETTE.O },
        { x: 3, y: 0, w: 1, fill: MASCOT_PALETTE.D },
    ]);
});

test("mirror", () => {
    assert.equal(mirrored(MASCOT_POSES.sideA)[5], "DOOOEEOOEEHD");
});

test("clip colours match mascot.rs and rotate daily", async () => {
    const { CLIP_COLORS, clipName, clipHex, unixDay } = await import("./mascot.ts");
    const rust = [...RUST.matchAll(/\("(\w+)", \[0x(\w\w), 0x(\w\w), 0x(\w\w)\]\)/g)].map((m) => [m[1], `#${m[2]}${m[3]}${m[4]}`]);
    assert.deepEqual(rust, CLIP_COLORS.map(([n, h]) => [n, h]));
    assert.equal(clipHex("teal"), MASCOT_PALETTE.F); // 預設就是原本的顏色 / the default is the drawn colour
    assert.equal(clipName("grape", 0), "grape");
    assert.equal(clipName("", 3), "teal");
    // 與 mascot.rs 同一條規則：day % 6。/ Same rule as mascot.rs: day % 6.
    const week = [0, 1, 2, 3, 4, 5, 6].map((d) => clipName("daily", 20_000 + d));
    assert.equal(week[0], week[6]);
    assert.equal(new Set(week.slice(0, 6)).size, 6);
    assert.equal(week[0], CLIP_COLORS[20_000 % 6][0]);
    assert.equal(unixDay(Date.UTC(2026, 9, 28, 23, 59)), unixDay(Date.UTC(2026, 9, 28, 0, 0)));
});

test("festive outfits", async () => {
    const { dressTapi } = await import("./mascot.ts");
    const plain = dressTapi(MASCOT_POSES.idle, { clip: "#ffb3c7", festival: null });
    assert.deepEqual(plain.sprite, [...MASCOT_POSES.idle]);
    assert.equal(plain.palette.F, "#ffb3c7");
    // 新年：十字變紅、兩個中心變金。/ Lunar New Year: red crosses, two gold centres.
    const lny = dressTapi(MASCOT_POSES.idle, { clip: "#ffb3c7", festival: "lunarNewYear" });
    const joined = lny.sprite.join("");
    assert.ok(!joined.includes("F"));
    assert.equal([...joined].filter((c) => c === "Y").length, 2);
    // 生日：正面戴派對帽，迷你版不戴。/ Birthday: a party hat on front poses only.
    const bday = dressTapi(MASCOT_POSES.idle, { clip: "#8de6cf", festival: "birthday" });
    assert.ok(bday.sprite[0].includes("Y") && bday.sprite[3].includes("ZZZ"));
    assert.deepEqual(dressTapi(MASCOT_POSES.sideA, { clip: "#8de6cf", festival: "birthday" }).sprite, [...MASCOT_POSES.sideA]);

    // 萬聖節：床單蓋住臉與身體，下擺露出橘色，兩個眼洞，十字照舊；轉過身（沒有臉）就沒有洞。
    // Halloween: a sheet over the face and body, the orange hem below, two eye holes, clips kept; no face = no holes.
    const boo = dressTapi(MASCOT_POSES.idle, { clip: "#8de6cf", festival: "halloween" });
    const top = boo.sprite.slice(0, 19).join("");
    assert.ok(!/[OSHPTE]/.test(top));
    assert.equal([...top].filter((c) => c === "K").length, 12);
    assert.ok(boo.sprite.slice(19).join("").includes("O"));
    assert.equal([...boo.sprite.join("")].filter((c) => c === "F").length, [...MASCOT_POSES.idle.join("")].filter((c) => c === "F").length);
    const faceless = MASCOT_POSES.idle.map((r) => r.replace(/[EPTH]/g, "O"));
    assert.ok(!dressTapi(faceless, { clip: "#8de6cf", festival: "halloween" }).sprite.join("").includes("K"));
    assert.ok(dressTapi(MASCOT_POSES.sideA, { clip: "#8de6cf", festival: "halloween" }).sprite.join("").includes("K"));
});
