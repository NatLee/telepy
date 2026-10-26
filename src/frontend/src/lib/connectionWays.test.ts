import { test } from "node:test";
import assert from "node:assert/strict";
import { pathCells, ROWS, WAY_IDS, WAYS, wayFor } from "./connectionWays.ts";

test("every way is complete and its links and layers stay on the grid", () => {
    assert.deepEqual(WAYS.map((w) => w.id), [...WAY_IDS]);
    for (const w of WAYS) {
        const cols = new Set(w.nodes.map((n) => n.col));
        assert.ok(cols.has(0) && cols.has(3), `${w.id} starts at the browser and ends at the desktop`);
        for (const l of w.links) {
            assert.ok(cols.has(l.from) && cols.has(l.to) && l.to > l.from, `${w.id} link ${l.from}→${l.to}`);
        }
        const covered = w.layers.flatMap((l) => Array.from({ length: l.to - l.from }, (_, i) => l.from + i));
        assert.deepEqual(covered, [0, 1, 2], `${w.id}: the ruler covers every hop exactly once`);
        assert.equal(w.nodes.filter((n) => n.draws).length, 1, `${w.id}: the picture is drawn in one place`);
    }
});

test("only the RustDesk server path is end-to-end and needs no tunnel", () => {
    const e2e = WAYS.filter((w) => w.layers.some((l) => l.tone === "e2e")).map((w) => w.id);
    assert.deepEqual(e2e, ["rustdeskServer"]);
    const noTunnel = WAYS.filter((w) => !w.links.some((l) => l.kind === "tunnel")).map((w) => w.id);
    assert.deepEqual(noTunnel, ["rustdeskServer"]);
    assert.equal(WAYS.find((w) => w.id === "guacd")!.nodes.find((n) => n.draws)!.col, 1, "guacd draws at Telepy");
});

test("every table row has a cell for every way", () => {
    for (const r of ROWS) assert.deepEqual(Object.keys(r.cells).sort(), [...WAY_IDS].sort(), r.label);
});

test("path cells line up in seven slots", () => {
    for (const w of WAYS) {
        const cells = pathCells(w);
        const slots = cells.reduce((n, c) => n + (c.kind === "link" ? c.span : 1), 0);
        assert.equal(slots, 7, w.id);
    }
    assert.deepEqual(pathCells(WAYS[0]).map((c) => c.start), [1, 2, 3, 4, 5, 6, 7]);
    const server = pathCells(WAYS[2]);
    assert.deepEqual(server.map((c) => c.start), [1, 2, 3, 4, 7]);
    assert.equal(server.length, 5, "browser, link, Telepy, a link spanning the device column, then the computer");
    assert.equal(server[3].kind === "link" && server[3].span, 3);
});

test("the page's choice maps to a way", () => {
    assert.equal(wayFor({ protocol: "rdp", idServer: false }), "guacd");
    assert.equal(wayFor({ protocol: "vnc", idServer: false }), "guacd");
    assert.equal(wayFor({ protocol: "rustdesk", idServer: false }), "rustdeskTunnel");
    assert.equal(wayFor({ protocol: "rdp", idServer: true }), "rustdeskServer");
});
