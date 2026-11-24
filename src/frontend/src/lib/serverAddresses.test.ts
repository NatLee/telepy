import { test } from "node:test";
import assert from "node:assert/strict";
import { addressLanes, inForce } from "./serverAddresses.ts";
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
        { id: "proxy", value: "wss://telepy.example.com/ws/proxy/", set: false, cdn: true },
    ]);
    const all = addressLanes({ server_public_url: "https://t.example.com", server_ssh_host: "ssh.example.com", server_proxy_url: "https://proxy.example.com:8444" }, {}, "http://localhost:3000");
    assert.deepEqual(all.map((l) => [l.value, l.set]), [["https://t.example.com", true], ["ssh.example.com", true], ["https://proxy.example.com:8444", true]]);
    // SSH 沒設：跟著設好的網頁位址的主機。/ SSH unset: the host of the web address that is set.
    assert.equal(addressLanes({ server_public_url: "https://t.example.com:8443" }, {}, "http://localhost:3000")[1].value, "t.example.com");
});
