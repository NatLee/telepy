import { test } from "node:test";
import assert from "node:assert/strict";
import { bytes, cliExample, firstTunnel, httpProxyExample, listExample, pathStates, proxyState, pythonExample, sortSessions, wsUrl, type ProxySession, type ProxyTunnel } from "./proxy.ts";

const tunnel = (p: Partial<ProxyTunnel> & { id: number }): ProxyTunnel => ({ name: `t${p.id}`, online: true, accounts: ["ubuntu"], default_account: "ubuntu", blocked: null, ...p });

test("the page state follows the switch, the person and the tunnels", () => {
    const tunnels = [tunnel({ id: 1, blocked: "offline" }), tunnel({ id: 2 })];
    assert.equal(proxyState({ enabled: false, allowed: true, tunnels }), "off");
    assert.equal(proxyState({ enabled: true, allowed: false, tunnels }), "denied");
    assert.equal(proxyState({ enabled: true, allowed: true, tunnels: [tunnels[0]] }), "noTunnels");
    assert.equal(proxyState({ enabled: true, allowed: true, tunnels: [] }), "noTunnels");
    assert.equal(proxyState({ enabled: true, allowed: true, tunnels }), "ready");
    assert.equal(firstTunnel(tunnels)?.id, 2, "the first usable one");
    assert.equal(firstTunnel([tunnels[0]])?.id, 1);
    assert.equal(firstTunnel([]), null);
});

test("the path lights up to where it stops", () => {
    assert.deepEqual(pathStates("off", null), { app: "ok", token: "failed", telepy: "waiting", tunnel: "waiting", device: "waiting" });
    assert.deepEqual(pathStates("ready", tunnel({ id: 1 })), { app: "ok", token: "ok", telepy: "ok", tunnel: "ok", device: "ok" });
    assert.equal(pathStates("ready", tunnel({ id: 1, blocked: "step_up" })).tunnel, "failed");
});

test("examples are filled in and quoted", () => {
    assert.equal(cliExample("hd-dev"), "telepy proxy hd-dev --port 8118\ncurl -x http://127.0.0.1:8118 https://ifconfig.me");
    assert.ok(cliExample("my box").startsWith("telepy proxy 'my box' "));
    assert.equal(listExample("https://telepy.example.com/"), 'curl -H "Authorization: Bearer $TELEPY_TOKEN" https://telepy.example.com/api/proxy/tunnels');
    assert.equal(wsUrl("wss://telepy.example.com/ws/proxy/", "my box", "10.0.0.5", 5432), "wss://telepy.example.com/ws/proxy/?tunnel=my%20box&host=10.0.0.5&port=5432");
    assert.ok(pythonExample("wss://t.example/ws/proxy/", "hd-dev").includes('url = "wss://t.example/ws/proxy/?tunnel=hd-dev&host=localhost&port=8080"'));
    assert.equal(httpProxyExample("https://proxy.example.com:8443", "my box"), 'curl -x "https://my%20box:$TELEPY_TOKEN@proxy.example.com:8443" https://ifconfig.me');
});

test("byte counts and session order", () => {
    assert.equal(bytes(0), "0 B");
    assert.equal(bytes(1536), "1.5 KB");
    assert.equal(bytes(5 * 1024 * 1024), "5.0 MB");
    const s = (id: string, at: string) => ({ id, opened_at: at }) as ProxySession;
    assert.deepEqual(sortSessions([s("a", "2026-11-24T10:00:00+08:00"), s("b", "2026-11-24T11:00:00+08:00")]).map((x) => x.id), ["b", "a"]);
});
