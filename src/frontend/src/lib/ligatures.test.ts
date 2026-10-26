import { test } from "node:test";
import assert from "node:assert/strict";
import { LIGATURE_SEQUENCES, ligatureFeatureSettings, ligatureRanges } from "./ligatures.ts";

test("ligature ranges are longest-first, non-overlapping and left to right", () => {
    assert.deepEqual(ligatureRanges("a -> b"), [[2, 4]]);
    // `-->` 整個算,不是 `--` + `>`;`<=>` 不被拆成 `<=` + `>`。/ Longest match wins.
    assert.deepEqual(ligatureRanges("x --> y <=> z"), [[2, 5], [8, 11]]);
    assert.deepEqual(ligatureRanges("a != b == c"), [[2, 4], [7, 9]]);
    assert.deepEqual(ligatureRanges("plain text"), []);
    assert.deepEqual(ligatureRanges(""), []);
    // 自訂序列。/ Custom sequences.
    assert.deepEqual(ligatureRanges("ab", ["ab"]), [[0, 2]]);
});

test("the sequence list is sorted longest first and the feature settings are explicit both ways", () => {
    for (let i = 1; i < LIGATURE_SEQUENCES.length; i++) assert.ok(LIGATURE_SEQUENCES[i - 1].length >= LIGATURE_SEQUENCES[i].length);
    assert.match(ligatureFeatureSettings(true), /"calt" on/);
    assert.match(ligatureFeatureSettings(false), /"calt" off/);
});
