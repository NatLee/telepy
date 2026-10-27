import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCommand, markedBlocks, parseStanzas, removeCommand, type ConfigStanza } from "./sshConfig.ts";

const server = (host: string): ConfigStanza => ({ alias: "telepy-ssh-server", options: [{ key: "HostName", value: host }] });
const device = (alias: string): ConfigStanza => ({ alias, options: [{ key: "HostName", value: alias }, { key: "ProxyCommand", value: "ssh -W %h:%p telepy-ssh-server" }] });

/** 在暫存的 HOME 跑 POSIX 指令（絕不碰真的 ~/.ssh）。/ Run a POSIX command in a scratch HOME (never the real ~/.ssh). */
function fakeHome(config: string | null) {
    const home = mkdtempSync(join(tmpdir(), "telepy-sshconfig-"));
    mkdirSync(join(home, ".ssh"));
    if (config !== null) writeFileSync(join(home, ".ssh", "config"), config);
    return {
        run: (command: string) => execFileSync("/bin/sh", ["-c", command], { env: { ...process.env, HOME: home } }),
        config: () => readFileSync(join(home, ".ssh", "config"), "utf8"),
        backup: () => readFileSync(join(home, ".ssh", "config.bak"), "utf8"),
    };
}

const hosts = (text: string) => parseStanzas(text).map((s) => s.alias);

test("parseStanzas drops comments and blank lines", () => {
    const text = "# banner\nHost a\n    HostName  a.example\n\nHost b\n    User   root\n";
    assert.deepEqual(parseStanzas(text), [
        { alias: "a", options: [{ key: "HostName", value: "a.example" }] },
        { alias: "b", options: [{ key: "User", value: "root" }] },
    ]);
});

test("installing device after device keeps one server block and every device", () => {
    const h = fakeHome("Host github.com\n    User git\n");
    h.run(installCommand("posix", [server("telepy.example"), device("pi")]));
    h.run(installCommand("posix", [server("telepy.example"), device("nas")]));
    assert.deepEqual(hosts(h.config()), ["github.com", "pi", "telepy-ssh-server", "nas"]);
    // 同一台再跑一次：換掉，不重複 / The same device again replaces, never duplicates
    h.run(installCommand("posix", [server("telepy.example"), device("pi")]));
    assert.deepEqual(hosts(h.config()), ["github.com", "nas", "telepy-ssh-server", "pi"]);
    assert.ok(h.config().startsWith("Host github.com\n    User git\n"), h.config());
    assert.deepEqual(hosts(h.backup()), ["github.com", "pi", "telepy-ssh-server", "nas"]);
});

test("a bulk install replaces what single installs wrote", () => {
    const h = fakeHome(null);
    h.run(installCommand("posix", [server("telepy.example"), device("pi")]));
    h.run(installCommand("posix", [server("telepy.example"), device("pi"), device("nas"), device("cam")]));
    assert.deepEqual(hosts(h.config()), ["telepy-ssh-server", "pi", "nas", "cam"]);
});

test("an unterminated block and other people's markers are left alone", () => {
    const broken = "# >>> telepy pi >>>\nHost pi\n    HostName old\n";
    const foreign = "# >>> telepy other >>>\nHost other\n# <<< telepy other <<<\n";
    const h = fakeHome(broken + "Host keep\n    User me\n" + foreign);
    h.run(installCommand("posix", [server("telepy.example"), device("pi")]));
    const text = h.config();
    assert.ok(text.startsWith(broken + "Host keep\n    User me\n" + foreign), text);
    assert.deepEqual(hosts(text), ["pi", "keep", "other", "telepy-ssh-server", "pi"]);
});

test("a close marker must name the block it closes", () => {
    const h = fakeHome("# >>> telepy pi >>>\nHost pi\n# <<< telepy nas <<<\nHost keep\n");
    h.run(installCommand("posix", [server("x"), device("pi"), device("nas")]));
    assert.ok(h.config().startsWith("# >>> telepy pi >>>\nHost pi\n# <<< telepy nas <<<\nHost keep\n"), h.config());
});

test("hundreds of devices in one command", () => {
    const many = Array.from({ length: 400 }, (_, i) => device(`device-${i}.lab`));
    const h = fakeHome("Host github.com\n");
    h.run(installCommand("posix", [server("telepy.example"), ...many]));
    h.run(installCommand("posix", [server("telepy.example"), ...many]));
    const got = hosts(h.config());
    assert.equal(got.length, 402);
    assert.equal(new Set(got).size, 402);
});

test("removeCommand removes only the given aliases", () => {
    const h = fakeHome(null);
    h.run(installCommand("posix", [server("telepy.example"), device("pi"), device("nas")]));
    h.run(removeCommand("posix", ["pi"]));
    assert.deepEqual(hosts(h.config()), ["telepy-ssh-server", "nas"]);
});

test("markedBlocks wraps every stanza", () => {
    assert.equal(markedBlocks([device("pi")]), "# >>> telepy pi >>>\nHost pi\n    HostName pi\n    ProxyCommand ssh -W %h:%p telepy-ssh-server\n# <<< telepy pi <<<\n");
});
