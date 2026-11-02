import { test } from "node:test";
import assert from "node:assert/strict";
import { barsSummary, diskFree, formatBytes, formatUptime, hourBars, isQuiet, niceMax, parseServerStats, sessionKinds, storageParts, tunnelSegments, uptimeParts } from "./serverStats.ts";

const zeros = () => Array(24).fill(0);
const hours = Array.from({ length: 24 }, (_, i) => new Date(Date.UTC(2026, 9, 30, i)).toISOString());

test("parses a full answer", () => {
    const s = parseServerStats({
        server: { version: "2.9.0", started_at: "2026-10-27T00:00:00Z", uptime_secs: 3600, now: "2026-10-30T00:00:00Z" },
        tunnels: { total: 5, online: 3, degraded: 1, offline: 1, never: 0 },
        gateway: { connections: 4, forwards: 3 },
        sessions: { total: 2, by_kind: { terminal: 1, teleport: 1, bogus: "x" } },
        users: { total: 4, active: 3, admins: 1, signed_in_24h: 2 },
        storage: { db_bytes: 1024, wal_bytes: 0, data_dir: { path: "/data", free_bytes: 5, total_bytes: 100 }, recordings_bytes: null, logs_bytes: 7 },
        activity: { hours, gateway_events: zeros(), gateway_problems: zeros(), sign_ins: zeros(), sign_ins_failed: zeros(), api_calls: zeros(), api_errors: zeros() },
        webhooks: null,
    });
    assert.ok(s);
    assert.equal(s.server?.version, "2.9.0");
    assert.equal(s.tunnels?.degraded, 1);
    assert.deepEqual(s.sessions?.by_kind, { terminal: 1, teleport: 1 });
    assert.equal(s.storage?.data_dir?.path, "/data");
    assert.equal(s.storage?.recordings_bytes, null);
    assert.equal(s.activity?.hours?.length, 24);
    assert.equal(s.webhooks, null);
});

test("drops wrong types, short arrays and empty blocks", () => {
    const s = parseServerStats({
        server: { version: 3, uptime_secs: "10" },
        tunnels: { total: 2, online: -1 },
        activity: { hours: hours.slice(1), gateway_events: [1, 2, 3], sign_ins: zeros() },
        users: "nope",
    });
    assert.ok(s);
    assert.equal(s.server, null);
    assert.deepEqual(s.tunnels, { total: 2, online: null, degraded: null, offline: null, never: null });
    assert.equal(s.activity?.hours, null);
    assert.equal(s.activity?.gateway_events, null);
    assert.equal(s.activity?.sign_ins?.length, 24);
    assert.equal(s.users, null);
});

test("nothing usable = null", () => {
    assert.equal(parseServerStats(null), null);
    assert.equal(parseServerStats([]), null);
    assert.equal(parseServerStats({ server: {}, other: 1 }), null);
});

test("bytes", () => {
    assert.equal(formatBytes(0, "en"), "0 B");
    assert.equal(formatBytes(1536, "en"), "1.5 kB");
    assert.equal(formatBytes(20 * 1024 ** 3, "en"), "20 GB");
    assert.equal(formatBytes(1024 ** 2 * 3.25, "en"), "3.3 MB");
});

test("uptime", () => {
    assert.deepEqual(uptimeParts(3 * 86_400 + 4 * 3_600 + 5 * 60 + 9), { days: 3, hours: 4, minutes: 5 });
    assert.equal(formatUptime(3 * 86_400 + 4 * 3_600 + 5 * 60, "en"), "3 days 4 hr");
    assert.equal(formatUptime(86_400 + 60, "en"), "1 day");
    assert.equal(formatUptime(2 * 3_600 + 60, "en"), "2 hr 1 min");
    assert.equal(formatUptime(30, "en"), "0 min");
});

test("tunnel segments sum to 100 and skip zeros", () => {
    const s = tunnelSegments({ online: 1, degraded: 1, offline: 1, never: 0 });
    assert.deepEqual(s.map((x) => x.state), ["online", "degraded", "offline"]);
    assert.equal(s.reduce((a, x) => a + x.pct, 0), 100);
    assert.deepEqual(s.map((x) => x.pct), [34, 33, 33]);
    assert.deepEqual(tunnelSegments({ online: 0, never: null }), []);
    assert.deepEqual(tunnelSegments({ online: 7 }).map((x) => x.pct), [100]);
});

test("nice max", () => {
    assert.equal(niceMax(0), 1);
    assert.equal(niceMax(1), 1);
    assert.equal(niceMax(3), 5);
    assert.equal(niceMax(7), 10);
    assert.equal(niceMax(11), 20);
    assert.equal(niceMax(240), 500);
    assert.equal(niceMax(0.3), 0.5);
});

