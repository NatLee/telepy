import { test } from "node:test";
import assert from "node:assert/strict";
import { datasetsFlow, datasetState, parseDatasets, runSummary, type DatasetItem } from "./datasets.ts";

const item = (over: Partial<DatasetItem> = {}): DatasetItem => ({
    id: "country",
    path: "/data/geoip/dbip-country-lite.mmdb",
    present: true,
    size: 8_000_000,
    modified: "2026-11-02T00:00:00Z",
    release: "2026-11",
    in_use: { file: "dbip-country-lite.mmdb", source: "DB-IP", built: "2026-11-01T00:00:00Z" },
    vendors: null,
    due: false,
    failure: null,
    ...over,
});

test("parses the backend's answer and ignores what it does not know", () => {
    const v = parseDatasets({
        auto_update: true,
        items: [
            { id: "country", path: "/data/geoip/dbip-country-lite.mmdb", present: true, size: 8, modified: null, release: "2026-10", in_use: { file: "dbip-country-lite.mmdb", source: "DB-IP", built: "2026-10-01T00:00:00Z" }, vendors: null, due: true, failure: null },
            { id: "oui", path: "/data/oui/oui.csv", present: false, size: null, modified: null, release: null, in_use: null, vendors: null, due: false, failure: { at: "2026-11-02T00:00:00Z", error: "HTTP 418" } },
            { id: "nope" },
        ],
        sources: { dbip: "https://download.db-ip.com/free", oui: "https://standards-oui.ieee.org/oui/oui.csv" },
        checked_at: "2026-11-02T00:00:00Z",
        next_check_at: null,
        updating: false,
        last_run: { at: "2026-11-02T00:00:00Z", trigger: "auto", by: null, items: [{ id: "country", outcome: "updated", from: "2026-10", to: "2026-11", error: null }, { id: "x", outcome: "updated" }] },
        attribution: "IP geolocation by DB-IP",
        refresh_days: 30,
    });
    assert.ok(v);
    assert.equal(v.items.length, 2, "unknown items are dropped");
    assert.equal(v.items[0].release, "2026-10");
    assert.equal(v.items[1].failure?.error, "HTTP 418");
    assert.equal(v.last_run?.trigger, "auto");
    assert.equal(v.last_run?.items.length, 1);
    assert.equal(parseDatasets(null), null);
    assert.equal(parseDatasets({ items: "no" }), null);
});

test("each item's state", () => {
    assert.equal(datasetState(item()), "current");
    assert.equal(datasetState(item({ due: true })), "due");
    assert.equal(datasetState(item({ present: false, in_use: null })), "missing");
    assert.equal(datasetState(item({ present: false, in_use: { file: "GeoLite2-Country.mmdb", source: "MaxMind", built: null } })), "other", "a hand-placed MaxMind file still gives data");
    assert.equal(datasetState(item({ failure: { at: "", error: "x" } })), "failed", "a failure wins");
});

test("a run's summary and the diagram", () => {
    const s = runSummary({ at: "", trigger: "manual", by: "admin", items: [
        { id: "country", outcome: "updated", from: "2026-10", to: "2026-11", error: null },
        { id: "asn", outcome: "current", from: null, to: null, error: null },
        { id: "oui", outcome: "failed", from: null, to: null, error: "HTTP 503" },
    ] });
    assert.deepEqual(s.updated.map((i) => i.id), ["country"]);
    assert.deepEqual(s.current, ["asn"]);
    assert.deepEqual(s.failed.map((i) => i.error), ["HTTP 503"]);

    assert.deepEqual(datasetsFlow(null), { source: "waiting", download: "waiting", telepy: "waiting", lookups: "waiting" });
    const view = parseDatasets({ items: [item()], sources: {}, updating: false })!;
    assert.deepEqual(datasetsFlow(view), { source: "ok", download: "ok", telepy: "ok", lookups: "ok" });
    assert.equal(datasetsFlow({ ...view, updating: true }).download, "active");
    assert.equal(datasetsFlow({ ...view, items: [item({ failure: { at: "", error: "x" } })] }).download, "failed");
});
