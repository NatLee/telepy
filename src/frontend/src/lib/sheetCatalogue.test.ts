import { test } from "node:test";
import assert from "node:assert/strict";
import { en } from "../locales/en.ts";
import { zhTW } from "../locales/zh-TW.ts";
import { ja } from "../locales/ja.ts";
import { CLI_EXAMPLES } from "./cliExamples.gen.ts";
import { RECIPES } from "./forwardRecipes.ts";
import { TASK_KEYWORDS, catalogue, fillTunnel, searchCatalogue, wayCounts } from "./sheetCatalogue.ts";

const dicts = { en, "zh-TW": zhTW, ja };
const all = catalogue();
const ids = (query: string, locale = "en", filter = {}) => searchCatalogue(all, query, dicts, locale, filter).map((h) => h.entry.id);
const top = (query: string, locale = "en") => ids(query, locale)[0];

test("the catalogue is every task plus the CLI examples that aren't a task already", () => {
    const tasks = all.filter((e) => e.kind === "task");
    assert.deepEqual(tasks.map((e) => e.recipe), RECIPES.map((r) => r.id));
    const folded = tasks.flatMap((e) => e.alsoKeys).filter((k) => !k.endsWith("Note")).length;
    assert.equal(all.length, RECIPES.length + CLI_EXAMPLES.length - folded, "a folded example is not listed twice");
    assert.equal(new Set(all.map((e) => e.id)).size, all.length);
    // 每一項的標題三種語言都有。/ Every entry has a title in all three languages.
    for (const e of all) for (const [l, d] of Object.entries(dicts)) assert.ok(d[e.title], `${e.id} has no ${l} title`);
    assert.deepEqual(Object.keys(TASK_KEYWORDS).sort(), RECIPES.map((r) => r.id).sort());
});

test("each entry says which tools can do it", () => {
    const ways = (id: string) => all.find((e) => e.id === id)!.ways;
    assert.deepEqual(ways("task:local"), ["telepy", "ssh"]);
    assert.deepEqual(ways("task:vpn"), ["telepy"], "a whole network needs telepy vpn");
    assert.deepEqual(ways("ex:ssh"), ["telepy", "ssh"], "telepy ssh wraps the system's ssh");
    assert.deepEqual(ways("ex:ls"), ["telepy"]);
    assert.deepEqual(ways("ex:browsePorts"), ["telepy"]);
    const n = wayCounts(all);
    assert.equal(n.telepy, all.length);
    assert.equal(n.both + n.telepyOnly, all.length);
    assert.ok(n.telepyOnly > n.both, "most of the CLI goes beyond what ssh does");
});

test("a search finds a task in any of the three languages, whatever the interface language", () => {
    assert.equal(top("port forward"), "task:local");
    assert.equal(top("轉發"), "task:local");
    assert.equal(top("ポート転送"), "task:local");
    assert.equal(top("vpn", "ja"), "task:vpn");
    assert.equal(top("跳板"), "task:jump");
    assert.equal(top("踏み台", "zh-TW"), "task:jump");
    // 「proxy」：telepy proxy 的範例在前，SOCKS 那個任務也在。/ "proxy": the telepy proxy examples first, the SOCKS task is there too.
    assert.ok(top("proxy").startsWith("ex:proxy"), top("proxy"));
    assert.ok(ids("proxy").includes("task:socks"));
    assert.equal(top("socks proxy"), "task:socks");
    assert.equal(top("代理", "en"), "ex:proxy", "the 繁體中文 title of telepy proxy says 代理");
    assert.ok(ids("代理", "en").includes("task:socks"));
    assert.equal(top("rsync"), "task:copy");
    assert.equal(top("-D"), "task:socks");
    assert.equal(top("-R"), "task:remote");
});

test("typos and abbreviations still find it; nonsense finds nothing", () => {
    assert.equal(top("forwrad"), "task:local");
    assert.ok(ids("rustdsk").includes("task:rustdesk"));
    assert.ok(ids("snipet").some((id) => id.startsWith("ex:")), "the toolbox examples");
    assert.deepEqual(ids("qqqzzz"), []);
    assert.deepEqual(ids("vpn qqqzzz"), [], "every word must be found");
});

test("CLI-only abilities are found too, and filters narrow the list", () => {
    assert.ok(ids("screenshot").includes("ex:browse"));
    assert.ok(ids("錄影", "zh-TW").length > 0);
    assert.ok(ids("exec label").length > 0);
    assert.ok(ids("", "en", { way: "ssh" }).every((id) => all.find((e) => e.id === id)!.ways.includes("ssh")));
    assert.ok(ids("", "en", { topic: "sessions" }).length > 0);
    assert.ok(ids("", "en", { topic: "sessions" }).every((id) => all.find((e) => e.id === id)!.topic === "sessions"));
    assert.equal(ids("").length, all.length, "an empty query lists everything");
});

test("`via` names the language that matched when it isn't the interface's", () => {
    const hit = (q: string, locale: string) => searchCatalogue(all, q, dicts, locale)[0];
    assert.equal(hit("網段", "en").via, "zh-TW", "the 繁體中文 title says it");
    assert.equal(hit("翻牆", "en").via, null, "found by a synonym, not by a title");
    assert.equal(hit("whole network", "zh-TW").via, "en");
    assert.equal(hit("whole network", "en").via, null);
    // 靠主題名「Port forwarding」找到的範例，不會被說成「也叫做 …」。/ An example found by its topic name isn't given an "also called".
    const byTopic = searchCatalogue(all, "port forward", dicts, "zh-TW").filter((h) => h.entry.kind === "example" && h.entry.example?.startsWith("vpn"));
    assert.ok(byTopic.every((h) => h.via === null), JSON.stringify(byTopic.map((h) => [h.entry.id, h.via])));
});

test("example lines get the person's tunnel", () => {
    assert.deepEqual(fillTunnel(["telepy status <tunnel>", "telepy ssh <tunnel>@<account>"], "office-pi"), ["telepy status office-pi", "telepy ssh office-pi@<account>"]);
    assert.deepEqual(fillTunnel(["telepy status <tunnel>"], "my box"), ["telepy status 'my box'"]);
});

test("a device's IP or status is found by those words, in every language", () => {
    for (const [q, locale] of [["ip address", "en"], ["device ip", "en"], ["status", "en"], ["IP 位址", "zh-TW"], ["狀態", "zh-TW"], ["IP アドレス", "ja"]] as const) {
        assert.equal(top(q, locale), "ex:status", `${q} (${locale})`);
    }
});
