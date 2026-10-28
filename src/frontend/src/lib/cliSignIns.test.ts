import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CLI_SIGNIN_LIMIT, grantHost, isCliGrant, overflowOnNext, splitGrants, type GrantLike } from "./cliSignIns.ts";

const g = (id: number, client_name: string, used: string | null, extra: Partial<GrantLike> = {}): GrantLike => ({ id, client_name, created_at: "2026-10-01T00:00:00Z", last_used_at: used, ...extra });

test("the backend's kind wins; older backends fall back to the CLI's registered name", () => {
    assert.equal(isCliGrant({ client_name: "Claude Code", kind: "cli" }), true);
    assert.equal(isCliGrant({ client_name: "telepy CLI (mac)", kind: "app" }), false);
    assert.equal(isCliGrant({ client_name: "telepy CLI (mac)" }), true);
    assert.equal(isCliGrant({ client_name: "Cursor" }), false);
    assert.equal(grantHost({ client_name: "telepy CLI (mac)", kind: "cli", cli_host: "mac.local" }), "mac.local");
    assert.equal(grantHost({ client_name: "telepy CLI" }), "");
    assert.equal(grantHost({ client_name: "Cursor", kind: "app" }), null);
});

test("CLI sign-ins and MCP apps are split, the most recently used sign-in first", () => {
    const list = [g(1, "Cursor", null), g(2, "telepy CLI (a)", "2026-10-05T00:00:00Z"), g(3, "telepy CLI (b)", null), g(4, "telepy CLI (c)", "2026-10-20T00:00:00Z")];
    const { cli, apps } = splitGrants(list);
    assert.deepEqual(cli.map((x) => x.id), [4, 2, 3], "never used = its sign-in time (Oct 1)");
    assert.deepEqual(apps.map((x) => x.id), [1]);
});

test("one more sign-in signs out the least recently used ones beyond the limit", () => {
    const many = Array.from({ length: 12 }, (_, i) => g(i + 1, `telepy CLI (pc${i + 1})`, `2026-10-${String(i + 10).padStart(2, "0")}T00:00:00Z`));
    assert.deepEqual(overflowOnNext(many).map((x) => x.id), [3, 2, 1], "9 most recent stay next to the new one");
    assert.deepEqual(overflowOnNext(many.slice(0, 9)), [], "nine leave room for the tenth");
    assert.deepEqual(overflowOnNext(many.slice(0, 10)).map((x) => x.id), [1]);
});

test("the limit matches the backend", () => {
    const rust = readFileSync(new URL("../../../backend-api/src/oauth/mod.rs", import.meta.url), "utf8");
    const m = /pub const MAX_CLI_SIGNINS: usize = (\d+);/.exec(rust);
    assert.ok(m, "MAX_CLI_SIGNINS in oauth/mod.rs");
    assert.equal(Number(m[1]), CLI_SIGNIN_LIMIT);
});
