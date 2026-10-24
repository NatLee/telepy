import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryOf, countByCategory, dayKey, dayRelation, filterLogs, groupByDay, highlightSegments } from "./gatewayLogs.ts";

const log = (id: number, event: string, message: string, day: string) => ({ id, event, message, day, at: `${day}T10:00:0${id % 10}+08:00`, time: "10:00:00", date: day });

const logs = [
    log(1, "refused_forward", "Refused tcpip-forward 0.0.0.0:9999", "2026-10-24"),
    log(2, "accepted", "Accepted publickey for telepy from 203.0.113.7", "2026-10-24"),
    log(3, "terminal_open", "admin opened a terminal as root", "2026-10-23"),
    log(4, "lan_scan", "Scan of 192.168.1.0/24 finished", "2026-10-23"),
    log(5, "something_new", "A kind this build does not know", "2026-10-22"),
];

test("categories", () => {
    assert.equal(categoryOf("host_key_mismatch"), "problem");
    assert.equal(categoryOf("forward"), "connection");
    assert.equal(categoryOf("desktop_close"), "session");
    assert.equal(categoryOf("lan_scan"), "change");
    assert.equal(categoryOf("something_new"), null);
});

test("filter by category and query", () => {
    assert.deepEqual(filterLogs(logs, { query: "", category: "all" }).map((x) => x.id), [1, 2, 3, 4, 5]);
    assert.deepEqual(filterLogs(logs, { query: "", category: "problem" }).map((x) => x.id), [1]);
    assert.deepEqual(filterLogs(logs, { query: "", category: "change" }).map((x) => x.id), [4]);
    assert.deepEqual(filterLogs(logs, { query: "  203.0.113  ", category: "all" }).map((x) => x.id), [2]);
    assert.deepEqual(filterLogs(logs, { query: "ROOT", category: "all" }).map((x) => x.id), [3]);
    assert.deepEqual(filterLogs(logs, { query: "root", category: "problem" }).map((x) => x.id), []);
    // 日期與翻譯後的標籤也能搜。/ Dates and translated badge labels match too.
    assert.deepEqual(filterLogs(logs, { query: "2026-10-22", category: "all" }).map((x) => x.id), [5]);
    const label = (e: string) => (e === "accepted" ? "登入成功" : e);
    assert.deepEqual(filterLogs(logs, { query: "登入", category: "all", label }).map((x) => x.id), [2]);
});

test("counts follow the search", () => {
    assert.deepEqual(countByCategory(logs, ""), { all: 5, problem: 1, connection: 1, session: 1, change: 1 });
    assert.deepEqual(countByCategory(logs, "terminal"), { all: 1, problem: 0, connection: 0, session: 1, change: 0 });
});

test("group consecutive events per day", () => {
    const groups = groupByDay(logs);
    assert.deepEqual(groups.map((g) => [g.day, g.items.map((x) => x.id)]), [
        ["2026-10-24", [1, 2]],
        ["2026-10-23", [3, 4]],
        ["2026-10-22", [5]],
    ]);
    assert.deepEqual(groupByDay([]), []);
});

test("day keys and today / yesterday", () => {
    const now = new Date(2026, 0, 1, 0, 30); // 1 Jan, just after midnight
    assert.equal(dayKey(now), "2026-01-01");
    assert.equal(dayRelation("2026-01-01", now), "today");
    assert.equal(dayRelation("2025-12-31", now), "yesterday");
    assert.equal(dayRelation("2025-12-30", now), null);
});

test("highlight segments", () => {
    assert.deepEqual(highlightSegments("abc", ""), [{ text: "abc", hit: false }]);
    assert.deepEqual(highlightSegments("Port 22 to port 2222", "port"), [
        { text: "Port", hit: true },
        { text: " 22 to ", hit: false },
        { text: "port", hit: true },
        { text: " 2222", hit: false },
    ]);
    assert.deepEqual(highlightSegments("2222", "22"), [
        { text: "22", hit: true },
        { text: "22", hit: true },
    ]);
    assert.deepEqual(highlightSegments("nothing here", "zzz"), [{ text: "nothing here", hit: false }]);
});
