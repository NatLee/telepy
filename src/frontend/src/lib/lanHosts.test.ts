import { test } from "node:test";
import assert from "node:assert/strict";
import { initialNetworkView, HOSTS_VIEW_ABOVE, compareAddress, countKinds, flattenHosts, hasSsh, hostKind, hostMatches, parseRecent, pushRecent, queryTerms, recentRows, RECENT_MAX, sortHosts, stepIndex } from "./lanHosts.ts";

let next = 1;
const host = (address: string, more: Partial<{ hostname: string; label: string; mac: string; vendor: string; ssh_banner: string; open_ports: number[]; ssh_port: number; last_seen: string }> = {}) => ({
    id: next++,
    tunnel_id: 0,
    address,
    hostname: more.hostname ?? null,
    label: more.label ?? null,
    mac: more.mac ?? null,
    vendor: more.vendor ?? null,
    ssh_banner: more.ssh_banner ?? null,
    open_ports: more.open_ports ?? [],
    ssh_port: more.ssh_port ?? 22,
    last_seen: more.last_seen ?? null,
});

const devices = [
    { id: 1, name: "office", hosts: [host("192.168.1.10", { hostname: "nas", vendor: "Synology Incorporated", open_ports: [22, 445] }), host("192.168.1.9", { open_ports: [3389], last_seen: "2026-10-27T10:00:00Z" })] },
    { id: 2, name: "factory", hosts: [host("10.0.0.20", { label: "Front desk printer", open_ports: [9100, 80], last_seen: "2026-10-28T10:00:00Z" })] },
];
const rows = flattenHosts(devices);

test("kinds come from the open ports; ssh wins", () => {
    assert.equal(hostKind({ open_ports: [22, 3389], ssh_port: 22, ssh_banner: null }), "ssh");
    assert.equal(hostKind({ open_ports: [5900], ssh_port: 22, ssh_banner: null }), "desktop");
    assert.equal(hostKind({ open_ports: [], ssh_port: 22, ssh_banner: "SSH-2.0" }), "ssh");
    assert.equal(hostKind({ open_ports: [8443], ssh_port: 22, ssh_banner: null }), "web");
    assert.equal(hasSsh({ open_ports: [2222], ssh_port: 2222, ssh_banner: null }), true);
});

test("flatten keeps the device and the display name", () => {
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => [r.device.name, r.name, r.kind]), [
        ["office", "nas", "ssh"],
        ["office", "192.168.1.9", "desktop"],
        ["factory", "Front desk printer", "web"],
    ]);
});

test("search: words are ANDed over name, address, vendor, device and kind", () => {
    const find = (q: string, label?: (k: string) => string) => rows.filter((r) => hostMatches(r, queryTerms(q), label)).map((r) => r.name);
    assert.deepEqual(find("synology"), ["nas"]);
    assert.deepEqual(find("office 192.168.1.9"), ["192.168.1.9"]);
    assert.deepEqual(find("printer factory"), ["Front desk printer"]);
    assert.deepEqual(find("desktop"), ["192.168.1.9"]);
    // 翻譯後的種類名稱也算。/ The translated kind label counts too.
    assert.deepEqual(find("遠端", (k) => (k === "desktop" ? "遠端桌面" : k)), ["192.168.1.9"]);
    assert.deepEqual(find(""), ["nas", "192.168.1.9", "Front desk printer"]);
});

test("search: a number is an open port or part of an address; port: and kind: are strict", () => {
    const find = (q: string) => rows.filter((r) => hostMatches(r, queryTerms(q))).map((r) => r.name);
    assert.deepEqual(find("445"), ["nas"]);
    assert.deepEqual(find("20"), ["Front desk printer"]); // 10.0.0.20
    assert.deepEqual(find("port:80"), ["Front desk printer"]);
    assert.deepEqual(find("port:20"), []);
    assert.deepEqual(find("kind:ssh"), ["nas"]);
});

test("addresses sort numerically, non-IPv4 last", () => {
    const list = ["10.0.0.10", "printer.local", "10.0.0.9", "9.1.1.1"].sort(compareAddress);
    assert.deepEqual(list, ["9.1.1.1", "10.0.0.9", "10.0.0.10", "printer.local"]);
});

test("sort by name, address, device and last seen (never seen last)", () => {
    assert.deepEqual(sortHosts(rows, "address").map((r) => r.host.address), ["10.0.0.20", "192.168.1.9", "192.168.1.10"]);
    assert.deepEqual(sortHosts(rows, "name").map((r) => r.name), ["192.168.1.9", "Front desk printer", "nas"]);
    assert.deepEqual(sortHosts(rows, "device").map((r) => r.device.name), ["factory", "office", "office"]);
    assert.deepEqual(sortHosts(rows, "seen").map((r) => r.name), ["Front desk printer", "192.168.1.9", "nas"]);
    assert.deepEqual(sortHosts(rows, "seen", true).map((r) => r.name), ["nas", "192.168.1.9", "Front desk printer"]);
    assert.equal(rows[0].name, "nas", "the input is not mutated");
});

test("kind counts", () => {
    assert.deepEqual(countKinds(rows), { all: 3, ssh: 1, desktop: 1, files: 0, web: 1, other: 0 });
});

test("recent hosts: newest first, de-duplicated, capped, bad storage ignored", () => {
    let list = pushRecent([], 1, 10, 1);
    list = pushRecent(list, 2, 20, 2);
    list = pushRecent(list, 1, 10, 3);
    assert.deepEqual(list.map((x) => x.hostId), [10, 20]);
    for (let i = 0; i < 20; i++) list = pushRecent(list, 1, 100 + i, 10 + i);
    assert.equal(list.length, RECENT_MAX);
    assert.deepEqual(parseRecent(JSON.stringify(list)), list);
    assert.deepEqual(parseRecent("{oops"), []);
    assert.deepEqual(parseRecent(JSON.stringify([{ tunnelId: 1 }, { tunnelId: 1, hostId: 2, at: 5 }])), [{ tunnelId: 1, hostId: 2, at: 5 }]);
});

test("recent rows skip hosts that are gone", () => {
    const ids = rows.map((r) => r.host.id);
    const recent = [{ tunnelId: 2, hostId: ids[2], at: 2 }, { tunnelId: 9, hostId: 9999, at: 1 }, { tunnelId: 1, hostId: ids[0], at: 0 }];
    assert.deepEqual(recentRows(recent, rows).map((r) => r.name), ["Front desk printer", "nas"]);
});

test("arrow keys step within the list", () => {
    assert.equal(stepIndex(-1, 5, 1), 0);
    assert.equal(stepIndex(-1, 5, -1), 4);
    assert.equal(stepIndex(4, 5, 1), 4);
    assert.equal(stepIndex(2, 5, -1), 1);
    assert.equal(stepIndex(0, 0, 1), -1);
});

test("start view: deep link = topology, then the remembered choice, then the host count", () => {
    assert.equal(initialNetworkView("hosts", 500, true), "tree");
    assert.equal(initialNetworkView("tree", 500, false), "tree");
    assert.equal(initialNetworkView("hosts", 3, false), "hosts");
    assert.equal(initialNetworkView(null, HOSTS_VIEW_ABOVE, false), "tree");
    assert.equal(initialNetworkView(null, HOSTS_VIEW_ABOVE + 1, false), "hosts");
    assert.equal(initialNetworkView("bogus", 0, false), "tree");
});
