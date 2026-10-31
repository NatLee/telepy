import { test } from "node:test";
import assert from "node:assert/strict";
import { carrierLabel, compatNoServerAlive, factChips, joinCommands, scriptProgress, SCRIPT_STEPS } from "./joinScript.ts";

test("command variants carry the token once and the download forms check syntax first", () => {
    const c = joinCommands("https://t.example/api/join/install.sh", "tpj_abc", { sudo: true, transport: "ssh" });
    assert.equal(c.pipe, "curl -fsSL 'https://t.example/api/join/install.sh' | sudo sh -s -- --token tpj_abc");
    assert.equal(c.download, "curl -fsSL 'https://t.example/api/join/install.sh' -o /tmp/telepy-join.sh && sh -n /tmp/telepy-join.sh && sudo sh /tmp/telepy-join.sh --token tpj_abc");
    assert.equal(c.wget, "wget -O /tmp/telepy-join.sh 'https://t.example/api/join/install.sh' && sh -n /tmp/telepy-join.sh && sudo sh /tmp/telepy-join.sh --token tpj_abc");
    assert.ok(!c.check.includes("tpj_abc") && c.check.endsWith("--check"), "the preflight never carries the token");
    const noSudo = joinCommands("http://x/api/join/install.sh", "tpj_x", { sudo: false, transport: "websocket" });
    assert.ok(!noSudo.pipe.includes("sudo") && noSudo.pipe.endsWith("--token tpj_x --via-web"));
    assert.ok(noSudo.checkWget.startsWith("wget -O /tmp/telepy-join.sh") && noSudo.checkWget.endsWith("sh /tmp/telepy-join.sh --check"));
    const auto = joinCommands("https://t.example/api/join/install.sh", "tpj_a", { sudo: true, transport: "auto" });
    assert.ok(auto.pipe.endsWith("--token tpj_a --auto") && auto.download.endsWith("--token tpj_a --auto"), auto.pipe);
});

test("the script's seven steps follow the ticket phase", () => {
    assert.equal(SCRIPT_STEPS.length, 7);
    assert.deepEqual(scriptProgress("waiting", false), { current: 1, done: false, failed: false, now: "join.flow.now.waiting" });
    assert.equal(scriptProgress("waiting", false, true).current, 0, "an expired command lights nothing");
    assert.equal(scriptProgress("registered", true).current, 5, "registration is step 4; the device is on step 5 (authorize)");
    assert.equal(scriptProgress("connected", true).current, 7, "the tunnel is up: the login check is running");
    assert.deepEqual(scriptProgress("verified", true), { current: 8, done: true, failed: false, now: "join.flow.now.verified" });
    assert.deepEqual(scriptProgress("failed", true), { current: 7, done: false, failed: true, now: "join.flow.now.failedLogin" });
    assert.deepEqual(scriptProgress("failed", false), { current: 4, done: false, failed: true, now: "join.flow.now.failedRegister" });
});

test("facts become chips, compat mode is detected", () => {
    assert.deepEqual(factChips(null), []);
    const chips = factChips({ shell: "ash (BusyBox v1.36.1)", client: "dbclient 2022.82", server: "Dropbear 2022.82", init: "procd", keepalive: "ssh (-K 30)", http: "uclient-fetch" });
    assert.deepEqual(chips.map((c) => `${c.key}=${c.value}`), ["client=dbclient 2022.82", "server=Dropbear 2022.82", "init=procd", "shell=ash (BusyBox v1.36.1)", "keepalive=ssh (-K 30)"]);
    assert.equal(factChips({ init: "loop" })[0].value, "reconnect loop");
    // 小幫手：預編的寫成 telepy-carrier (target)，python3 照樣，none 不列。/ The helper chip: prebuilt as telepy-carrier (target), python3 as is, none hidden.
    assert.equal(carrierLabel("binary x86_64-unknown-linux-musl"), "telepy-carrier (x86_64-unknown-linux-musl)");
    assert.equal(carrierLabel("python3"), "python3");
    assert.equal(carrierLabel("none"), undefined);
    assert.deepEqual(factChips({ carrier: "none" }), []);
    assert.equal(factChips({ carrier: "python3" })[0].label, "join.facts.carrier");
    assert.ok(compatNoServerAlive({ compat: ["no_server_alive"] }));
    assert.ok(!compatNoServerAlive({ compat: [] }) && !compatNoServerAlive(undefined));
});
