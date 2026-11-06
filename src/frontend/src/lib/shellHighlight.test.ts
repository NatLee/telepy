import { test } from "node:test";
import assert from "node:assert/strict";
import { highlightShell, type ShellKind } from "./shellHighlight.ts";

const TREE = { lan: ["ls", "wake"], forward: [], examples: [], browse: ["text", "close"], ssh: [], login: [], exec: [] };
const kinds = (line: string) => highlightShell(line, TREE).filter((p) => p.kind !== "space").map((p) => `${p.kind}:${p.text}`);

test("joined back, the pieces are the line", () => {
    for (const line of [
        "telepy forward <tunnel>@<account> 192.168.1.20:8080 --open",
        'ID=$(telepy browse <tunnel> http://192.168.1.1/)',
        'telepy lan edit box nas --labels rack-2,prod --note "top shelf, UPS on the left"',
        "export TELEPY_TOKEN=tpt_…",
        "telepy ls --json | jq '.[] | .name'  # names only",
        "",
    ]) {
        assert.equal(highlightShell(line, TREE).map((p) => p.text).join(""), line);
    }
});

test("commands, subcommands, flags and placeholders", () => {
    assert.deepEqual(kinds("telepy lan wake <tunnel> 192.168.1.20"), ["telepy:telepy", "sub:lan", "sub:wake", "placeholder:<tunnel>", "arg:192.168.1.20"]);
    assert.deepEqual(kinds("telepy forward <tunnel>@<account> localhost:80 --local 8080"), ["telepy:telepy", "sub:forward", "placeholder:<tunnel>", "arg:@", "placeholder:<account>", "arg:localhost:80", "flag:--local", "arg:8080"]);
    // 只有子指令樹裡的詞才算子指令。/ Only words in the tree are subcommands.
    assert.deepEqual(kinds("telepy examples forward"), ["telepy:telepy", "sub:examples", "arg:forward"]);
    assert.deepEqual(kinds("telepy ssh box -N -L 8080:localhost:80"), ["telepy:telepy", "sub:ssh", "arg:box", "flag:-N", "flag:-L", "arg:8080:localhost:80"]);
    assert.deepEqual(kinds("telepy exec box -- df -h /"), ["telepy:telepy", "sub:exec", "arg:box", "arg:--", "arg:df", "flag:-h", "arg:/"]);
});

test("usage lines: | means or, brackets are peeled", () => {
    const syn = (line: string) => highlightShell(line, TREE, true).filter((p) => p.kind !== "space").map((p) => `${p.kind}:${p.text}`);
    assert.deepEqual(syn("telepy lan ls | wake <tunnel> [--json]"), ["telepy:telepy", "sub:lan", "sub:ls", "op:|", "sub:wake", "placeholder:<tunnel>", "op:[", "flag:--json", "op:]"]);
    assert.deepEqual(syn("telepy ssh <tunnel>[@account] [-L …]"), ["telepy:telepy", "sub:ssh", "placeholder:<tunnel>", "arg:[@account", "op:]", "op:[", "flag:-L", "op:…]"]);
    const line = "telepy browse <tunnel> [url] | text | close";
    assert.equal(highlightShell(line, TREE, true).map((p) => p.text).join(""), line);
});

test("strings, variables, substitutions and comments", () => {
    assert.deepEqual(kinds('ID=$(telepy browse <tunnel> http://x/)'), ["var:ID=", "op:$(", "telepy:telepy", "sub:browse", "placeholder:<tunnel>", "arg:http://x/", "op:)"]);
    assert.deepEqual(kinds('telepy browse text "$ID" --selector main'), ["telepy:telepy", "sub:browse", "sub:text", 'var:"$ID"', "flag:--selector", "arg:main"]);
    assert.deepEqual(kinds('telepy login <url> --scope "tunnels:read browser:use"'), ["telepy:telepy", "sub:login", "placeholder:<url>", "flag:--scope", 'string:"tunnels:read browser:use"']);
    assert.deepEqual(kinds("export TELEPY_URL=<url>"), ["cmd:export", "var:TELEPY_URL=", "placeholder:<url>"]);
    assert.deepEqual(kinds("TELEPY_LAN_PASSWORD=… telepy cp a b"), ["var:TELEPY_LAN_PASSWORD=", "arg:…", "telepy:telepy", "arg:cp", "arg:a", "arg:b"]);
    assert.deepEqual(kinds("telepy ls && ssh box  # then"), ["telepy:telepy", "arg:ls", "op:&&", "cmd:ssh", "arg:box", "comment:# then"]);
    const seen = new Set<ShellKind>(highlightShell("a | b", TREE).map((p) => p.kind));
    assert.ok(seen.has("op") && seen.has("cmd"));
});
