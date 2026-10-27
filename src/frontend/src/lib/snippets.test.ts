import { test } from "node:test";
import assert from "node:assert/strict";
import {
    addedBuiltins, askedVariables, BUILTIN_SNIPPETS, declaredFromRows, draftFromBuiltin, editorRows, groupSnippets, guessAsked,
    initialValues, isMultiline, lineInput, maskedPreview, matchesQuery, parseFavourites, stageFromBanner, substitute, terminalLines,
    settle, toggleFavourite, toolboxSpotStates, typeLines, variableRefs, type Snippet,
} from "./snippets.ts";

test("variable references: $name and ${name}, in order, unique, $$ skipped", () => {
    assert.deepEqual(variableRefs("journalctl -u $unit -n ${lines} | grep $unit"), ["unit", "lines"]);
    assert.deepEqual(variableRefs("echo $$ $1 $(date) ${x:-y} $ok_2"), ["ok_2"]);
    assert.deepEqual(variableRefs("no vars here"), []);
});

test("substitution follows safe_substitute: known names replaced, unknown ones survive", () => {
    const v = { unit: "nginx", lines: "50" };
    assert.equal(substitute("journalctl -u $unit -n ${lines}", v), "journalctl -u nginx -n 50");
    assert.equal(substitute("echo $HOME ${PATH} $unit", v), "echo $HOME ${PATH} nginx");
    // $$ 是 shell 的 PID，不是跳脫。/ $$ is the shell's PID, not an escape.
    assert.equal(substitute("kill $$; echo $$unit", v), "kill $$; echo $$unit");
    assert.equal(substitute("cp ${unit}.conf /tmp/$unit-bak", v), "cp nginx.conf /tmp/nginx-bak");
    // 值裡的 $ 不會再被代換。/ A $ inside a value is not substituted again.
    assert.equal(substitute("echo $a", { a: "$b", b: "x" }), "echo $b");
    // 空字串也是值。/ An empty string is a value too.
    assert.equal(substitute("ls $dir", { dir: "" }), "ls ");
});

test("asked variables are the declared ones the command uses; secrets start empty and are masked", () => {
    const vars = [
        { name: "host", label: "Host", default: "db1", secret: false },
        { name: "token", label: "", default: "leak", secret: true },
        { name: "gone", label: "", default: "", secret: false },
    ];
    const s = { command: "curl -H \"Authorization: $token\" https://$host/", variables: vars };
    assert.deepEqual(askedVariables(s).map((v) => v.name), ["host", "token"]);
    assert.deepEqual(initialValues(askedVariables(s)), { host: "db1", token: "" });
    assert.equal(maskedPreview(s.command, vars, { host: "db2", token: "" }), "curl -H \"Authorization: $token\" https://db2/");
    assert.equal(maskedPreview(s.command, vars, { host: "db2", token: "s3cret" }), "curl -H \"Authorization: ••••\" https://db2/");
});

test("lines are typed one Enter each, never as a bracketed paste", () => {
    assert.deepEqual(terminalLines("uptime\r\nfree -h\n\n"), ["uptime", "free -h"]);
    assert.ok(isMultiline("a\nb") && !isMultiline("a\n"));
    assert.equal(lineInput("df -h", true), "df -h\r");
    assert.equal(lineInput("df -h", false), "df -h");
    assert.ok(!lineInput("x", true).includes("\x1b[200~"));
});

const snip = (id: number, scope: Snippet["scope"], name: string, command = "true"): Snippet => ({
    id, scope, tunnel_id: scope === "tunnel" ? 7 : null, name, command, description: "", variables: [], confirm: false,
    sort_order: 0, use_count: 0, last_used_at: null, can_edit: true, created_at: "", updated_at: "",
});

test("search, grouping and favourites", () => {
    const list = [snip(1, "user", "Disk usage", "df -h"), snip(2, "tunnel", "Restart app"), snip(3, "site", "Docker ps", "docker ps"), snip(4, "user", "Logs")];
    assert.ok(matchesQuery(list[0], "DISK df"));
    assert.ok(!matchesQuery(list[0], "disk docker"));
    const g = groupSnippets(list, "", [3, 1]);
    assert.deepEqual(g.favourites.map((s) => s.id), [3, 1], "favourites in starred order");
    assert.deepEqual(g.user.map((s) => s.id), [4], "not repeated in their own group");
    assert.deepEqual(g.tunnel.map((s) => s.id), [2]);
    assert.deepEqual(g.site, []);
    assert.deepEqual(groupSnippets(list, "docker", []).site.map((s) => s.id), [3]);
    assert.deepEqual(parseFavourites("[1, 2, \"x\", 3.5]"), [1, 2]);
    assert.deepEqual(parseFavourites("{oops"), []);
    assert.deepEqual(toggleFavourite([1, 2], 2), [1]);
    assert.deepEqual(toggleFavourite([1], 2), [1, 2]);
});

