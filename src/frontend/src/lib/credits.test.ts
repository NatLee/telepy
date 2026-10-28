import { test } from "node:test";
import assert from "node:assert/strict";
import { artColumns, artRow, center, CREDIT_ART, CREDIT_LINES, creditsCast, displayWidth, shadowArt, tapiArt, tapiFinale, type PixelArt } from "./credits.ts";
import { parseCast } from "./asciicast.ts";
import { CLIP_COLORS, MASCOT_PALETTE } from "./mascot.ts";

const LOOK = { clip: "#8de6cf", festival: null };
const CSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** 把整段播一遍，回傳最後的畫面（極簡終端機：\r\n 捲動、CUP、清整列，其他跳脫碼忽略）。 */
/** Plays a cast and returns the final screen (a tiny terminal: \r\n scrolls, CUP, erase line; other escapes ignored). */
function screenAfter(text: string): { rows: string[]; bgs: (string | null)[][] } {
    const cast = parseCast(text);
    const rows = Array.from({ length: cast.height }, () => " ".repeat(cast.width));
    const bgs: (string | null)[][] = Array.from({ length: cast.height }, () => Array(cast.width).fill(null));
    let r = cast.height - 1;
    let c = 0;
    let fill: string | null = null;
    const put = (ch: string) => {
        if (c >= cast.width) return;
        rows[r] = rows[r].slice(0, c) + ch + rows[r].slice(c + 1);
        bgs[r][c] = fill;
        c += displayWidth(ch);
    };
    for (const e of cast.events) {
        const d = e.data;
        for (let i = 0; i < d.length; ) {
            if (d.startsWith("\r\n", i)) {
                if (r === cast.height - 1) {
                    rows.shift();
                    rows.push(" ".repeat(cast.width));
                    bgs.shift();
                    bgs.push(Array(cast.width).fill(null));
                } else r++;
                c = 0;
                i += 2;
                continue;
            }
            const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(d.slice(i));
            if (m) {
                const [p, k] = [m[1], m[2]];
                if (k === "H") [r, c] = p.split(";").map((n) => Number(n) - 1);
                if (k === "K") {
                    rows[r] = " ".repeat(cast.width);
                    bgs[r] = Array(cast.width).fill(null);
                }
                if (k === "m") fill = p === "0" ? null : p.startsWith("48;2;") ? p.slice(5) : fill;
                i += m[0].length;
                continue;
            }
            put(d[i]);
            i++;
        }
    }
    return { rows: rows.map((x) => x.trimEnd()), bgs };
}

test("display width counts wide characters twice", () => {
    assert.equal(displayWidth("Telepy"), 6);
    assert.equal(displayWidth("粉圓"), 4);
    assert.equal(displayWidth("\x1b[2mabc\x1b[0m"), 3);
    assert.equal(center("ab", 6), "  ab");
    assert.equal(center("粉圓", 8), "  粉圓");
});

test("contributors come first", () => {
    assert.equal(Object.keys(CREDIT_LINES)[0], "contributors");
    assert.ok(CREDIT_LINES.contributors.some((l) => l.includes("@NatLee")));
});

test("a picture row is background-coloured cells, two columns per pixel", () => {
    const art: PixelArt = { rows: [".AB."], palette: { A: "#ff0000", B: "#00ff00" } };
    assert.equal(artColumns(art), 8);
    assert.equal(artRow(".AB.", art.palette, 0, 20), "  \x1b[48;2;255;0;0m  \x1b[48;2;0;255;0m  \x1b[0m");
    // 超出畫面的像素不畫。/ Pixels off screen are skipped.
    assert.equal(artRow(".AB.", art.palette, -4, 20), "\x1b[48;2;0;255;0m  \x1b[0m");
    assert.equal(artRow(".AB.", art.palette, 18, 20), "");
    // 只有空白，沒有半格字元。/ Only spaces, never half blocks.
    assert.equal(artRow(".AB.", art.palette, 3, 20).replace(CSI, "").trim(), "");
});

test("every picture fits the default screen and uses only its palette", () => {
    for (const art of [...Object.values(CREDIT_ART), tapiArt("happy", LOOK)]) {
        assert.ok(art && artColumns(art) <= 56 && art.rows.length <= 20);
        for (const row of art!.rows) for (const c of row) assert.ok(c === "." || art!.palette[c], `${c} has no colour`);
    }
});

test("the shadow hides Tapi's face and clips", () => {
    const shadow = shadowArt(tapiArt("happy", LOOK));
    const colours = new Set(Object.values(shadow.palette));
    assert.equal(colours.size, 2);
    assert.ok(!colours.has(MASCOT_PALETTE.F) && !colours.has(MASCOT_PALETTE.O));
});

