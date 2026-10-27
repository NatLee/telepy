import { test } from "node:test";
import assert from "node:assert/strict";
import { countCalls, filterCalls, formatBytes, formatDuration, isCodeDetail, toolCategory, withTimes } from "./aiActivity.ts";

const call = (id: number, tool: string, ok: boolean, detail: string | null, extra: { error?: string; tunnel?: string; app?: string; userId?: number } = {}) => ({
    id,
    tool,
    ok,
    detail,
    error: extra.error ?? null,
    target_username: "root",
    client_name: extra.app ?? "Agent CLI",
    ip: "203.0.113.50",
    user: { id: extra.userId ?? 1, username: extra.userId && extra.userId !== 1 ? "bob" : "admin" },
    tunnel: extra.tunnel ? { name: extra.tunnel } : null,
});

const calls = [
    call(1, "ssh_exec", true, "cat > /etc/nginx/app.conf <<'EOF'\nserver {}\nEOF", { tunnel: "office-nas" }),
    call(2, "ssh_exec", false, "sudo apt-get install -y jq", { error: "E: Could not get lock /var/lib/dpkg/lock-frontend", tunnel: "home-pi" }),
    call(3, "sftp_write", true, "/home/deploy/app/config.json", { tunnel: "office-nas" }),
    call(4, "ssh_session_close", true, "reason: idle; commands: 3", { tunnel: "office-nas" }),
    call(5, "list_tunnels", true, "2 tunnels", { app: "Desktop assistant" }),
    call(6, "brand_new_tool", false, null),
];

test("tool categories and code details", () => {
    assert.equal(toolCategory("ssh_exec"), "exec");
    assert.equal(toolCategory("sftp_read"), "files");
    assert.equal(toolCategory("ssh_session_open"), "session");
    assert.equal(toolCategory("lan_scan"), "read");
    assert.equal(toolCategory("brand_new_tool"), null);
    assert.equal(isCodeDetail("ssh_exec"), true);
    assert.equal(isCodeDetail("sftp_list"), true);
    assert.equal(isCodeDetail("ssh_session_close"), false);
    assert.equal(toolCategory("shell_send"), "exec");
    assert.equal(toolCategory("browser_screenshot"), "browser");
    assert.equal(isCodeDetail("shell_send"), true);
    assert.equal(isCodeDetail("browser_navigate"), true);
    assert.equal(isCodeDetail("browser_close"), false);
});

test("filter by tool, result and query", () => {
    const ids = (f: Parameters<typeof filterCalls>[1]) => filterCalls(calls, f).map((c) => c.id);
    assert.deepEqual(ids({ query: "", tool: "all", failedOnly: false }), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(ids({ query: "", tool: "exec", failedOnly: false }), [1, 2]);
    assert.deepEqual(ids({ query: "", tool: "all", failedOnly: true }), [2, 6]);
    assert.deepEqual(ids({ query: "", tool: "exec", failedOnly: true }), [2]);
    // 指令內文、錯誤、隧道、應用程式都能搜（不分大小寫）。/ Commands, errors, tunnels and apps all match.
    assert.deepEqual(ids({ query: "NGINX", tool: "all", failedOnly: false }), [1]);
    assert.deepEqual(ids({ query: "dpkg", tool: "all", failedOnly: false }), [2]);
    assert.deepEqual(ids({ query: "home-pi", tool: "all", failedOnly: false }), [2]);
    assert.deepEqual(ids({ query: "desktop assistant", tool: "all", failedOnly: false }), [5]);
    const label = (tool: string) => (tool === "sftp_write" ? "寫入檔案" : tool);
    assert.deepEqual(ids({ query: "寫入", tool: "all", failedOnly: false, label }), [3]);
});

test("counts follow the search, failures follow the category", () => {
    assert.deepEqual(countCalls(calls, "", "all"), { who: { all: 6, mine: 6, others: 0 }, tools: { all: 6, exec: 2, files: 1, browser: 0, session: 1, read: 1 }, failed: 2 });
    assert.deepEqual(countCalls(calls, "", "exec").failed, 1);
    assert.deepEqual(countCalls(calls, "office-nas", "all"), { who: { all: 3, mine: 3, others: 0 }, tools: { all: 3, exec: 1, files: 1, browser: 0, session: 1, read: 0 }, failed: 0 });
});

test("whose calls: my apps vs other people's agents on my tunnels", () => {
    const mixed = [
        call(1, "ssh_exec", true, "uptime", { tunnel: "office-nas" }),
        call(2, "ssh_exec", false, "reboot", { tunnel: "office-nas", userId: 2, error: "blocked" }),
        call(3, "sftp_read", true, "/etc/hosts", { tunnel: "home-pi", userId: 2 }),
    ];
    const ids = (list: { id: number }[]) => list.map((c) => c.id);
    assert.deepEqual(ids(filterCalls(mixed, { query: "", tool: "all", failedOnly: false, who: "mine", meId: 1 })), [1]);
    assert.deepEqual(ids(filterCalls(mixed, { query: "", tool: "all", failedOnly: false, who: "others", meId: 1 })), [2, 3]);
    assert.deepEqual(ids(filterCalls(mixed, { query: "", tool: "all", failedOnly: false, who: "all", meId: 1 })), [1, 2, 3]);
    // 不知道我是誰就不篩。/ Without knowing who "me" is, nothing is filtered.
    assert.deepEqual(ids(filterCalls(mixed, { query: "", tool: "all", failedOnly: false, who: "others", meId: null })), [1, 2, 3]);
    // 「誰的」數字不受自己影響，其他數字跟著它。/ The "whose" numbers ignore it; the others follow it.
    const c = countCalls(mixed, "", "all", undefined, "others", 1);
    assert.deepEqual(c.who, { all: 3, mine: 1, others: 2 });
    assert.deepEqual(c.tools, { all: 2, exec: 1, files: 1, browser: 0, session: 0, read: 0 });
    assert.equal(c.failed, 1);
    assert.deepEqual(countCalls(mixed, "home-pi", "all", undefined, "all", 1).who, { all: 1, mine: 0, others: 1 });
});

test("durations and sizes", () => {
    assert.equal(formatDuration(null), "");
    assert.equal(formatDuration(125), "125 ms");
    assert.equal(formatDuration(7758), "7.8 s");
    assert.equal(formatDuration(125_000), "2m 05s");
    assert.equal(formatBytes(undefined), "");
    assert.equal(formatBytes(313), "313 B");
    assert.equal(formatBytes(4660), "4.6 KB");
    assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});

test("withTimes adds the time of day, the day key and a year only outside this year", () => {
    const now = new Date(2026, 9, 27, 12, 0, 0);
    const [a, b, bad] = withTimes(
        [{ id: 1, at: new Date(2026, 9, 27, 9, 5, 7).toISOString() }, { id: 2, at: new Date(2025, 0, 3, 23, 0, 0).toISOString() }, { id: 3, at: "not a time" }],
        now,
        "en",
    );
    assert.equal(a.id, 1);
    assert.equal(a.time, "09:05:07");
    assert.equal(a.day, "2026-10-27");
    assert.ok(!a.date.includes("2026"), a.date);
    assert.equal(b.day, "2025-01-03");
    assert.ok(b.date.includes("2025"), b.date);
    assert.deepEqual([bad.time, bad.day, bad.full], ["not a time", "", "not a time"]);
});
