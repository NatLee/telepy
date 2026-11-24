import { test } from "node:test";
import assert from "node:assert/strict";
import { distance, fold, matchWord, queryWords, score } from "./fuzzy.ts";

test("text is folded before matching", () => {
    assert.equal(fold("ＳＳＨ Ｃｏｎｆｉｇ"), "ssh config");
    assert.equal(fold("Café"), "cafe");
    assert.deepEqual(queryWords("  Port   FORWARD "), ["port", "forward"]);
});

test("a word is found whole, abbreviated or misspelt", () => {
    const text = fold("Bring a device port to your computer (telepy forward, ssh -L)");
    assert.equal(matchWord("forward", text), 4);
    assert.equal(matchWord("ward", text), 3);
    assert.equal(matchWord("fwd", text), 2, "letters in order from the word's first letter");
    assert.equal(matchWord("forwrad", text), 1, "two letters swapped");
    assert.equal(matchWord("forwerd", text), 1);
    assert.equal(matchWord("-l", text), 4, "flags match as typed");
    assert.equal(matchWord("vpn", text), 0);
    assert.equal(matchWord("xyz", text), 0);
    // 短詞不猜錯字（不然什麼都中）。/ Short words aren't guessed at.
    assert.equal(matchWord("sshh", fold("ssh")), 1);
    assert.equal(matchWord("scq", fold("scp")), 0);
});

test("CJK queries match as substrings only", () => {
    assert.ok(matchWord("轉發", fold("把裝置的連接埠轉發到你的電腦")) >= 3);
    assert.equal(matchWord("轉送", fold("把裝置的連接埠轉發到你的電腦")), 0);
    assert.equal(matchWord("ポート", fold("ポート転送")), 4);
});

test("distance counts a swap as one edit and gives up early", () => {
    assert.equal(distance("forwrad", "forward", 2), 1);
    assert.equal(distance("abc", "abd", 1), 1);
    assert.equal(distance("abcdef", "uvwxyz", 2), 3);
});

test("every word must be found; titles count more than notes", () => {
    const f = (title: string, note: string) => [{ text: fold(title), weight: 3 }, { text: fold(note), weight: 1 }];
    assert.equal(score(queryWords("copy files"), f("Copy files", "scp or rsync")), 24);
    assert.equal(score(queryWords("copy vpn"), f("Copy files", "scp or rsync")), 0);
    assert.ok(score(queryWords("rsync"), f("Copy files", "scp or rsync")) < score(queryWords("copy"), f("Copy files", "scp or rsync")));
});
