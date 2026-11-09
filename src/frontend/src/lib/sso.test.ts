import { test } from "node:test";
import assert from "node:assert/strict";
import { badDomain, canUnlink, postLogoutUrl, fromRuleValue, grantsAdmin, groupLines, orderedClaims, parseNamed, parseScimGroupsAs, ruleTargetKind, ruleValue, tidyRules, parseDomains, parseSsoButtons, providerName, readSsoReturn, slugify, ssoErrorKey, ssoStartUrl, withoutSsoParams } from "./sso.ts";

test("buttons come from the public endpoint; anything odd is dropped", () => {
    assert.deepEqual(parseSsoButtons([{ slug: "okta", name: "Okta" }, { slug: "Bad Slug", name: "x" }, { slug: "kc", name: " " }, 3, null]), [
        { slug: "okta", name: "Okta" },
        { slug: "kc", name: "kc" },
    ]);
    assert.equal(parseSsoButtons(undefined), null, "an older backend says nothing");
    assert.equal(providerName([{ slug: "okta", name: "Okta" }], "okta"), "Okta");
    assert.equal(providerName(null, "gone"), "gone");
});

test("the start URL keeps only same-site paths as next", () => {
    assert.equal(ssoStartUrl("okta"), "/api/auth/oidc/okta/start");
    assert.equal(ssoStartUrl("okta", "/tunnels"), "/api/auth/oidc/okta/start", "the default needs no next");
    assert.equal(ssoStartUrl("okta", "/oauth/authorize?client_id=a&x=1"), "/api/auth/oidc/okta/start?next=%2Foauth%2Fauthorize%3Fclient_id%3Da%26x%3D1");
    assert.equal(ssoStartUrl("okta", "//evil.example"), "/api/auth/oidc/okta/start");
    assert.equal(ssoStartUrl("okta", "https://evil.example"), "/api/auth/oidc/okta/start");
});

test("the callback's ticket and errors are read and then removed", () => {
    assert.deepEqual(readSsoReturn("?sso=abc&next=%2Ftunnels%2Fkeys"), { ticket: "abc", error: null, provider: null });
    assert.deepEqual(readSsoReturn("?sso_error=sso_denied&sso_provider=okta"), { ticket: null, error: "sso_denied", provider: "okta" });
    assert.equal(withoutSsoParams("/login?sso=abc&next=%2Ftunnels%2Fkeys"), "/login?next=%2Ftunnels%2Fkeys");
    assert.equal(withoutSsoParams("/login?sso_error=x&sso_provider=y"), "/login");
    assert.equal(ssoErrorKey("sso_domain_not_allowed"), "sso.err.domain");
    assert.equal(ssoErrorKey("something_new"), "sso.err.failed");
    assert.equal(ssoErrorKey(null), "sso.err.failed");
});

test("slugs match the backend and domains are tidied", () => {
    assert.equal(slugify("Okta (prod)"), "okta-prod");
    assert.equal(slugify("  Microsoft Entra ID  "), "microsoft-entra-id");
    assert.equal(slugify("公司登入"), "sso");
    assert.equal(slugify("a".repeat(40)), "a".repeat(32));
    assert.equal(slugify("x".repeat(31) + " y"), "x".repeat(31), "no dash left at the end after cutting");
    assert.deepEqual(parseDomains(" @Corp.example, corp.example  sub.corp.example"), ["corp.example", "sub.corp.example"]);
    assert.equal(badDomain(["corp.example", "localhost"]), "localhost");
    assert.equal(badDomain(["-bad.example"]), "-bad.example");
    assert.equal(badDomain(["corp.example"]), null);
});

test("claims Telepy reads come first", () => {
    const rows = orderedClaims({ zeta: 1, email: "a@b", sub: "u", aud: "x" });
    assert.deepEqual(rows.map(([k, , read]) => [k, read]), [["sub", true], ["email", true], ["aud", false], ["zeta", false]]);
});

test("the last way in can't be unlinked", () => {
    const links = { providers: [{ id: 1, slug: "a", name: "A", enabled: true, linked: true }, { id: 2, slug: "b", name: "B", enabled: true, linked: false }], has_password: false, google: false, passkeys: 0 };
    assert.equal(canUnlink(links, 1), false);
    assert.equal(canUnlink({ ...links, passkeys: 1 }, 1), true, "a passkey signs in without a password");
    assert.equal(canUnlink({ ...links, has_password: true }, 1), true);
    assert.equal(canUnlink({ ...links, providers: links.providers.map((p) => ({ ...p, linked: true })) }, 1), true, "another provider");
});

test("group lists and rules are tidied before saving", () => {
    assert.deepEqual(groupLines(" staff\n\nops \r\nstaff\n"), ["staff", "ops"]);
    const rules = [
        { idp_group: " ops ", target: "group" as const, group_id: 3 },
        { idp_group: "ops", target: "group" as const, group_id: 3 },
        { idp_group: "root", target: "admin" as const, group_id: 9 },
    ];
    assert.deepEqual(tidyRules(rules), { rules: [{ idp_group: "ops", target: "group", group_id: 3 }, { idp_group: "root", target: "admin", group_id: null }], problem: null });
    assert.equal(tidyRules([{ idp_group: " ", target: "admin", group_id: null }]).problem, "group_name");
    assert.equal(tidyRules([{ idp_group: "x", target: "group", group_id: null }]).problem, "target");
    assert.equal(grantsAdmin(rules), true);
    assert.equal(ruleValue({ target: "group", group_id: 3 }), "group:3");
    assert.deepEqual(fromRuleValue("group:3"), { target: "group", group_id: 3 });
    assert.deepEqual(fromRuleValue("admin"), { target: "admin", group_id: null });
    assert.equal(ssoErrorKey("sso_group_not_allowed"), "sso.err.groupNotAllowed");
});

test("the post-logout URL comes from the callback base", () => {
    assert.equal(postLogoutUrl("https://telepy.example/api/auth/oidc/"), "https://telepy.example/login");
    assert.equal(postLogoutUrl("http://localhost:3123/api/auth/oidc"), "http://localhost:3123/login");
});

test("a rule targets a role or a group, never a personal group", () => {
    const roles = [{ id: 1 }, { id: 2 }];
    const groups = [{ id: 7 }];
    assert.equal(ruleTargetKind(2, roles, groups), "role");
    assert.equal(ruleTargetKind(7, roles, groups), "group");
    assert.equal(ruleTargetKind(9, roles, groups), null, "a deleted (or personal) group is not offered");
    assert.equal(ruleTargetKind(null, roles, groups), null);
    assert.equal(ruleValue({ target: "group", group_id: 7 }), "group:7", "roles and groups share one value format");
});

test("what SCIM groups become, read defensively", () => {
    assert.equal(parseScimGroupsAs("group"), "group");
    assert.equal(parseScimGroupsAs("role"), "role");
    assert.equal(parseScimGroupsAs(undefined), "role", "an older backend pushed roles");
    assert.equal(parseScimGroupsAs("weird"), "role");
    assert.deepEqual(parseNamed([{ id: 3, name: "Ops" }, { id: 4 }, { name: "x" }, null]), [{ id: 3, name: "Ops" }, { id: 4, name: "#4" }]);
    assert.deepEqual(parseNamed(undefined), []);
});
