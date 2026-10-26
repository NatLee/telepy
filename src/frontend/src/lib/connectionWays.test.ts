import { test } from "node:test";
import assert from "node:assert/strict";
import { layerColumns, linkColumns, nodeColumns, pathCells, ROWS, WAY_IDS, WAYS, wayFor } from "./connectionWays.ts";

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
        assert.ok(w.links.some((l) => l.kind === "tunnel"), `${w.id} goes through the tunnel`);
    }
    assert.equal(WAYS.find((w) => w.id === "guacd")!.nodes.find((n) => n.draws)!.col, 1, "guacd draws at Telepy");
    assert.equal(WAYS.find((w) => w.id === "rustdeskTunnel")!.nodes.find((n) => n.draws)!.col, 0, "RustDesk draws in the browser");
});

test("every table row has a cell for every way", () => {
    for (const r of ROWS) assert.deepEqual(Object.keys(r.cells).sort(), [...WAY_IDS].sort(), r.label);
});

const span = (column: string) => {
    const [a, b] = column.split(" / ");
    const start = Number(a);
    return [start, b.startsWith("span ") ? start + Number(b.slice(5)) : Number(b)];
};

test("path cells alternate node, link, node in order", () => {
    for (const w of WAYS) {
        const cells = pathCells(w);
        assert.deepEqual(cells.map((c) => c.kind), ["node", "link", "node", "link", "node", "link", "node"], w.id);
        assert.deepEqual(cells.filter((c) => c.kind === "node").map((c) => c.node.col), [0, 1, 2, 3], w.id);
    }
});

test("nodes and links tile eleven columns, and the ruler runs node centre to node centre", () => {
    for (const w of WAYS) {
        // 點、線、點…一欄接一欄，不重疊也沒有空隙。/ Nodes and links tile the row without gaps or overlaps.
        let next = 1;
        for (const c of pathCells(w)) {
            const [start, end] = span(c.kind === "node" ? nodeColumns(c.node.col) : linkColumns(c.link.from, c.link.to));
            assert.equal(start, next, `${w.id}: ${c.kind} starts where the previous one ended`);
            next = end;
        }
        assert.equal(next, 12, `${w.id}: eleven columns`);
        // 尺：第一段從瀏覽器的中心開始，每段接上一段，最後一段停在桌面的中心。/ The ruler is continuous between the outer centres.
        let at = span(nodeColumns(0))[0] + 1;
        for (const l of w.layers) {
            const [start, end] = span(layerColumns(l.from, l.to));
            assert.equal(start, at, `${w.id}: ruler ${l.from}→${l.to} meets the previous span`);
            assert.equal(start, span(nodeColumns(l.from))[0] + 1, `${w.id}: starts at the centre of node ${l.from}`);
            assert.equal(end, span(nodeColumns(l.to))[0] + 1, `${w.id}: ends at the centre of node ${l.to}`);
            assert.ok(end - start >= 3, `${w.id}: a span is wider than its link alone`);
            at = end;
        }
        assert.equal(at, span(nodeColumns(3))[0] + 1, `${w.id}: the ruler ends at the desktop's centre`);
    }
});

test("the page's protocol maps to a way", () => {
    assert.equal(wayFor("rdp"), "guacd");
    assert.equal(wayFor("vnc"), "guacd");
    assert.equal(wayFor("rustdesk"), "rustdeskTunnel");
});
