import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { ADMIN_AREAS, adminAreaOf, movedSettingsTab, onPage } from "./adminAreas.ts";

const hrefs = ADMIN_AREAS.flatMap((a) => a.pages.map((p) => p.href));

test("every admin page belongs to exactly one area", () => {
    const dirs = readdirSync(new URL("../app/tunnels/admin/", import.meta.url), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => `/tunnels/admin/${d.name}`);
    for (const dir of dirs) {
        assert.equal(hrefs.filter((h) => h === dir).length, 1, `${dir} is in no area (or in two) — add it to ADMIN_AREAS`);
    }
    for (const href of hrefs.filter((h) => h.startsWith("/tunnels/admin/"))) {
        assert.ok(dirs.includes(href), `${href} has no page`);
    }
    assert.equal(new Set(hrefs).size, hrefs.length);
});

test("five areas instead of ten links; several-page areas stay small", () => {
    assert.equal(ADMIN_AREAS.length, 5);
    for (const area of ADMIN_AREAS) assert.ok(area.pages.length >= 1 && area.pages.length <= 5, area.id);
});

test("a path finds its area and page", () => {
    assert.equal(adminAreaOf("/tunnels/admin/sessions")?.area.id, "activity");
    assert.equal(adminAreaOf("/tunnels/admin/sessions")?.page.href, "/tunnels/admin/sessions");
    assert.equal(adminAreaOf("/tunnels/admin/access")?.area.id, "people");
    assert.equal(adminAreaOf("/tunnels/admin/notifications")?.area.id, "rules");
    assert.equal(adminAreaOf("/tunnels/settings")?.area.id, "settings");
    assert.equal(adminAreaOf("/tunnels/admin/health")?.area.id, "health");
    assert.equal(adminAreaOf("/tunnels/sessions"), null, "the personal page is not in the admin section");
    assert.equal(adminAreaOf("/tunnels"), null);
});

test("api-activity is not mistaken for activity", () => {
    assert.equal(onPage("/tunnels/admin/api-activity", "/tunnels/admin/activity"), false);
    assert.equal(adminAreaOf("/tunnels/admin/api-activity")?.page.href, "/tunnels/admin/api-activity");
    assert.equal(onPage("/tunnels/admin/activity/x", "/tunnels/admin/activity"), true);
});

test("old settings tabs point at their new pages", () => {
    assert.equal(movedSettingsTab("users", null), "/tunnels/admin/users");
    assert.equal(movedSettingsTab("access", null), "/tunnels/admin/access");
    assert.equal(movedSettingsTab("access", "12"), "/tunnels/admin/access?user=12");
    assert.equal(movedSettingsTab("access", "12&x=1"), "/tunnels/admin/access");
    assert.equal(movedSettingsTab("access", "-3"), "/tunnels/admin/access");
    assert.equal(movedSettingsTab("ai", null), null);
    assert.equal(movedSettingsTab(null, null), null);
});
