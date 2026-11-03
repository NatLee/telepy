import { test } from "node:test";
import assert from "node:assert/strict";
import { laneStates, pathStates, type FlowInput } from "./networkFlow.ts";

const all = { terminal: true, remote_desktop: true, remote_browser: true, network: true };
const device = { online: true, usernames: ["pi"], can_scan: true };
const nas = { open_ports: [22, 5001], ssh_port: 22, ssh_banner: null, web: [{ port: 5001 }] };

test("every lane of a reachable host", () => {
    const l = laneStates({ host: nas, device, features: all });
    assert.deepEqual([l.terminal.state, l.desktop.state, l.web.state, l.commands.state, l.scan.state], ["ok", "waiting", "ok", "ok", "ok"]);
    assert.equal(l.desktop.why, "noDesktop");
});

test("where it stops", () => {
    const off: FlowInput = { host: nas, device: { ...device, online: false }, features: all };
    assert.ok(Object.values(laneStates(off)).every((x) => x.state === "failed" && x.why === "offline"));
    const noAcct = laneStates({ host: nas, device: { ...device, usernames: [] }, features: all });
    assert.equal(noAcct.terminal.why, "noAccount");
    const noBrowser = laneStates({ host: nas, device, features: { ...all, remote_browser: false } });
    assert.deepEqual(noBrowser.web, { state: "failed", why: "feature" });
    const viewer = laneStates({ host: nas, device: { ...device, can_scan: false }, features: all });
    assert.equal(viewer.scan.why, "notManager");
    const none = laneStates({ host: null, device, features: all });
    assert.equal(none.terminal.why, "pick");
});

test("the path", () => {
    assert.deepEqual(pathStates({ host: nas, device, features: all }), { telepy: "ok", tunnel: "ok", device: "ok", lan: "ok", host: "ok" });
    assert.deepEqual(pathStates({ host: nas, device: { ...device, online: false }, features: all }), { telepy: "ok", tunnel: "failed", device: "failed", lan: "failed", host: "waiting" });
    assert.equal(pathStates({ host: null, device, features: all }).host, "waiting");
});
