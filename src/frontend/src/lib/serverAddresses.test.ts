import { test } from "node:test";
import assert from "node:assert/strict";
import { addressLanes, firstProblem, inForce, laneDoor, laneStatus } from "./serverAddresses.ts";
import { parseEnvMap } from "./settingSource.ts";

test(".env wins over what the page saved", () => {
    const env = parseEnvMap({ server_public_url: { var: "PUBLIC_URL", set: true, value: "https://env.example.com" }, server_ssh_host: { var: "SSH_SERVER_DOMAIN", set: false, value: null } });
    const values = { server_public_url: "https://saved.example.com", server_ssh_host: " ssh.example.com " };
    assert.equal(inForce(values, env, "server_public_url"), "https://env.example.com");
    assert.equal(inForce(values, env, "server_ssh_host"), "ssh.example.com");
    assert.equal(inForce(values, env, "server_proxy_url"), "");
});

test("each address falls back to something else when unset", () => {
    const none = addressLanes({}, {}, "https://telepy.example.com");
    assert.deepEqual(none, [
        { id: "web", value: "https://telepy.example.com", set: false, cdn: true },
        { id: "ssh", value: "telepy.example.com", set: false, cdn: false },
        { id: "proxy", value: "", set: false, cdn: true },
    ]);
    const all = addressLanes({ server_public_url: "https://t.example.com", server_ssh_host: "ssh.example.com", server_proxy_url: "https://proxy.example.com:8444" }, {}, "http://localhost:3000");
    assert.deepEqual(all.map((l) => [l.value, l.set]), [["https://t.example.com", true], ["ssh.example.com", true], ["https://proxy.example.com:8444", true]]);
    // SSH 沒設：跟著設好的網頁位址的主機。/ SSH unset: the host of the web address that is set.
    assert.equal(addressLanes({ server_public_url: "https://t.example.com:8443" }, {}, "http://localhost:3000")[1].value, "t.example.com");
});

test("a lane's status comes from the live checks", () => {
    const [web, ssh, proxy] = addressLanes({ server_proxy_url: "https://proxy.example.com:8444" }, {}, "https://telepy.example.com");
    // 還沒查到：不說話。/ Not checked yet: nothing said.
    assert.equal(laneStatus(web, {}), null);
    assert.equal(laneStatus(ssh, {}), null);
    assert.equal(laneStatus(proxy, {}), null);
    assert.deepEqual(laneStatus(web, { verdict: "split", webProxied: true }), { key: "cloudflare", tone: "plain" });
    assert.deepEqual(laneStatus(ssh, { verdict: "split", webProxied: true }), { key: "noProxy", tone: "ok" });
    assert.deepEqual(laneStatus(ssh, { verdict: "ssh_proxied", webProxied: true }), { key: "sshBlocked", tone: "bad" });
    assert.deepEqual(laneStatus(ssh, { verdict: "unresolved" }), { key: "unresolved", tone: "warn" });
    assert.deepEqual(laneStatus(web, { verdict: "local" }), { key: "local", tone: "plain" });
    assert.deepEqual(laneStatus(ssh, { verdict: "local" }), { key: "local", tone: "plain" });
    assert.deepEqual(laneStatus(proxy, { proxyListening: true }), { key: "listening", tone: "ok" });
    assert.deepEqual(laneStatus(proxy, { proxyListening: false }), { key: "portClosed", tone: "warn" });
    // 代理位址沒設定：那一格自己寫了，而且走的是網頁的入口。/ An unset proxy address: its cell says so, and it uses the web door.
    const unset = addressLanes({}, {}, "https://telepy.example.com")[2];
    assert.equal(laneStatus(unset, { proxyListening: false }), null);
    assert.equal(laneDoor(unset), "web");
    assert.equal(laneDoor(proxy), "proxy");
    assert.equal(laneDoor(ssh), "ssh");
});

test("the first lane with a problem is the one to open", () => {
    const lanes = addressLanes({ server_proxy_url: "https://proxy.example.com:8444" }, {}, "https://telepy.example.com");
    assert.equal(firstProblem(lanes, {}), null);
    assert.equal(firstProblem(lanes, { verdict: "same", proxyListening: true }), null);
    assert.equal(firstProblem(lanes, { verdict: "same", proxyListening: false }), "proxy");
    assert.equal(firstProblem(lanes, { verdict: "ssh_proxied", webProxied: true, proxyListening: false }), "ssh");
});
