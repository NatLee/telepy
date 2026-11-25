import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyKey, groupPorts, matchPort, portGroup, portName, portsErrorKey, shownGroup, splitPorts, type DevicePort } from "./devicePorts.ts";

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

test("errors and the empty state", () => {
    assert.equal(portsErrorKey("device_offline"), "browser.ports.offline");
    assert.equal(portsErrorKey("ports_failed"), null);
    assert.equal(emptyKey({ listed: true }), "browser.ports.empty");
    assert.equal(emptyKey({ listed: false }), "browser.ports.noTool");
});

test("each port lands in one group, and the non-web ones are the ones without a URL", () => {
    const list = [port({ port: 3000, web: "seen" }), port({ port: 8123, web: "usual" }), port({ port: 5173 }), port({ port: 22, web: "no", url: null, scheme: null })];
    const g = groupPorts(list);
    assert.deepEqual([g.seen, g.usual, g.maybe, g.no].map((l) => l.map((p) => p.port)), [[3000], [8123], [5173], [22]]);
    // 有網址就打得開，就算分類說 no。/ A URL means it opens, whatever the class says.
    assert.equal(portGroup(port({ port: 9, web: "no" })), "maybe");
});

test("search matches the number or the name", () => {
    const p = port({ port: 8080, title: "Portainer" });
    assert.equal(matchPort(p, "", null), true);
    assert.equal(matchPort(p, "80", null), true);
    assert.equal(matchPort(p, ":8080", null), true);
    assert.equal(matchPort(p, "PORTAIN", "Portainer"), true);
    assert.equal(matchPort(port({ port: 5432, web: "no", url: null }), "postgres", "PostgreSQL"), true);
    assert.equal(matchPort(p, "grafana", "Portainer"), false);
});

test("the shown group follows the choice, then the first group that has ports", () => {
    const g = groupPorts([port({ port: 5173 }), port({ port: 22, web: "no", url: null })]);
    assert.equal(shownGroup(g, null), "maybe");
    assert.equal(shownGroup(g, "no"), "no");
    assert.equal(shownGroup(g, "seen"), "maybe");
    assert.equal(shownGroup(groupPorts([]), "usual"), "usual");
});
