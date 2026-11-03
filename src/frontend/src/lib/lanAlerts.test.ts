import { test } from "node:test";
import assert from "node:assert/strict";
import { lanNewHostsText, lanWatchText, portDeltaText } from "./lanAlerts.ts";

const t = (key: string, vars: Record<string, string | number> = {}) => `${key}|${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")}`;

test("alert sentences", () => {
    assert.equal(portDeltaText([443], [80, 22]), "+443 −80 −22");
    assert.equal(lanNewHostsText(t, { tunnel_name: "box", count: 1, hosts: [{ name: "nas", address: "10.0.0.5" }] }), "network.alert.newHosts|count=1,name=box,list=nas (10.0.0.5),more=0");
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `10.0.0.${i}`, address: `10.0.0.${i}` }));
    assert.match(lanNewHostsText(t, { tunnel_name: "box", count: 5, hosts: many }), /^network\.alert\.newHostsMore\|.*list=10\.0\.0\.0, 10\.0\.0\.1, 10\.0\.0\.2,more=2$/);
    assert.equal(lanWatchText(t, { tunnel_name: "box", host: "nas", address: "10.0.0.5", state: "down" }), "network.alert.down|host=nas (10.0.0.5),name=box");
    assert.equal(lanWatchText(t, { tunnel_name: "box", host: "10.0.0.5", address: "10.0.0.5", state: "up" }), "network.alert.up|host=10.0.0.5,name=box");
    assert.equal(lanWatchText(t, { tunnel_name: "box", host: "nas", address: "10.0.0.5", state: "ports", opened: [443], closed: [] }), "network.alert.ports|host=nas (10.0.0.5),name=box,delta=+443");
});
