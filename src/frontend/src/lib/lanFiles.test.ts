import { test } from "node:test";
import assert from "node:assert/strict";
import { authLabel, lanFilesErrorKey, needsPassword, offerPassword, openBody, showDetail } from "./lanFiles.ts";
import { linkFromClose, lanSpotStates } from "./fileManager.ts";

test("the open request follows the login method", () => {
    assert.deepEqual(openBody({ kind: "telepy" }, " admin ", "ubuntu"), { login: "admin", account: "ubuntu", auth: "telepy" });
    assert.deepEqual(openBody({ kind: "prompt" }, "pi", null, "s3cret"), { login: "pi", auth: "password", password: "s3cret" });
    assert.deepEqual(openBody({ kind: "credential", id: 7 }, "backup", "root"), { login: "backup", account: "root", auth: "credential", credential_id: 7 });
    assert.equal(needsPassword({ kind: "prompt" }), true);
    assert.equal(needsPassword({ kind: "telepy" }), false);
});

test("a refused key offers a password, a refused password doesn't", () => {
    assert.equal(offerPassword("lan_files_login", { kind: "telepy" }), true);
    assert.equal(offerPassword("lan_files_login", { kind: "credential", id: 1 }), true);
    assert.equal(offerPassword("lan_files_login", { kind: "prompt" }), false);
    assert.equal(offerPassword("lan_files_no_sftp", { kind: "telepy" }), false);
});

test("error codes have their own words, unknown ones show the backend's", () => {
    assert.equal(lanFilesErrorKey("lan_files_no_sftp"), "lanFiles.err.noSftp");
    assert.equal(lanFilesErrorKey("nope"), null);
    assert.equal(showDetail("lan_files_failed"), true, "which host and why");
    assert.equal(showDetail("lan_password"), false);
    assert.equal(showDetail("nope"), true);
});

test("a closed LAN session stops at the hop", () => {
    assert.equal(linkFromClose(4017), "lanGone");
    const s = lanSpotStates("lanGone", null);
    assert.deepEqual([s.browser, s.telepy, s.device, s.hop, s.host], ["ok", "ok", "ok", "failed", "waiting"]);
    const offline = lanSpotStates("offline", null);
    assert.equal(offline.tunnel, "failed");
    const busy = lanSpotStates("open", { kind: "uploading", count: 2 });
    assert.deepEqual([busy.device, busy.hop, busy.host], ["ok", "active", "active"]);
});

test("the backend's login words are translated", () => {
    assert.deepEqual(authLabel("Telepy's key"), { key: "lanAuth.telepy" });
    assert.deepEqual(authLabel("a password"), { key: "lanFiles.authPassword" });
    assert.deepEqual(authLabel("saved login 'nas backup'"), { key: "lanAuth.savedOption", vars: { name: "nas backup" } });
    assert.equal(authLabel("something new"), null);
});
