import { test } from "node:test";
import assert from "node:assert/strict";
import { festivalOn, lunarDate } from "./festivals.ts";

const TZ = "Asia/Taipei";
const at = (d: string) => new Date(`${d}T12:00:00+08:00`);

test("Telepy's birthday", () => {
    assert.deepEqual(festivalOn(at("2027-02-18"), TZ), { kind: "birthday", age: 3 });
    assert.deepEqual(festivalOn(at("2025-02-18"), TZ), { kind: "birthday", age: 1 });
    assert.deepEqual(festivalOn(at("2024-02-18"), TZ), { kind: "lunarNewYear" }); // 出生當天不算生日（那天剛好在新年裡）/ not a birthday on day zero
    assert.equal(festivalOn(at("2027-02-19"), TZ)?.kind === "birthday", false);
});

test("Lunar New Year: eve through the 15th day", () => {
    assert.deepEqual(lunarDate(at("2026-02-17"), TZ), { month: "1", day: 1 });
    assert.equal(festivalOn(at("2026-02-15"), TZ), null);
    assert.deepEqual(festivalOn(at("2026-02-16"), TZ), { kind: "lunarNewYear" }); // 除夕 / eve
    assert.deepEqual(festivalOn(at("2026-02-17"), TZ), { kind: "lunarNewYear" });
    assert.deepEqual(festivalOn(at("2026-03-03"), TZ), { kind: "lunarNewYear" }); // 元宵 / 15th
    assert.equal(festivalOn(at("2026-03-04"), TZ), null);
    assert.deepEqual(festivalOn(at("2028-01-26"), TZ), { kind: "lunarNewYear" });
});

test("leap months and ordinary days are not festivals", () => {
    assert.equal(lunarDate(at("2025-07-25"), TZ)?.month, "6bis");
    assert.equal(festivalOn(at("2025-07-25"), TZ), null);
    assert.equal(festivalOn(at("2026-10-28"), TZ), null);
});
