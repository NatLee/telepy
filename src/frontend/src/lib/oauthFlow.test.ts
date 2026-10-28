import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeQuery, isAuthorizePath, loginPathFor, matchesTunnel, parseCliDone } from "./oauthFlow.ts";

const consent = "/oauth/authorize?response_type=code&client_id=abc&state=x%26y";

test("isAuthorizePath recognises the consent page only", () => {
    assert.equal(isAuthorizePath(consent), true);
    assert.equal(isAuthorizePath("/oauth/authorize"), true);
    assert.equal(isAuthorizePath("/oauth/authorize/"), true);
    assert.equal(isAuthorizePath("/oauth/authorizex?a=1"), false);
    assert.equal(isAuthorizePath("/tunnels"), false);
    assert.equal(isAuthorizePath("//evil.example/oauth/authorize"), false);
    assert.equal(isAuthorizePath("https://evil.example/oauth/authorize"), false);
    assert.equal(isAuthorizePath(null), false);
});

test("authorizeQuery returns the request query", () => {
    assert.equal(authorizeQuery(consent), "response_type=code&client_id=abc&state=x%26y");
    assert.equal(authorizeQuery("/oauth/authorize"), "");
    assert.equal(authorizeQuery("/oauth/authorize?a=1#frag"), "a=1");
    assert.equal(authorizeQuery("/tunnels?a=1"), null);
});

test("loginPathFor sends the consent page to the OAuth sign-in", () => {
    assert.equal(loginPathFor(consent), `/oauth/login?next=${encodeURIComponent(consent)}`);
    assert.equal(loginPathFor("/tunnels/keys"), `/login?next=${encodeURIComponent("/tunnels/keys")}`);
    assert.equal(loginPathFor(undefined), "/login");
    assert.equal(loginPathFor("//evil.example"), "/login");
    assert.equal(loginPathFor("/\\evil.example"), "/login");
});

test("matchesTunnel needs every word", () => {
    assert.equal(matchesTunnel("Office-NAS", "nas"), true);
    assert.equal(matchesTunnel("Office-NAS", "office nas"), true);
    assert.equal(matchesTunnel("Office-NAS", "office pi"), false);
    assert.equal(matchesTunnel("Office-NAS", "  "), true);
});

test("the CLI's done page only understands the CLI's own words", () => {
    const q = (s: string) => parseCliDone(new URLSearchParams(s));
    assert.deepEqual(q("client_id=abc&result=ok"), { clientId: "abc", outcome: { kind: "ok" } });
    assert.deepEqual(q("client_id=abc&result=denied"), { clientId: "abc", outcome: { kind: "denied" } });
    assert.deepEqual(q("client_id=abc&result=failed&reason=state"), { clientId: "abc", outcome: { kind: "failed", reason: "state" } });
    assert.deepEqual(q("result=failed&reason=exchange").outcome, { kind: "failed", reason: "exchange" });
    // 任意文字不會跑到頁面上：不認得的原因 / 結果都是「沒完成」。/ Free text never reaches the page.
    assert.deepEqual(q("result=failed&reason=Call+this+number").outcome, { kind: "failed", reason: "error" });
    assert.deepEqual(q("result=hacked").outcome, { kind: "failed", reason: "error" });
    assert.deepEqual(q(""), { clientId: null, outcome: { kind: "failed", reason: "error" } });
});
