import { test } from "node:test";
import assert from "node:assert/strict";
import {
    BUILTIN_DEFAULTS,
    envBackedKeys,
    envBool,
    groupServerKeys,
    initialKey,
    isLocked,
    isServerKey,
    layerStates,
    parseEnvMap,
    settingSource,
} from "./settingSource.ts";

const raw = {
    client_ip_hops: { var: "TRUSTED_PROXY_HOPS", set: true, value: "auto" },
    server_public_url: { var: "PUBLIC_URL", set: false, value: null },
    server_device_probe: { var: "DEVICE_PROBE", set: true, value: "false" },
    broken: { set: true, value: "x" },
    odd: "nope",
};

test("the env map is read safely", () => {
    const env = parseEnvMap(raw);
    assert.deepEqual(Object.keys(env).sort(), ["client_ip_hops", "server_device_probe", "server_public_url"]);
    assert.deepEqual(env.client_ip_hops, { var: "TRUSTED_PROXY_HOPS", set: true, value: "auto" });
    assert.equal(env.server_public_url.value, null);
    // 沒設時就算後端給了值也不採用。/ A value without set is ignored.
    assert.equal(parseEnvMap({ k: { var: "K", set: false, value: "leak" } }).k.value, null);
    assert.deepEqual(parseEnvMap(undefined), {}, "an older backend has no env map");
    assert.deepEqual(parseEnvMap([1, 2]), {});
});

test("only keys set in .env are locked", () => {
    const env = parseEnvMap(raw);
    assert.equal(isLocked(env, "client_ip_hops"), true);
    assert.equal(isLocked(env, "server_public_url"), false);
    assert.equal(isLocked(env, "allow_registration"), false);
    assert.equal(isLocked({}, "client_ip_hops"), false, "older backend: nothing locked");
});

test("env switches read like the backend", () => {
    for (const on of ["1", "true", "TRUE", "yes", "on", " On "]) assert.equal(envBool(on), true, on);
    for (const off of ["0", "false", "no", "off", "", null, undefined, "maybe"]) assert.equal(envBool(off), false, String(off));
});

test("the deciding layer: .env, then the page, then the default", () => {
    const env = parseEnvMap(raw);
    const hops = settingSource(env.client_ip_hops, "3", "auto");
    assert.equal(hops.layer, "env");
    assert.equal(hops.value, "auto");
    assert.equal(hops.locked, true);
    assert.deepEqual(layerStates(hops), { env: "decides", page: "overridden", default: "overridden" });

    // .env 關掉的開關：轉成布林。/ An env switch turned off is a boolean.
    const probe = settingSource(env.server_device_probe, true, true);
    assert.equal(probe.layer, "env");
    assert.equal(probe.value, false);
    assert.deepEqual(layerStates(probe), { env: "decides", page: "notSet", default: "overridden" }, "page equals the default = not set");

    const url = settingSource(env.server_public_url, "https://telepy.example", "");
    assert.equal(url.layer, "page");
    assert.equal(url.value, "https://telepy.example");
    assert.deepEqual(layerStates(url), { env: "notSet", page: "decides", default: "overridden" });

    const def = settingSource(env.server_public_url, "", "");
    assert.equal(def.layer, "default");
    assert.deepEqual(layerStates(def), { env: "notSet", page: "notSet", default: "decides" });

    // 舊後端（沒有 env）：頁面 / 預設，不鎖。/ Older backend: page / default, never locked.
    const old = settingSource(undefined, false, BUILTIN_DEFAULTS.server_openapi_enabled);
    assert.equal(old.layer, "page");
    assert.equal(old.locked, false);
    assert.equal(settingSource(undefined, true, true).layer, "default");
    // 沒有預設可比：有存值 = 頁面。/ No default to compare with: a saved value = page.
    assert.equal(settingSource(undefined, "x", undefined).layer, "page");
    assert.equal(settingSource(undefined, "", undefined).layer, "default");
});

test("server keys are grouped in display order", () => {
    assert.equal(isServerKey("client_ip_hops"), true);
    assert.equal(isServerKey("server_log_level"), true);
    assert.equal(isServerKey("signin_lifetime"), false);
    const groups = groupServerKeys(["server_public_url", "client_ip_cloudflare", "client_ip_hops", "server_new_thing", "allow_registration"]);
    assert.deepEqual(groups, [
        { id: "visitor", keys: ["client_ip_hops", "client_ip_cloudflare"] },
        { id: "signin", keys: ["server_public_url", "server_new_thing"] },
    ]);
});

test("the dialog lists keys in tab order and opens on the right one", () => {
    const env = parseEnvMap(raw);
    assert.deepEqual(envBackedKeys(env), ["client_ip_hops", "server_device_probe", "server_public_url"]);
    assert.equal(initialKey(env, "server_public_url"), "server_public_url");
    assert.equal(initialKey(env, "nope"), "client_ip_hops", "first locked");
    assert.equal(initialKey(parseEnvMap({ server_public_url: { var: "PUBLIC_URL", set: false } })), "server_public_url");
    assert.equal(initialKey({}), null);
});
