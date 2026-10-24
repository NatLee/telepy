import { test } from "node:test";
import assert from "node:assert/strict";
import { countCalls, filterCalls, formatBytes, formatDuration, isCodeDetail, toolCategory } from "./aiActivity.ts";

const call = (id: number, tool: string, ok: boolean, detail: string | null, extra: { error?: string; tunnel?: string; app?: string } = {}) => ({
    id,
    tool,
    ok,
    detail,
    error: extra.error ?? null,
    target_username: "root",
    client_name: extra.app ?? "Agent CLI",
    ip: "203.0.113.50",
    user: { username: "admin" },
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
    assert.deepEqual(countCalls(calls, "", "all"), { tools: { all: 6, exec: 2, files: 1, session: 1, read: 1 }, failed: 2 });
    assert.deepEqual(countCalls(calls, "", "exec").failed, 1);
    assert.deepEqual(countCalls(calls, "office-nas", "all"), { tools: { all: 3, exec: 1, files: 1, session: 1, read: 0 }, failed: 0 });
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
