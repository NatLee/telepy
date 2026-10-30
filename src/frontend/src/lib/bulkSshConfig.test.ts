import { test } from "node:test";
import assert from "node:assert/strict";
import { countAccess, deviceAccess, firstAccount, initialSelection, keyPlan, pickParam, pickStanzas, planIsEmpty, planKeyCount, reachInList, reachOnDevice, splitBulkConfig, toggleAccount, untouchedAccounts, type BulkConfigTunnel } from "./bulkSshConfig.ts";
import type { KeyDevice } from "../types/keys.ts";

const CONFIG = `# ===
# Reverse Server Configuration
Host telepy-ssh-server
    HostName telepy.example
    User telepy

# Endpoint Configuration
Host nas-admin
    HostName nas
    User admin
Host nas-backup
    HostName nas
    User backup
Host pi
    HostName pi
    User root
`;
const tunnels: BulkConfigTunnel[] = [
    { id: 2, name: "nas", reverse_port: 1, usernames: [], hosts: [{ alias: "nas-admin", username: "admin", username_id: 5 }, { alias: "nas-backup", username: "backup", username_id: 6 }] },
    { id: 1, name: "pi", reverse_port: 2, usernames: [], hosts: [{ alias: "pi", username: "root", username_id: 3 }] },
];
const server = { alias: "telepy-ssh-server", host: "telepy.example", port: "22" };

test("the config splits into the server stanza and each device's stanzas", () => {
    const split = splitBulkConfig({ config: CONFIG, server, tunnels });
    assert.equal(split.server?.alias, "telepy-ssh-server");
    assert.deepEqual(split.byTunnel.get(2)?.map((s) => s.alias), ["nas-admin", "nas-backup"]);
    assert.deepEqual(split.byTunnel.get(1)?.map((s) => s.alias), ["pi"]);
    // 清單順序，只有勾的 / List order, ticked only
    assert.deepEqual(pickStanzas(split, [2, 1], new Set([1, 2])).map((s) => s.alias), ["nas-admin", "nas-backup", "pi"]);
    assert.deepEqual(pickStanzas(split, [2, 1], new Set([1])).map((s) => s.alias), ["pi"]);
    assert.deepEqual(pickStanzas(split, [2, 1], new Set()), []);
});

const dev = (keys: KeyDevice["keys"]): KeyDevice => ({
    tunnel_id: 2,
    host_friendly_name: "nas",
    online: true,
    role: "owner",
    accounts: ["admin", "backup"],
    account_list: [{ id: 5, username: "admin" }, { id: 6, username: "backup" }],
    keys,
});

test("access looks only at the accounts the config uses", () => {
    const installedAdmin = dev([{ user_key_id: 9, accounts: [5], targets: [{ username: "admin", status: "installed", error: null }] }]);
    assert.equal(deviceAccess(installedAdmin, ["admin"]), "ready");
    // backup 不在這把金鑰選的帳號裡 → missing / backup is not among the key's chosen accounts
    assert.equal(deviceAccess(installedAdmin, ["admin", "backup"]), "missing");
    const everywhere = dev([{ user_key_id: 9, accounts: null, targets: [{ username: "admin", status: "installed", error: null }] }]);
    // 列表涵蓋 backup 但還沒讀到 → 在裝 / Covered but not read yet → on its way
    assert.equal(deviceAccess(everywhere, ["admin", "backup"]), "installing");
    const failed = dev([{ user_key_id: 9, accounts: null, targets: [{ username: "admin", status: "error", error: "x" }, { username: "backup", status: "installed", error: null }] }]);
    assert.equal(deviceAccess(failed, ["admin", "backup"]), "error");
    const viaGroup = dev([{ user_key_id: 9, accounts: null, direct: false, groups: [{ id: 1, name: "g", tunnel_group: null, accounts: ["backup"] }], targets: [] }]);
    assert.equal(deviceAccess(viaGroup, ["backup"]), "installing");
    // 群組只給 backup：admin 沒涵蓋 / The group grants backup only
    assert.equal(deviceAccess(viaGroup, ["admin"]), "missing");
    assert.equal(deviceAccess(dev([]), ["admin"]), "missing");
    assert.equal(deviceAccess(undefined, ["admin"]), "unknown");
});

const admin = { username: "admin", username_id: 5 };
const backup = { username: "backup", username_id: 6 };