test("the unlock finale shows every clip colour", () => {
    const seen = new Set(tapiFinale("unlock", LOOK).float.map((f) => f.palette.F));
    assert.deepEqual([...seen].sort(), CLIP_COLORS.map(([, hex]) => hex).sort());
    assert.equal(tapiFinale("owned", { clip: "#ffe27a", festival: null }).rest.palette.F, "#ffe27a");
});

test("credits make a playable cast that ends on the thank-you", () => {
    const text = creditsCast([{ title: "Typefaces", lines: ["jf-openhuninn (粉圓)"] }], { title: "Telepy", tagline: "Reverse SSH", thanks: "Thanks", width: 40, height: 12 });
    const cast = parseCast(text);
    assert.equal(cast.width, 40);
    assert.equal(cast.height, 12);
    assert.ok(cast.events.length > 10);
    assert.ok(cast.duration > 3);
    const all = cast.events.map((e) => e.data).join("");
    assert.ok(all.includes("Typefaces") && all.includes("粉圓") && all.includes("Thanks"));
    // 最後一句有字的是謝謝，停在畫面中間。/ The last line with text is the thank-you, resting mid-screen.
    const screen = screenAfter(text).rows;
    assert.equal(screen.findLastIndex((l) => l.trim()), screen.findIndex((l) => l.includes("Thanks")));
    assert.ok(Math.abs(screen.findIndex((l) => l.includes("Thanks")) - 6) <= 1);
});

test("no line is wider than the screen", () => {
    const sections = Object.entries(CREDIT_LINES).map(([k, lines]) => ({ title: k, lines: [...lines], art: CREDIT_ART[k as keyof typeof CREDIT_ART], note: "and you" }));
    const text = creditsCast(sections, { title: "Telepy", tagline: "Reverse SSH", thanks: "Thanks", hint: "Psst", finale: tapiFinale("unlock", LOOK) });
    for (const e of parseCast(text).events) for (const l of e.data.split(/\r\n|\x1b\[\d+;\d+H/)) assert.ok(displayWidth(l.replace(CSI, "")) <= 56, JSON.stringify(l));
});

test("the finale leaves Tapi in the middle under the thank-you and the hint", () => {
    const art = tapiArt("idle", LOOK);
    const text = creditsCast([{ title: "Mascot", lines: ["Tapi"], art }], { title: "Telepy", tagline: "x", thanks: "Thanks", hint: "Psst", finale: tapiFinale("owned", LOOK) });
    const { rows, bgs } = screenAfter(text);
    const thanks = rows.findIndex((l) => l.includes("Thanks"));
    assert.equal(rows[thanks + 1].trim(), "Psst");
    // Tapi 的列在謝謝下面、置中，畫的是背景色。/ Tapi's rows are below the thank-you, centred, in background colour.
    const painted = bgs.map((r) => r.map((b, i) => (b ? i : -1)).filter((i) => i >= 0));
    const tapiRows = painted.map((cols, i) => (cols.length ? i : -1)).filter((i) => i >= 0);
    assert.ok(tapiRows.length >= 8 && tapiRows[0] > thanks + 1 && tapiRows.at(-1)! <= 18);
    const left = Math.min(...tapiRows.map((i) => painted[i][0]));
    const right = Math.max(...tapiRows.map((i) => painted[i].at(-1)!));
    assert.ok(Math.abs(left - (55 - right)) <= 2, `${left}..${right}`);
    // 髮夾是帳號的顏色。/ The clips are the account's colour.
    assert.ok(bgs.flat().includes("141;230;207"));
});

test("the shadow finale never shows the clip colours", () => {
    const text = creditsCast([], { title: "Telepy", tagline: "x", thanks: "Thanks", hint: "Psst", finale: tapiFinale("shadow", LOOK) });
    assert.ok(!text.includes("141;230;207") && !text.includes("242;138;56"));
});

test("every translated line in the cast fits the screen", async () => {
    const { en } = await import("../locales/en.ts");
    const { zhTW } = await import("../locales/zh-TW.ts");
    const { ja } = await import("../locales/ja.ts");
    const keys = Object.keys(en).filter((k) => /^about\.credits(?!Description|$|FindTapi)/.test(k)) as (keyof typeof en)[];
    assert.ok(keys.includes("about.creditsWhoIsThis") && keys.includes("about.creditsContributorsNote"));
    for (const dict of [en, zhTW, ja] as Record<string, string>[]) for (const k of keys) assert.ok(displayWidth(dict[k]) <= 56, `${k}: ${dict[k]}`);
});
