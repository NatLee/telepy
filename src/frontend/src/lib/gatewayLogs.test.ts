import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryOf, countByCategory, filterLogs } from "./gatewayLogs.ts";

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
    assert.equal(categoryOf("command_blocked"), "problem");
    assert.equal(categoryOf("command_held"), "session");
    assert.equal(categoryOf("command_rule"), "change");
    assert.equal(categoryOf("lan_scan"), "change");
    assert.equal(categoryOf("health_ack"), "change");
    assert.equal(categoryOf("audit_reseal"), "change");
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
