import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NAME_PROBLEM_KEY, TUNNEL_NAME_MAX, badChars, sameTunnelName, sshSafeName, suggestTunnelName, tunnelNameProblem } from "./tunnelName.ts";

test("names follow OpenSSH host names, like the backend", () => {
    for (const ok of ["box", "MyBox", "pi-4", "nas_01", "web.prod", "3d-printer", "a", "x".repeat(63)]) {
        assert.equal(tunnelNameProblem(ok), null, ok);
        assert.ok(sshSafeName(ok));
    }
    assert.equal(tunnelNameProblem(""), "name_empty");
    assert.equal(tunnelNameProblem("x".repeat(64)), "name_too_long");
    for (const first of ["-box", ".box", "_box"]) assert.equal(tunnelNameProblem(first), "name_first_char", first);
    for (const bad of ["My Box", "a\tb", "box*", "box?", "!box", "a,b", "100%", "a#b", "a$b", "a;b", "a|b", "a'b", 'a"b', "a`b", "a(b)", "a{b}", "a<b>", "a&b", "a\\b", "pi@box", "box:22", "a/b", "客廳NAS", "café"]) {
        assert.equal(tunnelNameProblem(bad), "name_chars", bad);
    }
});

test("the same rule as the Rust module", () => {
    // 兩邊的規則必須一樣：長度上限與錯誤代碼直接比對 Rust 原始碼。/ Both sides agree: the limit and codes from the Rust source.
    const rust = readFileSync(new URL("../../../backend-api/src/tunnel_name.rs", import.meta.url), "utf8");
    assert.match(rust, new RegExp(`pub const MAX_LEN: usize = ${TUNNEL_NAME_MAX};`));
    for (const code of Object.keys(NAME_PROBLEM_KEY)) assert.ok(rust.includes(`"${code}"`), code);
    assert.ok(rust.includes("c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')"), "the same character set");
    // Rust 測試裡的建議與這裡的一致。/ The suggestions in the Rust tests match ours.
    for (const [raw, want] of [...rust.matchAll(/assert_eq!\(suggest\("([^"\\]*)"\), "([^"]*)"\);/g)].map((m) => [m[1], m[2]])) {
        assert.equal(suggestTunnelName(raw), want, raw);
    }
});

test("suggestions are always valid", () => {
    assert.equal(suggestTunnelName("My Box!"), "My-Box");
    assert.equal(suggestTunnelName("  Nat's MacBook Pro  "), "Nat-s-MacBook-Pro");
    assert.equal(suggestTunnelName("客廳 NAS"), "NAS");
    assert.equal(suggestTunnelName("客廳"), "device");
    assert.equal(suggestTunnelName(`${"x".repeat(62)}-tail`), "x".repeat(62));
    for (const raw of ["My Box!", "  ", "-", "x".repeat(200), "a.b_c-d", "%%%", "我的 Mac (2)"]) {
        assert.equal(tunnelNameProblem(suggestTunnelName(raw)), null, raw);
    }
});

test("the offending characters, and case", () => {
    assert.deepEqual(badChars("my box @ home"), [" ", "@"]);
    assert.deepEqual(badChars("ok-name"), []);
    assert.deepEqual(badChars("客廳"), ["客", "廳"]);
    assert.ok(sameTunnelName("MyBox", "mybox"));
    assert.ok(!sameTunnelName("mybox", "mybox2"));
});
