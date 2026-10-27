import { test } from "node:test";
import assert from "node:assert/strict";
import { browserScript, cliFor, curlFor, fillPath, groupCounts, groupOf, groupRoutes, routeMatches, type ApiRoute } from "./apiCatalogue.ts";

const r = (method: string, path: string, extra: Partial<ApiRoute> = {}): ApiRoute => ({ method, path, tag: "", summary: "", token: true, scope: "tunnels:read", tunnel: "none", feature: null, ...extra });

const ROUTES: ApiRoute[] = [
    r("GET", "/api/auth/user/profile", { scope: null }),
    r("DELETE", "/api/reverse/server/{id}/lan/hosts/{host_id}", { scope: "tunnels:manage", tunnel: "path", tag: "LAN" }),
    r("GET", "/api/reverse/server/{id}/lan/hosts", { tunnel: "path", tag: "LAN", summary: "Hosts behind a device" }),
    r("POST", "/api/reverse/server/{id}/lan/hosts", { scope: "tunnels:manage", tunnel: "path", tag: "LAN" }),
    r("POST", "/api/browser/sessions", { scope: "browser:use", tunnel: "handler" }),
    r("POST", "/api/auth/tokens", { token: false, scope: null, tunnel: null, feature: "api.tokens" }),
];

test("groups follow the scope order, web-only last", () => {
    assert.equal(groupOf(ROUTES[0]), "any");
    assert.equal(groupOf(ROUTES[5]), "web");
    const groups = groupRoutes(ROUTES);
    assert.deepEqual(groups.map((g) => g.id), ["any", "tunnels:read", "browser:use", "tunnels:manage", "web"]);
    // 組內依路徑再依方法。/ Within a group: by path, then method.
    assert.deepEqual(groups[3].routes.map((x) => `${x.method} ${x.path}`), ["POST /api/reverse/server/{id}/lan/hosts", "DELETE /api/reverse/server/{id}/lan/hosts/{host_id}"]);
    assert.deepEqual(groupRoutes(ROUTES, { tokenOnly: true }).map((g) => g.id), ["any", "tunnels:read", "browser:use", "tunnels:manage"]);
    assert.equal(groupCounts(ROUTES).web, 1);
    assert.equal(groupCounts(ROUTES)["tunnels:manage"], 2);
});

test("search matches every word anywhere", () => {
    assert.ok(routeMatches(ROUTES[2], "lan GET"));
    assert.ok(routeMatches(ROUTES[2], "behind device"));
    assert.ok(routeMatches(ROUTES[4], "browser:use"));
    assert.ok(!routeMatches(ROUTES[2], "lan delete"));
    assert.ok(routeMatches(ROUTES[2], "  "));
    assert.deepEqual(groupRoutes(ROUTES, { query: "hosts" }).map((g) => g.id), ["tunnels:read", "tunnels:manage"]);
});

test("curl uses $TELEPY_TOKEN, fills the base and the path variables", () => {
    assert.equal(fillPath(ROUTES[1]), "/api/reverse/server/$TUNNEL_ID/lan/hosts/$HOST_ID");
    assert.equal(fillPath({ path: "/api/browser/sessions/{id}/text", tunnel: "handler" }), "/api/browser/sessions/$ID/text");
    assert.equal(curlFor(ROUTES[2], "https://t.example/"), 'curl -sS -H "Authorization: Bearer $TELEPY_TOKEN" "https://t.example/api/reverse/server/$TUNNEL_ID/lan/hosts"');
    const post = curlFor(ROUTES[3], "https://t.example");
    assert.ok(post.includes("-X POST") && post.includes('-H "Content-Type: application/json"') && post.includes(`-d '{"address":"192.168.1.20","label":"nas","username":"pi"}'`), post);
    // body 裡的變數不加引號、可以展開。/ A variable in the body is unquoted and expandable.
    const open = curlFor(ROUTES[4], "https://t.example");
    assert.ok(open.includes(`-d "{\\"tunnel_id\\":$TUNNEL_ID,\\"url\\":\\"http://192.168.1.1/\\"}"`), open);
    assert.ok(curlFor(r("GET", "/api/browser/sessions/{id}/screenshot", { tunnel: "handler" }), "https://t.example").includes("-o page.png"));
    assert.ok(curlFor(r("DELETE", "/api/sessions/{id}"), "https://t.example").includes("-X DELETE"));
    assert.ok(!curlFor(r("DELETE", "/api/sessions/{id}"), "https://t.example").includes("-d "), "no body on DELETE");
    assert.ok(!/tpt_/.test(curlFor(ROUTES[3], "https://t.example")), "never a real token");
});

test("CLI equivalents and the browser script", () => {
    assert.equal(cliFor("GET", "/api/reverse/server/{id}/lan/hosts"), "telepy lan ls <tunnel>");
    assert.equal(cliFor("DELETE", "/api/browser/sessions/{id}"), "telepy browse close <id>");
    assert.equal(cliFor("POST", "/api/auth/tokens"), null);
    const s = browserScript("https://t.example/", 7);
    assert.ok(s.curl.includes('\\"tunnel_id\\": 7') && s.curl.includes("https://t.example/api/browser/sessions"), s.curl);
    assert.ok(s.curl.includes("$TELEPY_TOKEN") && !s.curl.includes("tpt_"));
    assert.ok(s.cli.split("\n").every((l) => l.includes("telepy browse")));
});
