import { test } from "node:test";
import assert from "node:assert/strict";
import { blockCounts, cellKind, gridStep, hostsByIp, intToIp, ipToInt, mapBlocks, parseCidr } from "./ipMap.ts";

test("addresses and CIDRs", () => {
    assert.equal(ipToInt("192.168.1.10"), 0xc0a8010a);
    assert.equal(intToIp(0xc0a8010a), "192.168.1.10");
    assert.equal(ipToInt("256.0.0.1"), null);
    assert.equal(ipToInt("localhost"), null);
    assert.deepEqual(parseCidr("192.168.1.77/24"), { base: 0xc0a80100, prefix: 24 });
    assert.equal(parseCidr("x/24"), null);
});

test("blocks from scanned networks: split, partial, merged", () => {
    const b = mapBlocks(["10.0.0.0/23", "192.168.1.64/26"], []);
    assert.deepEqual(b.map((x) => [intToIp(x.base), x.from, x.to, x.label]), [
        ["10.0.0.0", 0, 255, "10.0.0.0/24"],
        ["10.0.1.0", 0, 255, "10.0.1.0/24"],
        ["192.168.1.0", 64, 127, "192.168.1.64/26"],
    ]);
    assert.deepEqual(b[0].edges.map(intToIp), ["10.0.0.0"], "the /23's network address is in the first block");
    assert.deepEqual(b[1].edges.map(intToIp), ["10.0.1.255"], "its broadcast in the second");
    assert.deepEqual(mapBlocks(["127.0.0.1/32"], [])[0].edges, [], "a /32 has no edges");
    // 沒有掃描紀錄：主機所在的 /24。/ No scan record: the hosts' /24s.
    const d = mapBlocks([], ["192.168.5.20", "192.168.5.30", "10.1.1.1", "nas.lan"]);
    assert.deepEqual(d.map((x) => [intToIp(x.base), x.derived]), [["10.1.1.0", true], ["192.168.5.0", true]]);
});

test("what each cell is", () => {
    const [block] = mapBlocks(["192.168.1.0/24"], []);
    const hosts = hostsByIp([
        { address: "192.168.1.1", gateway: true },
        { address: "192.168.1.20" },
        { address: "192.168.1.30", missing: true },
        { address: "localhost", own: true, source: "self" },
    ]);
    const device = new Set([ipToInt("192.168.1.10")!]);
    assert.equal(cellKind(block, 0, hosts, device), "edge");
    assert.equal(cellKind(block, 255, hosts, device), "edge");
    assert.equal(cellKind(block, 1, hosts, device), "gateway");
    assert.equal(cellKind(block, 10, hosts, device), "device");
    assert.equal(cellKind(block, 20, hosts, device), "host");
    assert.equal(cellKind(block, 30, hosts, device), "missing");
    assert.equal(cellKind(block, 40, hosts, device), "free");
    assert.deepEqual(blockCounts(block, hosts, device), { used: 3, gateway: 1, missing: 1, device: 1, free: 250 });
    const [part] = mapBlocks(["192.168.1.64/26"], []);
    assert.equal(cellKind(part, 10, hosts, device), "outside");
});

test("arrow keys stay inside the network", () => {
    const inside = (i: number) => i >= 64 && i <= 127;
    assert.equal(gridStep(64, "ArrowRight", inside), 65);
    assert.equal(gridStep(64, "ArrowLeft", inside), 64, "the row's first cell inside");
    assert.equal(gridStep(64, "ArrowUp", inside), 64, "the row above is outside");
    assert.equal(gridStep(64, "ArrowDown", inside), 80);
    assert.equal(gridStep(127, "ArrowDown", inside), 127);
    assert.equal(gridStep(70, "Home", inside), 64);
    assert.equal(gridStep(70, "End", inside), 79);
    assert.equal(gridStep(79, "ArrowRight", () => true), 79, "no wrapping to the next row");
    assert.equal(gridStep(5, "x", inside), 5);
    // 手機上一列 8 格。/ Eight per row on phones.
    assert.equal(gridStep(64, "ArrowDown", inside, 8), 72);
    assert.equal(gridStep(71, "ArrowRight", () => true, 8), 71, "no wrapping at 8 either");
    assert.equal(gridStep(66, "End", inside, 8), 71);
});
