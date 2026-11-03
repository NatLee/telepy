import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { certDaysLeft, DEVICE_KINDS, deviceKind, identityLine, identityText, kindTally, seenScheme, type HostIdentity } from "./lanIdentity.ts";
import { hostMatches } from "./lanHosts.ts";

test("the type list matches the backend's", () => {
    const rust = readFileSync(new URL("../../../backend-api/src/lan/identify.rs", import.meta.url), "utf8");
    const m = /pub const KINDS: &\[&str\] = &\[([^\]]*)\]/.exec(rust);
    assert.ok(m);
    assert.deepEqual([...DEVICE_KINDS], m[1].split(",").map((x) => x.trim().replace(/"/g, "")));
});

const pve: HostIdentity = { product: "Proxmox VE", kind: "hypervisor", by: { source: "title", text: "pve - Proxmox Virtual Environment" } };

test("counts per type, unknown ones apart", () => {
    const t = kindTally([{ identity: pve }, { identity: { ...pve, kind: "router", product: "OpenWrt" } }, { identity: pve }, { identity: null }, {}]);
    assert.deepEqual(t.kinds, [{ kind: "router", count: 1 }, { kind: "hypervisor", count: 2 }]);
    assert.equal(t.unknown, 2);
    assert.equal(deviceKind({ identity: { ...pve, kind: "toaster" as never } }), null, "an unknown type from a newer server is ignored");
});

test("the one-line description", () => {
    assert.equal(identityLine({ identity: pve }), "Proxmox VE");
    assert.equal(identityLine({ identity: { ...pve, os: "Debian" } }), "Proxmox VE · Debian");
    assert.equal(identityLine({ identity: { product: "Raspberry Pi OS", kind: "computer", os: "Raspberry Pi OS", by: { source: "banner", text: "" } } }), "Raspberry Pi OS");
    assert.equal(identityLine({ identity: { product: null, kind: "server", os: "Ubuntu", by: { source: "banner", text: "" } } }), "Ubuntu");
    assert.equal(identityLine({}), null);
});

test("search by type, product and page title", () => {
    const host = { id: 1, tunnel_id: 1, address: "10.0.0.5", hostname: null, label: null, mac: null, vendor: null, ssh_banner: null, open_ports: [8006], ssh_port: 22, last_seen: null, identity: pve, services: [{ port: 8006, proto: "https", title: "pve - Proxmox Virtual Environment" }] };
    const row = { host, device: { name: "office" }, kind: "web" as const };
    assert.equal(hostMatches(row, ["type:hypervisor"]), true);
    assert.equal(hostMatches(row, ["type:router"]), false);
    assert.equal(hostMatches(row, ["proxmox"]), true);
    assert.match(identityText(host), /proxmox virtual environment/);
});

test("schemes seen and certificates", () => {
    const svc = [{ port: 8443, proto: "http" }, { port: 443, proto: "https", cert: { self_signed: true, not_after: 86400 * 10 } }];
    assert.equal(seenScheme(svc, 8443), "http");
    assert.equal(seenScheme(svc, 443), "https");
    assert.equal(seenScheme(svc, 80), null);
    assert.equal(certDaysLeft(svc[1], 86400 * 3), 7);
    assert.equal(certDaysLeft(svc[0], 0), null);
});
