import { test } from "node:test";
import assert from "node:assert/strict";
import { countAccess, deviceAccess, initialSelection, keysToAdd, pickStanzas, splitBulkConfig, type BulkConfigTunnel } from "./bulkSshConfig.ts";
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

test("keys to add are mine that are not on the list yet", () => {
    const d = dev([{ user_key_id: 9, accounts: null, targets: [] }]);
    assert.deepEqual(keysToAdd(d, [9, 10, 11]), [10, 11]);
    assert.deepEqual(keysToAdd(undefined, [9]), [9]);
});

test("counts and the first selection", () => {
    assert.deepEqual(countAccess(["ready", "ready", "missing"]), { ready: 2, installing: 0, error: 0, missing: 1, unknown: 0 });
    assert.deepEqual([...initialSelection([1, 2, 3], null)], [1, 2, 3]);
    assert.deepEqual([...initialSelection([1, 2, 3], [2, 9])], [2]);
    // 篩出來的都放不進去 → 全部 / Nothing shown is eligible → everything
    assert.deepEqual([...initialSelection([1, 2], [9])], [1, 2]);
});
