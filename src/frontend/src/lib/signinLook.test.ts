import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LOOK, messageProblem, parseSignInLook, styleOf, sunflower, tidyMessage } from "./signinLook.ts";

test("the public endpoint and the cache both parse", () => {
    assert.deepEqual(parseSignInLook({ style: "discreet", oauth_style: "standard", message: "Hi" }), { style: "discreet", oauthStyle: "standard", message: "Hi" });
    assert.deepEqual(parseSignInLook({ style: "standard", oauthStyle: "discreet", message: "" }), { style: "standard", oauthStyle: "discreet", message: "" });
    // 不認得的樣子、缺欄位、不是物件 → null（頁面改用預設或重抓）。/ Unknown looks or shapes → null.
    assert.equal(parseSignInLook({ style: "neon", oauth_style: "standard" }), null);
    assert.equal(parseSignInLook({ style: "discreet" }), null);
    assert.equal(parseSignInLook(null), null);
    assert.equal(parseSignInLook("discreet"), null);
    assert.equal(parseSignInLook({ style: "discreet", oauth_style: "discreet", message: 3 })?.message, "");
});

test("each page reads its own look", () => {
    const look = { ...DEFAULT_LOOK, oauthStyle: "discreet" as const };
    assert.equal(styleOf(look, "signin"), "standard");
    assert.equal(styleOf(look, "oauth"), "discreet");
});

test("the line is tidied and limited like the backend", () => {
    assert.equal(tidyMessage("  Hello \r\n  world  \n"), "Hello\n  world");
    assert.equal(messageProblem("   "), null, "blank = the built-in lines");
    assert.equal(messageProblem("字".repeat(200)), null, "counted in characters");
    assert.equal(messageProblem("x".repeat(201)), "tooLong");
    assert.equal(messageProblem("a\nb\nc"), null);
    assert.equal(messageProblem("a\nb\nc\nd"), "tooManyLines");
    assert.equal(messageProblem("a\nb\nc\n\n  "), null, "trailing blank lines are trimmed first");
});

test("the sunflower starts at the centre, stays inside the radius and is deterministic", () => {
    const dots = sunflower(400, 360);
    assert.equal(dots.length, 400);
    assert.deepEqual(dots[0], { x: 0, y: 0, t: 0 });
    assert.equal(dots[399].t, 1);
    for (const d of dots) {
        assert.ok(Math.hypot(d.x, d.y) <= 360.2, `${d.x},${d.y} is outside`);
        assert.ok(d.t >= 0 && d.t <= 1);
    }
    assert.deepEqual(sunflower(400, 360), dots, "server and browser render the same field");
    // 越往外越遠（t 單調遞增），漣漪的延遲才會由內往外。/ t grows outward, so the ripple delay does too.
    assert.ok(dots.every((d, i) => i === 0 || d.t >= dots[i - 1].t));
    assert.deepEqual(sunflower(0, 100), []);
    assert.deepEqual(sunflower(1, 100), [{ x: 0, y: 0, t: 0 }]);
});
