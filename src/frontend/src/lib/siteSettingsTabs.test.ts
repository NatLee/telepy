import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SITE_TAB_GROUPS, SITE_TAB_IDS, declaredTab, groupOfTab, parseSiteTab, siteTabOf } from "./siteSettingsTabs.ts";

/** 後端 `api/site_settings.rs` 的每一個設定。/ Every setting the backend's `api/site_settings.rs` serves. */
const backendKeys = (() => {
    const rust = readFileSync(new URL("../../../backend-api/src/api/site_settings.rs", import.meta.url), "utf8");
    return [...rust.matchAll(/FieldMeta \{ name: "([a-z0-9_]+)"/g)].map((m) => m[1]);
})();

test("the backend list was read", () => {
    assert.ok(backendKeys.length > 30, `only ${backendKeys.length} keys found — did the FieldMeta format change?`);
    assert.ok(backendKeys.includes("allow_registration"));
});

test("every backend setting has a declared home (none falls into the first tab by accident)", () => {
    const homeless = backendKeys.filter((k) => declaredTab(k) === null);
    assert.deepEqual(homeless, [], `give these a prefix rule or a KEY_HOMES entry: ${homeless.join(", ")}`);
});

test("every tab has something to show and sits in exactly one group", () => {
    for (const tab of SITE_TAB_IDS) {
        assert.ok(backendKeys.some((k) => siteTabOf(k) === tab), `tab ${tab} would be empty`);
        assert.equal(SITE_TAB_GROUPS.filter((g) => g.tabs.includes(tab)).length, 1, tab);
    }
    assert.equal(new Set(SITE_TAB_IDS).size, SITE_TAB_IDS.length);
});

test("the misfiled keys left the registration tab", () => {
    assert.equal(siteTabOf("lan_scan_enabled"), "devices");
    assert.equal(siteTabOf("device_ip_lookup_url"), "devices");
    assert.equal(siteTabOf("recording_retention_days"), "commands");
    const general = backendKeys.filter((k) => siteTabOf(k) === "general").sort();
    assert.deepEqual(general, ["allow_registration", "user_key_max_days", "valid_register_domains"]);
});

test("prefix rules", () => {
    assert.equal(siteTabOf("signin_page_style"), "signin");
    assert.equal(siteTabOf("mfa_require_totp"), "signin");
    assert.equal(siteTabOf("remote_browser_homepage"), "browser");
    assert.equal(siteTabOf("desktop_enabled"), "desktop");
    assert.equal(siteTabOf("ai_max_sessions_per_user"), "ai");
    assert.equal(siteTabOf("notify_max_webhooks"), "notify");
    assert.equal(siteTabOf("command_approval_timeout"), "commands");
    assert.equal(siteTabOf("terminal_detach_max_secs"), "commands");
});

test("an unknown key from a newer backend still shows somewhere", () => {
    assert.equal(declaredTab("brand_new_switch"), null);
    assert.equal(siteTabOf("brand_new_switch"), "general");
});

test("?tab= parsing and groups", () => {
    assert.equal(parseSiteTab(null), "general");
    assert.equal(parseSiteTab("devices"), "devices");
    assert.equal(parseSiteTab("users"), "general", "users moved to the admin section");
    assert.equal(parseSiteTab("nonsense"), "general");
    assert.equal(groupOfTab("signin"), "accounts");
    assert.equal(groupOfTab("ai"), "features");
});