test("hour bars keep problems inside the total", () => {
    const total = zeros();
    const sub = zeros();
    total[3] = 5;
    sub[3] = 2;
    sub[4] = 1;
    const bars = hourBars(total, sub);
    assert.ok(bars);
    assert.deepEqual(bars[3], { total: 5, sub: 2 });
    assert.deepEqual(bars[4], { total: 1, sub: 1 });
    assert.deepEqual(barsSummary(bars), { total: 6, sub: 3, max: 5, maxAt: 3 });
    assert.equal(hourBars(null, null), null);
    assert.equal(hourBars(total, null)?.[3].sub, 0);
});

test("quiet when everything is zero or missing", () => {
    assert.equal(isQuiet(null), true);
    const a = { hours, gateway_events: zeros(), gateway_problems: null, sign_ins: zeros(), sign_ins_failed: zeros(), api_calls: null, api_errors: null };
    assert.equal(isQuiet(a), true);
    const busy = zeros();
    busy[23] = 1;
    assert.equal(isQuiet({ ...a, api_calls: busy }), false);
});

test("disk free share", () => {
    assert.equal(diskFree({ free_bytes: 5, total_bytes: 100 }), 0.05);
    assert.equal(diskFree({ free_bytes: 5, total_bytes: 0 }), null);
    assert.equal(diskFree(null), null);
});

test("session kinds: known order, unknown after, zeros dropped", () => {
    assert.deepEqual(sessionKinds({ zeta: 1, ai: 2, terminal: 3, files: 0, alpha: 4 }), [["terminal", 3], ["ai", 2], ["alpha", 4], ["zeta", 1]]);
});

test("sizes under 1 KB read as B in every language", () => {
    assert.equal(formatBytes(0, "zh-TW"), "0 B");
    assert.equal(formatBytes(512, "ja"), "512 B");
});

test("storage: carriers and IP / vendor data are parsed, truncated walks flagged", () => {
    const s = parseServerStats({
        storage: {
            db_bytes: 4000,
            wal_bytes: 100,
            data_dir: null,
            recordings_bytes: 9000,
            recordings_truncated: true,
            logs_bytes: 500,
            logs_truncated: false,
            carriers_bytes: 2000,
            geoip_bytes: 700,
            oui_bytes: 300,
            oui_truncated: "yes",
        },
    })!;
    assert.equal(s.storage?.carriers_bytes, 2000);
    assert.equal(s.storage?.geoip_bytes, 700);
    assert.equal(s.storage?.oui_bytes, 300);
    assert.deepEqual(s.storage?.truncated, ["recordings"], "only a real true counts");
});

test("storage parts: largest first, datasets = GeoIP + OUI, shares sum to 1", () => {
    const s = parseServerStats({
        storage: { db_bytes: 4000, wal_bytes: 0, recordings_bytes: 9000, recordings_truncated: true, logs_bytes: 500, carriers_bytes: 2000, geoip_bytes: 700, oui_bytes: 300 },
    })!;
    const { parts, total, atLeast } = storageParts(s.storage);
    assert.deepEqual(parts.map((p) => p.id), ["recordings", "database", "carriers", "datasets", "logs", "wal"]);
    assert.equal(total, 16500);
    assert.equal(atLeast, true);
    assert.equal(parts[0].atLeast, true);
    const ds = parts.find((p) => p.id === "datasets")!;
    assert.equal(ds.bytes, 1000);
    assert.deepEqual(ds.split, { geoip: 700, oui: 300 });
    assert.ok(Math.abs(parts.reduce((a, p) => a + p.share, 0) - 1) < 1e-9);
    assert.equal(parts.find((p) => p.id === "wal")!.share, 0);
});

test("storage parts: an older backend without the new fields lists what it has", () => {
    const s = parseServerStats({ storage: { db_bytes: 10, wal_bytes: 10, recordings_bytes: null, logs_bytes: 5 } })!;
    const { parts, total } = storageParts(s.storage);
    // 一樣大照固定順序：資料庫在 WAL 前。/ Ties keep the fixed order: database before WAL.
    assert.deepEqual(parts.map((p) => p.id), ["database", "wal", "logs"]);
    assert.equal(total, 25);
    assert.deepEqual(storageParts(null), { parts: [], total: 0, atLeast: false });
    // 只有 OUI 也算 IP 與廠商資料。/ OUI alone still counts as the IP and vendor data.
    const only = parseServerStats({ storage: { db_bytes: 0, oui_bytes: 42 } })!;
    assert.deepEqual(storageParts(only.storage).parts.find((p) => p.id === "datasets")?.split, { geoip: null, oui: 42 });
    // 全部是 0：比例都是 0，不是 NaN。/ All zero: shares are 0, not NaN.
    const zero = parseServerStats({ storage: { db_bytes: 0, wal_bytes: 0 } })!;
    assert.deepEqual(storageParts(zero.storage).parts.map((p) => p.share), [0, 0]);
});
