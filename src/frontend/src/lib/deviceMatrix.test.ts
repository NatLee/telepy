import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultCollapsed, foldsToSummary, hasGroupedDevice, matrixSections, UNGROUPED_SECTION } from "./deviceMatrix.ts";
import type { TunnelGroup } from "../types/groups.ts";
import type { KeyTarget } from "../types/keys.ts";

const g = (id: number, name: string, position: number, tunnel_ids: number[]): TunnelGroup => ({ id, name, position, tunnel_ids, created_at: "" });
const groups = [g(2, "Home", 1, [3, 4]), g(1, "Prod", 0, [1, 2]), g(3, "Empty", 2, [])];
const devices = [1, 2, 3, 4, 5, 6].map((tunnel_id) => ({ tunnel_id }));
const idOf = (d: { tunnel_id: number }) => d.tunnel_id;

test("sections follow group order, end with the ungrouped ones and skip empty groups", () => {
    const s = matrixSections(devices, devices, groups, idOf, false);
    assert.deepEqual(
        s.map((x) => [x.key, x.items.map(idOf), x.total]),
        [
            ["1", [1, 2], 2],
            ["2", [3, 4], 2],
            [UNGROUPED_SECTION, [5, 6], 2],
        ],
    );
});

test("while filtering only sections with a match stay, totals stay whole", () => {
    const visible = devices.filter((d) => d.tunnel_id === 4);
    const s = matrixSections(visible, devices, groups, idOf, true);
    assert.deepEqual(
        s.map((x) => [x.key, x.items.length, x.total]),
        [["2", 1, 2]],
    );
});

test("without filtering a section whose rows are all cut still shows its header", () => {
    const visible = devices.slice(0, 2);
    assert.deepEqual(
        matrixSections(visible, devices, groups, idOf, false).map((x) => x.key),
        ["1", "2", UNGROUPED_SECTION],
    );
});

test("sections only when a device sits in a group", () => {
    assert.equal(hasGroupedDevice([5, 6], groups), false);
    assert.equal(hasGroupedDevice([5, 3], groups), true);
    assert.equal(hasGroupedDevice([1], []), false);
});

test("a few devices start open, many keep only the first section open", () => {
    assert.deepEqual([...defaultCollapsed(["1", "2", "none"], 8)], []);
    assert.deepEqual([...defaultCollapsed(["1", "2", "none"], 9)], ["2", "none"]);
    assert.deepEqual([...defaultCollapsed([], 20)], []);
});

test("only fully installed multi-account cells fold into one chip", () => {
    const t = (username: string, status: KeyTarget["status"]): KeyTarget => ({ username, status, error: null });
    assert.equal(foldsToSummary([t("a", "installed"), t("b", "installed")], []), true);
    assert.equal(foldsToSummary([t("a", "installed")], []), false);
    assert.equal(foldsToSummary([t("a", "installed"), t("b", "pending")], []), false);
    assert.equal(foldsToSummary([t("a", "installed"), t("b", "error")], []), false);
    assert.equal(foldsToSummary([t("a", "installed"), t("b", "installed")], ["c"]), false);
    assert.equal(foldsToSummary([], []), false);
});
