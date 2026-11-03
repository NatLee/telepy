import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { forwardCommand, hasWeb, parseWebInput, sameBrowser, shortUrl, WEB_HTTP_PORTS, WEB_HTTPS_PORTS, webLinks, webScheme, webUrl } from "./lanWeb.ts";

test("the port tables match the backend's", () => {
    const rust = readFileSync(new URL("../../../backend-api/src/lan/web.rs", import.meta.url), "utf8");
    const table = (name: string) => {
        const m = new RegExp(`pub const ${name}: &\\[u16\\] = &\\[([^\\]]*)\\]`).exec(rust);
        assert.ok(m, name);
        return m[1].split(",").map((x) => Number(x.trim()));
    };
    assert.deepEqual([...WEB_HTTPS_PORTS], table("WEB_HTTPS_PORTS"));
    assert.deepEqual([...WEB_HTTP_PORTS], table("WEB_HTTP_PORTS"));
});

test("schemes and URLs", () => {
    assert.equal(webScheme(8006), "https");
    assert.equal(webScheme(8123), "http");
    assert.equal(webScheme(22), null);
    assert.equal(webUrl("192.168.1.10", 80, "http"), "http://192.168.1.10/");
    assert.equal(webUrl("192.168.1.10", 443, "https", "admin"), "https://192.168.1.10/admin");
    assert.equal(webUrl("fd00::1", 8080, "http"), "http://[fd00::1]:8080/");
});

test("web links prefer the backend's list", () => {
    const host = { address: "10.0.0.5", open_ports: [8080, 22, 443, 8080] };
    assert.deepEqual(webLinks(host).map((l) => l.url), ["https://10.0.0.5/", "http://10.0.0.5:8080/"]);
    assert.deepEqual(webLinks({ ...host, web: [{ port: 9, scheme: "http", url: "http://x:9/" }] }).map((l) => l.port), [9]);
    assert.equal(hasWeb({ address: "10.0.0.5", open_ports: [22, 3389] }), false);
});

test("what people type in the other-page field", () => {
    const a = "192.168.1.10";
    assert.deepEqual(parseWebInput(a, "8080"), { url: "http://192.168.1.10:8080/" });
    assert.deepEqual(parseWebInput(a, "8443/ui"), { url: "https://192.168.1.10:8443/ui" });
    assert.deepEqual(parseWebInput(a, "/admin"), { url: "http://192.168.1.10/admin" });
    assert.deepEqual(parseWebInput(a, "https:9999"), { url: "https://192.168.1.10:9999/" });
    assert.deepEqual(parseWebInput(a, " http://nas.local:5000/x "), { url: "http://nas.local:5000/x" });
    assert.deepEqual(parseWebInput(a, ""), { error: "empty" });
    assert.deepEqual(parseWebInput(a, "ftp://x/"), { error: "scheme" });
    assert.deepEqual(parseWebInput(a, "file:///etc/passwd"), { error: "scheme" });
    assert.deepEqual(parseWebInput(a, "99999"), { error: "port" });
    assert.deepEqual(parseWebInput(a, "admin"), { error: "port" });
});

test("short labels and browser identity", () => {
    assert.equal(shortUrl("http://192.168.1.10:8080/"), "192.168.1.10:8080");
    assert.equal(shortUrl("https://nas/admin"), "nas/admin");
    assert.equal(sameBrowser({ tunnelId: 1, deviceUser: "pi" }, { tunnelId: 1, deviceUser: "pi" }), true);
    assert.equal(sameBrowser({ tunnelId: 1, deviceUser: "pi" }, { tunnelId: 1, deviceUser: "root" }), false);
});

test("the CLI command for your own browser", () => {
    assert.equal(forwardCommand("office-pi", "pi", "192.168.1.10", 8080), "telepy forward office-pi@pi 192.168.1.10:8080 --open");
    assert.equal(forwardCommand("my box", null, "192.168.1.10", 443), "telepy forward 'my box' 192.168.1.10:443 --open");
});