test("editor rows: one per $name, ALL-CAPS names default to not asked, secrets drop their default", () => {
    const rows = editorRows("ssh $user@$host -p $PORT; echo $HOME", [{ name: "host", label: "Host", default: "db", secret: false }]);
    assert.deepEqual(rows.map((r) => [r.name, r.asked]), [["user", true], ["host", true], ["PORT", false], ["HOME", false]]);
    assert.ok(guessAsked("port") && !guessAsked("HOME"));
    rows[0] = { ...rows[0], secret: true, default: "x" };
    assert.deepEqual(declaredFromRows(rows), [
        { name: "user", label: "", default: "", secret: true },
        { name: "host", label: "Host", default: "db", secret: false },
    ]);
});

test("built-in examples: a dozen, unique ids, variables used by their commands, and drafts in the current language", () => {
    assert.ok(BUILTIN_SNIPPETS.length >= 12);
    assert.equal(new Set(BUILTIN_SNIPPETS.map((b) => b.id)).size, BUILTIN_SNIPPETS.length);
    for (const b of BUILTIN_SNIPPETS) {
        const refs = variableRefs(b.command);
        for (const v of b.variables ?? []) assert.ok(refs.includes(v.name), `${b.id}: $${v.name}`);
        // 沒宣告的 $name 只能是 shell 變數（全大寫）。/ Undeclared names may only be shell variables.
        for (const r of refs) assert.ok((b.variables ?? []).some((v) => v.name === r) || !guessAsked(r), `${b.id}: $${r}`);
    }
    const journal = BUILTIN_SNIPPETS.find((b) => b.id === "journal")!;
    const d = draftFromBuiltin(journal, (k) => `T(${k})`);
    assert.equal(d.name, "T(toolbox.builtin.journal)");
    assert.deepEqual(d.variables.map((v) => [v.name, v.label, v.default]), [["unit", "T(toolbox.builtin.varService)", "ssh"], ["lines", "T(toolbox.builtin.varLines)", "100"]]);
    assert.ok(BUILTIN_SNIPPETS.some((b) => b.confirm), "one example shows the confirmation");
    assert.deepEqual([...addedBuiltins([{ command: "df -h" }, { command: "other" }])], ["disk"]);
});

test("the info diagram follows the latest run", () => {
    const idle = toolboxSpotStates("idle");
    assert.ok(Object.values(idle).every((s) => s === "waiting"));
    assert.equal(toolboxSpotStates("filling").variables, "active");
    assert.equal(toolboxSpotStates("filling").snippet, "ok");
    const typing = toolboxSpotStates("typing");
    assert.equal(typing.shell, "active");
    assert.equal(typing.device, "waiting");
    const blocked = toolboxSpotStates("blocked");
    assert.equal(blocked.rules, "failed");
    assert.equal(blocked.shell, "ok");
    assert.equal(blocked.device, "waiting");
    assert.equal(toolboxSpotStates("held").rules, "active");
    assert.ok(Object.values(toolboxSpotStates("sent")).every((s) => s === "ok"));
    assert.equal(stageFromBanner("pending"), "held");
    assert.equal(stageFromBanner("denied"), "blocked");
    assert.equal(stageFromBanner("approved"), "sent");
});

test("typing: one Enter per line, waits between lines, stops on a block, Insert sends no Enter", async () => {
    const sent: string[] = [];
    let settles = 0;
    let stop = false;
    const deps = { send: (s: string) => { sent.push(s); return true; }, settle: async () => { settles++; if (sent.length === 2) stop = true; }, stopped: () => stop };
    assert.equal(await typeLines(["a", "b", "c"], true, deps), "stopped");
    assert.deepEqual(sent, ["a\r", "b\r"]);
    assert.equal(settles, 2);
    sent.length = 0;
    assert.equal(await typeLines(["df -h"], false, { ...deps, stopped: () => false }), "done");
    assert.deepEqual(sent, ["df -h"]);
    assert.equal(await typeLines(["x"], true, { ...deps, send: () => false, stopped: () => false }), "offline");
});

test("settle resolves after output goes quiet", async () => {
    let emit: () => void = () => { };
    let unsubscribed = false;
    const onOutput = (cb: () => void) => { emit = cb; return () => { unsubscribed = true; }; };
    const start = Date.now();
    const p = settle(onOutput, 30, 1000);
    setTimeout(() => emit(), 20);
    setTimeout(() => emit(), 40);
    await p;
    const took = Date.now() - start;
    assert.ok(took >= 60 && took < 500, `${took}`);
    assert.ok(unsubscribed);
});
