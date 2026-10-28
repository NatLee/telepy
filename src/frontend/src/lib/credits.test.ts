import { test } from "node:test";
import assert from "node:assert/strict";
import { center, creditsCast, displayWidth } from "./credits.ts";
import { parseCast } from "./asciicast.ts";

test("display width counts wide characters twice", () => {
    assert.equal(displayWidth("Telepy"), 6);
    assert.equal(displayWidth("粉圓"), 4);
    assert.equal(displayWidth("\x1b[2mabc\x1b[0m"), 3);
    assert.equal(center("ab", 6), "  ab");
    assert.equal(center("粉圓", 8), "  粉圓");
});

test("credits make a playable cast that ends on the thank-you", () => {
    const text = creditsCast([{ title: "Typefaces", lines: ["jf-openhuninn (粉圓)"] }], { title: "Telepy", tagline: "Reverse SSH", thanks: "Thanks", width: 40, height: 12 });
    const cast = parseCast(text);
    assert.equal(cast.width, 40);
    assert.equal(cast.height, 12);
    assert.ok(cast.events.length > 10);
    assert.ok(cast.duration > 5);
    const all = cast.events.map((e) => e.data).join("");
    assert.ok(all.includes("Typefaces") && all.includes("粉圓") && all.includes("Thanks"));
    // 最後一句有字的是謝謝。/ The last line with text is the thank-you.
    const texts = cast.events.map((e) => e.data.replace(/\x1b\[[^m]*[mHl]/g, "").trim()).filter(Boolean);
    assert.ok(texts.at(-1)?.includes("Thanks"));
    // 每一列都不超過寬度。/ No line is wider than the terminal.
    for (const e of cast.events) for (const l of e.data.split("\r\n")) assert.ok(displayWidth(l.replace(/\x1b\[[^m]*[mHl]/g, "")) <= 40, l);
});
