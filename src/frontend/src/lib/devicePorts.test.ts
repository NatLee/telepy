import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyKey, portHint, portName, portsErrorKey, splitPorts, type DevicePort } from "./devicePorts.ts";

const port = (p: Partial<DevicePort> & { port: number }): DevicePort => ({ web: "maybe", scheme: "http", url: `http://localhost:${p.port}/`, title: null, proto: null, loopback_only: false, ...p });
const names: Record<number, string> = { 22: "SSH", 3000: "HTTP", 5432: "PostgreSQL", 8123: "Home Assistant" };
const known = (n: number) => names[n] ?? null;

test("web pages and the rest are told apart by having a URL", () => {
    const list = [port({ port: 3000, web: "seen", title: "Grafana" }), port({ port: 5173 }), port({ port: 22, web: "no", url: null, scheme: null, proto: "ssh" })];
    const { web, other } = splitPorts(list);
    assert.deepEqual(web.map((p) => p.port), [3000, 5173]);
    assert.deepEqual(other.map((p) => p.port), [22]);
});

test("a port is named by the scan first, then by what usually runs there", () => {
    assert.equal(portName(port({ port: 3000, title: "Grafana" }), known), "Grafana");
    assert.equal(portName(port({ port: 9999, web: "no", url: null, proto: "ssh" }), known), "SSH");
    assert.equal(portName(port({ port: 5432, web: "no", url: null }), known), "PostgreSQL");
    assert.equal(portName(port({ port: 8123, web: "usual" }), known), "Home Assistant");
    // 網頁 port 的「HTTP」不是名字。/ "HTTP" doesn't name a web port.
    assert.equal(portName(port({ port: 3000, web: "usual" }), known), null);
    assert.equal(portName(port({ port: 5173 }), known), null);
});

test("hints, errors and the empty state", () => {
    assert.equal(portHint(port({ port: 1, web: "seen" })), "browser.ports.seen");
    assert.equal(portHint(port({ port: 1, web: "usual" })), "browser.ports.usual");
    assert.equal(portHint(port({ port: 1 })), "browser.ports.maybe");
    assert.equal(portHint(port({ port: 22, web: "no", url: null })), null);
    assert.equal(portsErrorKey("device_offline"), "browser.ports.offline");
    assert.equal(portsErrorKey("ports_failed"), null);
    assert.equal(emptyKey({ listed: true }), "browser.ports.empty");
    assert.equal(emptyKey({ listed: false }), "browser.ports.noTool");
});
