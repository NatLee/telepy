import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopProtocol, desktopUrl, portRows } from "./lanPorts.ts";

const names: Record<number, string> = { 22: "SSH", 80: "HTTP", 445: "SMB", 5432: "PostgreSQL" };
const name = (p: number) => names[p] ?? null;

test("one action per open port", () => {
    const rows = portRows(
        {
            address: "10.0.0.5",
            open_ports: [8443, 22, 445, 3389, 5901, 21118, 5432, 22],
            ssh_port: 22,
            ssh_banner: "SSH-2.0-OpenSSH_9.6",
            services: [
                { port: 22, proto: "ssh", banner: "SSH-2.0-OpenSSH_9.6" },
                { port: 8443, proto: "https", title: "pve - Proxmox Virtual Environment", server: "pve-api-daemon/3.0" },
            ],
        },
        name,
    );
    assert.deepEqual(rows.map((r) => [r.port, r.action.kind]), [
        [22, "ssh"], [445, "forward"], [3389, "desktop"], [5432, "forward"], [5901, "desktop"], [8443, "web"], [21118, "desktop"],
    ]);
    assert.equal(rows[0].name, "SSH-2.0-OpenSSH_9.6");
    const pve = rows.find((r) => r.port === 8443)!;
    assert.equal(pve.name, "pve - Proxmox Virtual Environment");
    assert.equal(pve.detail, "pve-api-daemon/3.0 · HTTPS");
    assert.equal(rows.find((r) => r.port === 445)!.name, "SMB");
    const desk = rows.find((r) => r.port === 21118)!.action;
    assert.deepEqual(desk, { kind: "desktop", protocol: "rustdesk" });
});

test("an SSH server on another port is still a terminal", () => {
    const rows = portRows({ address: "10.0.0.6", open_ports: [2222], ssh_port: 2222, ssh_banner: null });
    assert.equal(rows[0].action.kind, "ssh");
    const odd = portRows({ address: "10.0.0.7", open_ports: [7022], ssh_port: 22, ssh_banner: null, services: [{ port: 7022, proto: "ssh", banner: "SSH-2.0-dropbear" }] });
    assert.equal(odd[0].action.kind, "ssh");
});

test("desktop protocols and the page URL", () => {
    assert.equal(desktopProtocol(5905), "vnc");
    assert.equal(desktopProtocol(6000, "vnc"), "vnc");
    assert.equal(desktopProtocol(80), null);
    assert.equal(desktopUrl(3, 9, "rdp", 3389), "/tunnels/desktop?tunnel=3&lanHost=9&protocol=rdp&port=3389");
});

test("the desktop URL for the device itself has no LAN host", () => {
    assert.equal(desktopUrl(3, null, "vnc", 5900), "/tunnels/desktop?tunnel=3&protocol=vnc&port=5900");
    assert.equal(desktopUrl(3, 7, "rdp", 3389), "/tunnels/desktop?tunnel=3&lanHost=7&protocol=rdp&port=3389");
    // 面板選的裝置帳號跟著過去。/ The panel's device account goes along.
    assert.equal(desktopUrl(3, 7, "rdp", 3389, "ops admin"), "/tunnels/desktop?tunnel=3&lanHost=7&protocol=rdp&port=3389&account=ops%20admin");
});