test("adding my keys only reaches the accounts the config uses", () => {
    // 沒在清單上：一次加進來，只裝到 config 的帳號，不是每個能用的帳號 / Not listed: added, limited to the config's accounts
    const none = keyPlan(reachOnDevice(dev([])), [9, 10], [admin]);
    assert.deepEqual(none.add, [9, 10]);
    assert.deepEqual(none.addAccounts, [5]);
    assert.deepEqual(none.widen, []);
    assert.deepEqual(none.accounts, [{ id: 5, username: "admin" }]);
    assert.equal(planKeyCount(none), 2);

    // 直接在清單上只有 admin，config 也要 backup：加寬成兩個，不重加 / Listed for admin only, the config wants backup too: widen
    const narrow = dev([{ user_key_id: 9, accounts: [5], targets: [] }]);
    const widen = keyPlan(reachOnDevice(narrow), [9], [admin, backup]);
    assert.deepEqual(widen.add, []);
    assert.deepEqual(widen.widen, [{ keyId: 9, accounts: [5, 6] }]);
    assert.deepEqual(widen.accounts, [{ id: 6, username: "backup" }], "admin already has it");

    // 已經涵蓋（全部帳號或剛好這些）就什麼都不做 / Already covered → nothing to do
    assert.ok(planIsEmpty(keyPlan(reachOnDevice(dev([{ user_key_id: 9, accounts: null, targets: [] }])), [9], [admin, backup])));
    assert.ok(planIsEmpty(keyPlan(reachOnDevice(narrow), [9], [admin])));

    // 經由群組到 backup：config 要 admin 時直接加一筆（群組的不動）/ Through a group for backup: a direct entry for admin
    const viaGroup = dev([{ user_key_id: 9, accounts: null, direct: false, groups: [{ id: 1, name: "g", tunnel_group: null, accounts: ["backup"] }], targets: [] }]);
    assert.ok(planIsEmpty(keyPlan(reachOnDevice(viaGroup), [9], [backup])));
    const viaPlan = keyPlan(reachOnDevice(viaGroup), [9], [admin, backup]);
    assert.deepEqual(viaPlan.add, [9]);
    assert.deepEqual(viaPlan.accounts, [{ id: 5, username: "admin" }]);

    // 沒有帳號 = 沒事做 / No accounts = nothing to do
    assert.ok(planIsEmpty(keyPlan([], [9], [])));
});

test("the single device's my_keys read the same way, and the accounts left alone", () => {
    const reach = reachInList([
        { id: 9, name: "a", fingerprint: null, key_type: null, in_list: true, accounts: [6] },
        { id: 10, name: "b", fingerprint: null, key_type: null, in_list: false, accounts: null, via_groups: [{ id: 1, name: "g", tunnel_group: null, accounts: null }] },
        { id: 11, name: "c", fingerprint: null, key_type: null, in_list: false, accounts: null },
    ]);
    const plan = keyPlan(reach, [9, 10, 11], [admin]);
    assert.deepEqual(plan.widen, [{ keyId: 9, accounts: [5, 6] }]);
    assert.deepEqual(plan.add, [11], "key 10 already reaches every account through its group");
    assert.deepEqual(untouchedAccounts(["root", "admin", "backup"], ["admin"]), ["root", "backup"]);
});

test("counts and the first selection", () => {
    assert.deepEqual(countAccess(["ready", "ready", "missing"]), { ready: 2, installing: 0, error: 0, missing: 1, unknown: 0 });
    assert.deepEqual([...initialSelection([1, 2, 3], null)], [1, 2, 3]);
    assert.deepEqual([...initialSelection([1, 2, 3], [2, 9])], [2]);
    // 篩出來的都放不進去 → 全部 / Nothing shown is eligible → everything
    assert.deepEqual([...initialSelection([1, 2], [9])], [1, 2]);
});

test("account picks: toggle in list order, never empty, and the pick parameter", () => {
    const order = [5, 6, 7];
    assert.deepEqual(toggleAccount([7], 5, order), [5, 7]);
    assert.deepEqual(toggleAccount([5, 7], 5, order), [7]);
    assert.deepEqual(toggleAccount([7], 7, order), [7], "the last one stays");
    assert.deepEqual(firstAccount([5, 6], 6), [6]);
    assert.deepEqual(firstAccount([5, 6], 9), [5], "a default I can't use falls back to the first");
    assert.deepEqual(firstAccount([], 6), []);
    assert.equal(pickParam({ 13: [7], 2: [5, 6], 4: [] }), "2:5.6,13:7");
    assert.equal(pickParam({}), "");
});
