import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CLIPBOARD_VALUES, clipboardAllowed, clipboardWithin, isClipboardPolicy, isWslKernel, rdpSecurityLabel, sessionFailure, soundAvailable, startFailure } from "./desktop.ts";

test("the site limit caps the user's clipboard choice like the backend does", () => {
    assert.equal(clipboardWithin("both", "both"), "both");
    assert.equal(clipboardWithin("both", "to_remote"), "to_remote");
    assert.equal(clipboardWithin("both", "off"), "off");
    assert.equal(clipboardWithin("to_remote", "both"), "to_remote");
    assert.equal(clipboardWithin("to_remote", "off"), "off");
    assert.equal(clipboardWithin("off", "both"), "off");
    // 上限以下的選項都能選，以上的關掉。/ Choices at or under the limit stay enabled.
    assert.deepEqual(CLIPBOARD_VALUES.filter((v) => clipboardAllowed(v, "to_remote")), ["to_remote", "off"]);
    assert.deepEqual(CLIPBOARD_VALUES.filter((v) => clipboardAllowed(v, "off")), ["off"]);
    assert.ok(isClipboardPolicy("to_remote") && !isClipboardPolicy("sideways") && !isClipboardPolicy(null));
});

test("a refused port explains Direct IP Access in RustDesk mode", () => {
    const vars = { account: "natlee", address: "127.0.0.1:21118" };
    assert.equal(startFailure("target_unreachable", 502, vars, "rustdesk").key, "desktop.err.rdDirectIpOff");
    assert.equal(startFailure("target_unreachable", 502, vars, "rdp").key, "desktop.err.targetUnreachable");
    assert.equal(startFailure("target_unreachable", 502, vars).key, "desktop.err.targetUnreachable", "RDP / VNC wording by default");
    assert.deepEqual(startFailure("target_unreachable", 502, vars, "rustdesk").vars, { address: "127.0.0.1:21118" });
    assert.equal(startFailure("device_auth", 502, vars, "rustdesk").key, "desktop.err.deviceAuth", "other codes are the same in every mode");
});

test("a sign-out elsewhere (4010) and an ended session (4009) get their own explanation", () => {
    assert.equal(sessionFailure(4010)?.key, "desktop.err.signedOut");
    assert.equal(sessionFailure(4009)?.key, "desktop.err.stopped");
    assert.deepEqual([soundAvailable("rdp"), soundAvailable("vnc"), soundAvailable("rustdesk")], [true, false, true]);
});

test("the RDP pre-flight's refusals say what answered, and WSL devices get the hint", () => {
    const at = { account: "natlee", address: "hd-notebook:3389" };
    const none = startFailure("rdp_no_answer", 502, at, "rdp", { wsl: false });
    assert.equal(none.key, "desktop.err.rdpNoAnswer");
    assert.equal(none.vars?.address, "hd-notebook:3389");
    assert.equal(none.at, "target");
    assert.equal(none.hint, undefined);
    assert.equal(startFailure("rdp_no_answer", 502, at, "rdp", { wsl: true }).hint?.key, "desktop.err.wslHint");
    assert.equal(startFailure("rdp_silent", 502, at).key, "desktop.err.rdpSilent");
    assert.equal(startFailure("rdp_not_rdp", 502, at, "rdp", { seen: "ssh" }).key, "desktop.err.seen.ssh");
    assert.equal(startFailure("rdp_not_rdp", 502, at, "rdp", { seen: "http" }).key, "desktop.err.seen.http");
    assert.equal(startFailure("rdp_not_rdp", 502, at, "rdp", { seen: "binary" }).key, "desktop.err.seen.other");
    assert.equal(startFailure("rdp_not_rdp", 502, at).key, "desktop.err.seen.other", "an older answer without seen");
});

test("a guacd 'no answer' after a passing pre-flight is a handshake problem, not a missing server", () => {
    assert.equal(sessionFailure(0x0207)?.key, "desktop.err.noAnswer");
    const handshake = sessionFailure(0x0207, "Server refused connection (wrong security type?)", { security: "nla_ex", failure: null });
    assert.equal(handshake?.key, "desktop.err.rdpHandshake");
    assert.equal(handshake?.vars?.security, "NLA");
    const refused = sessionFailure(0x0207, undefined, { security: "rdp", failure: "ssl_not_allowed_by_server" });
    assert.deepEqual([refused?.key, refused?.vars?.reason], ["desktop.err.rdpRefusedSecurity", "ssl_not_allowed_by_server"]);
    assert.equal(rdpSecurityLabel("tls"), "TLS");
});

test("WSL kernels are recognised like the backend recognises them", () => {
    assert.ok(isWslKernel("Linux 6.18.33.2-microsoft-standard-WSL2"));
    assert.ok(isWslKernel("Linux 4.4.0-19041-Microsoft"));
    assert.ok(!isWslKernel("Linux 6.8.0-45-generic"));
    assert.ok(!isWslKernel(null));
    // 跟 Rust 的 is_wsl 同一條規則（同樣三個子字串）。/ The same rule as Rust's is_wsl (the same three substrings).
    const rs = readFileSync(new URL("../../../backend-api/src/desktop/rdp_probe.rs", import.meta.url), "utf8");
    for (const needle of ['contains("microsoft-standard-wsl")', 'ends_with("-microsoft")', 'contains("-microsoft ")']) assert.ok(rs.includes(needle), needle);
});
