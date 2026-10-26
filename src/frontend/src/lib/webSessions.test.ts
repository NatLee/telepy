import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceKind, formatLifetime, groupSessions, lifetimeParts, orderSessions, sessionDiagram, type WebSessionRow } from "./webSessions.ts";

const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const WIN_FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";

const row = (id: number, ua: string | null, lastSeen: string, current = false, expires = "2026-11-20T00:00:00Z"): WebSessionRow => ({
    id,
    ip: "198.51.100.7",
    user_agent: ua,
    created_at: "2026-10-01T00:00:00Z",
    last_seen_at: lastSeen,
    expires_at: expires,
    current,
    sign_in_method: "password",
    mfa_method: null,
});

test("device kinds", () => {
    assert.equal(deviceKind(IPHONE_SAFARI), "phone");
    assert.equal(deviceKind(MAC_CHROME), "computer");
    assert.equal(deviceKind("curl/8"), "unknown");
    assert.equal(deviceKind(null), "unknown");
});

test("this browser first, then the most recently used", () => {
    const rows = [row(1, MAC_CHROME, "2026-10-26T10:00:00Z"), row(2, WIN_FIREFOX, "2026-10-27T10:00:00Z"), row(3, IPHONE_SAFARI, "2026-10-01T10:00:00Z", true)];
    assert.deepEqual(orderSessions(rows).map((r) => r.id), [3, 2, 1]);
});

test("sessions group by browser and OS", () => {
    const rows = [
        row(1, MAC_CHROME, "2026-10-20T10:00:00Z"),
        row(2, WIN_FIREFOX, "2026-10-27T10:00:00Z"),
        row(3, MAC_CHROME.replace("130.0", "131.0"), "2026-10-25T10:00:00Z", true),
        row(4, null, "2026-10-21T10:00:00Z"),
        row(5, "weird", "2026-10-22T10:00:00Z"),
    ];
    const groups = groupSessions(rows);
    assert.deepEqual(groups.map((g) => g.label), ["Chrome · macOS", "Firefox · Windows", null]);
    assert.deepEqual(groups[0].sessions.map((s) => s.id), [3, 1], "another Chrome version is the same device type; the current one first");
    assert.equal(groups[0].current, true);
    assert.equal(groups[1].current, false);
    assert.deepEqual(groups[2].sessions.map((s) => s.id), [5, 4], "unrecognised browsers share one group");
    assert.equal(groups[2].kind, "unknown");
});

test("lifetimes in readable units", () => {
    assert.deepEqual(lifetimeParts(2_592_000), { value: 30, unit: "days" });
    assert.deepEqual(lifetimeParts(3600), { value: 1, unit: "hours" });
    assert.deepEqual(lifetimeParts(5400), { value: 90, unit: "minutes" });
    assert.deepEqual(lifetimeParts(300), { value: 5, unit: "minutes" });
    assert.deepEqual(lifetimeParts(45), { value: 45, unit: "seconds" });
    assert.deepEqual(lifetimeParts(90_061), { value: 1, unit: "days" });
});

test("the diagram follows the sessions and the settings", () => {
    const now = Date.parse("2026-10-27T00:00:00Z");
    const list = {
        sessions: [
            row(1, MAC_CHROME, "2026-10-26T10:00:00Z", true, "2026-11-26T00:00:00Z"),
            row(2, WIN_FIREFOX, "2026-10-26T09:00:00Z"),
            row(3, WIN_FIREFOX, "2026-10-25T09:00:00Z"),
            row(4, IPHONE_SAFARI, "2026-10-24T09:00:00Z"),
            row(5, null, "2026-10-23T09:00:00Z"),
        ],
        signin_lifetime: 2_592_000,
        access_lifetime: 3600,
    };
    const d = sessionDiagram(list, now);
    assert.equal(d.current?.id, 1);
    assert.equal(d.currentLeft, 30 * 86_400);
    assert.equal(d.others, 4);
    assert.deepEqual(d.otherLabels, ["Firefox · Windows ×2", "Safari · iOS", "?"]);
    assert.equal(d.moreDevices, 0, "every other browser is named");
    assert.equal(d.renewalsPerDay, 24);
    assert.equal(d.accessSeconds, 3600);
    // 管理員看別人：沒有「這個瀏覽器」。/ An admin looking at someone else: no current browser.
    const other = sessionDiagram({ ...list, sessions: list.sessions.map((s) => ({ ...s, current: false })) }, now, 1);
    assert.equal(other.current, null);
    assert.equal(other.currentLeft, null);
    assert.equal(other.others, 5);
    assert.deepEqual(other.otherLabels, ["Chrome · macOS"]);
    assert.equal(other.moreDevices, 3);
    // 已經過期的不會變負數。/ Never negative.
    assert.equal(sessionDiagram(list, Date.parse("2027-01-01T00:00:00Z")).currentLeft, 0);
});

test("lifetimes in words", () => {
    assert.equal(formatLifetime(2_592_000, "en"), "30 days");
    assert.equal(formatLifetime(3600, "en"), "1 hour");
    assert.equal(formatLifetime(5400, "en"), "90 minutes");
});
