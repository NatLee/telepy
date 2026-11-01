import { test } from "node:test";
import assert from "node:assert/strict";
import {
    EMPTY_MEMORY,
    PEEK_CHANCE,
    afterPeek,
    calmPage,
    dayKey,
    festivalKey,
    konamiDone,
    luckyDay,
    parseMemory,
    peekDue,
    peekSpot,
    rememberOnce,
    seenOnce,
    type PeekCheck,
} from "./tapiCameos.ts";

const at = (d: string) => new Date(`${d}T15:00:00`);
const base: PeekCheck = { now: at("2026-11-02"), memory: EMPTY_MEMORY, salt: "abc", festival: null, enabled: true, reduced: false };

test("only calm pages", () => {
    for (const p of ["/tunnels", "/tunnels/", "/tunnels/keys", "/tunnels/keys/groups", "/tunnels/logs", "/tunnels/recordings", "/tunnels/cli", "/tunnels/api"]) assert.ok(calmPage(p), p);
    for (const p of ["/tunnels/terminal", "/tunnels/desktop", "/tunnels/network", "/tunnels/create", "/tunnels/sessions/watch", "/tunnels/admin/logs", "/login", "/tunnels/settings"]) assert.ok(!calmPage(p), p);
});

test("turned off or reduced motion: never", () => {
    for (let d = 1; d <= 28; d++) {
        const now = at(`2026-02-${String(d).padStart(2, "0")}`);
        assert.equal(peekDue({ ...base, now, enabled: false }), false);
        assert.equal(peekDue({ ...base, now, reduced: true, festival: "halloween" }), false);
    }
});

test("at most once every three days, on about half of the days", () => {
    const peeked = afterPeek(EMPTY_MEMORY, at("2026-11-02"), null);
    assert.equal(peekDue({ ...base, now: at("2026-11-03"), memory: peeked }), false);
    assert.equal(peekDue({ ...base, now: at("2026-11-04"), memory: peeked }), false);
    // 一整年：抽中的比例接近一半，而且每個瀏覽器、每一天固定。/ Over a year: about half, fixed per browser and day.
    let lucky = 0;
    for (let i = 0; i < 365; i++) {
        const day = dayKey(new Date(2026, 0, 1 + i));
        if (luckyDay(day, "browser-1")) lucky++;
        assert.equal(luckyDay(day, "browser-1"), luckyDay(day, "browser-1"));
    }
    assert.ok(Math.abs(lucky / 365 - PEEK_CHANCE) < 0.1, `${lucky}`);
    // 模擬一年、每天都在：最多每三天一次，大約一星期一次。/ A year of daily visits: never closer than three days, about weekly.
    let memory = EMPTY_MEMORY;
    const days: number[] = [];
    for (let i = 0; i < 365; i++) {
        const now = new Date(2026, 0, 1 + i, 15);
        if (peekDue({ ...base, now, memory, salt: "browser-1" })) {
            days.push(i);
            memory = afterPeek(memory, now, null);
        }
    }
    for (let k = 1; k < days.length; k++) assert.ok(days[k] - days[k - 1] >= 3);
    assert.ok(days.length >= 40 && days.length <= 90, `${days.length}`);
});

test("a festival day is guaranteed once", () => {
    const now = at("2026-10-31");
    const recent = afterPeek(EMPTY_MEMORY, at("2026-10-30"), null);
    assert.equal(peekDue({ ...base, now, memory: recent, festival: "halloween" }), true);
    const done = afterPeek(recent, now, "halloween");
    assert.ok(done.seen.includes(festivalKey("halloween", now)));
    assert.equal(peekDue({ ...base, now, memory: done, festival: "halloween" }), false);
    // 隔年再一次。/ Again the next year.
    assert.equal(peekDue({ ...base, now: at("2027-10-31"), memory: done, festival: "halloween" }), true);
});

test("memory survives odd storage", () => {
    assert.deepEqual(parseMemory(null), EMPTY_MEMORY);
    assert.deepEqual(parseMemory("not json"), EMPTY_MEMORY);
    assert.deepEqual(parseMemory('{"peekAt":"x","seen":[1,"a"]}'), { peekAt: null, seen: ["a"] });
    const m = rememberOnce(rememberOnce(EMPTY_MEMORY, "firstTunnel"), "firstTunnel");
    assert.deepEqual(m.seen, ["firstTunnel"]);
    assert.ok(seenOnce(m, "firstTunnel") && !seenOnce(m, "x"));
    assert.deepEqual(parseMemory(JSON.stringify(m)), m);
});

test("peek spot stays away from the edges", () => {
    for (let i = 0; i < 50; i++) {
        const x = peekSpot(`2026-01-${i}`, "s");
        assert.ok(x >= 0.15 && x <= 0.85);
    }
});

test("the Konami code", () => {
    const code = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
    assert.ok(konamiDone(code));
    assert.ok(konamiDone(["x", "Enter", ...code]));
    assert.ok(konamiDone([...code.slice(0, 8), "B", "A"]));
    assert.ok(!konamiDone(code.slice(1)));
    assert.ok(!konamiDone([...code, "x"]));
});
