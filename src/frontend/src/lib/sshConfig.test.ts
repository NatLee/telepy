import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCommand, markedBlocks, parseStanzas, removeCommand, type ConfigShell, type ConfigStanza } from "./sshConfig.ts";

// 伺服器區塊叫 telepy-<網域>-<port>（= 它的 HostKeyAlias）。/ The server stanza is telepy-<domain>-<port> (= its HostKeyAlias).
const ME = "telepy-telepy.example-24242";
const LEGACY = { alias: "telepy-ssh-server", me: ME };
const server = (host: string, alias = ME): ConfigStanza => ({ alias, options: [{ key: "HostName", value: host }, { key: "HostKeyAlias", value: alias }] });
const device = (alias: string, via = ME): ConfigStanza => ({ alias, options: [{ key: "HostName", value: alias }, { key: "ProxyCommand", value: `ssh -W %h:%p ${via}` }] });
/** 舊版寫進去的：共用別名的伺服器區塊（HostKeyAlias = 那台）與跳它的裝置區塊。/ What older versions wrote. */
const legacyServer = (hostKeyAlias = ME) => `# >>> telepy telepy-ssh-server >>>\nHost telepy-ssh-server\n    HostName telepy.example\n    HostKeyAlias ${hostKeyAlias}\n# <<< telepy telepy-ssh-server <<<\n`;
const legacyDevice = (alias: string) => `# >>> telepy ${alias} >>>\nHost ${alias}\n    ProxyCommand ssh -W %h:%p telepy-ssh-server\n# <<< telepy ${alias} <<<\n`;

/** 在暫存的 HOME 跑 POSIX 指令（絕不碰真的 ~/.ssh）。/ Run a POSIX command in a scratch HOME (never the real ~/.ssh). */
function fakeHome(config: string | null) {
    const home = mkdtempSync(join(tmpdir(), "telepy-sshconfig-"));
    mkdirSync(join(home, ".ssh"));
    if (config !== null) writeFileSync(join(home, ".ssh", "config"), config);
    return {
        run: (command: string) => execFileSync("/bin/sh", ["-c", command], { env: { ...process.env, HOME: home } }),
        home,
        config: () => readFileSync(join(home, ".ssh", "config"), "utf8"),
        knownHosts: () => readFileSync(join(home, ".ssh", "telepy_known_hosts"), "utf8"),
        writeKnownHosts: (text: string) => writeFileSync(join(home, ".ssh", "telepy_known_hosts"), text),
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
    assert.deepEqual(hosts(h.config()), ["github.com", "pi", ME, "nas"]);
    // 同一台再跑一次：換掉，不重複 / The same device again replaces, never duplicates
    h.run(installCommand("posix", [server("telepy.example"), device("pi")]));
    assert.deepEqual(hosts(h.config()), ["github.com", "nas", ME, "pi"]);
    assert.ok(h.config().startsWith("Host github.com\n    User git\n"), h.config());
    assert.deepEqual(hosts(h.backup()), ["github.com", "pi", ME, "nas"]);
});

test("a bulk install replaces what single installs wrote", () => {
    const h = fakeHome(null);
    h.run(installCommand("posix", [server("telepy.example"), device("pi")]));
    h.run(installCommand("posix", [server("telepy.example"), device("pi"), device("nas"), device("cam")]));
    assert.deepEqual(hosts(h.config()), [ME, "pi", "nas", "cam"]);
});

test("an unterminated block and other people's markers are left alone", () => {
    const broken = "# >>> telepy pi >>>\nHost pi\n    HostName old\n";
    const foreign = "# >>> telepy other >>>\nHost other\n# <<< telepy other <<<\n";
    const h = fakeHome(broken + "Host keep\n    User me\n" + foreign);
    h.run(installCommand("posix", [server("telepy.example"), device("pi")]));
    const text = h.config();
    assert.ok(text.startsWith(broken + "Host keep\n    User me\n" + foreign), text);
    assert.deepEqual(hosts(text), ["pi", "keep", "other", ME, "pi"]);
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
    assert.deepEqual(hosts(h.config()), [ME, "nas"]);
});

test("markedBlocks wraps every stanza", () => {
    assert.equal(markedBlocks([device("pi")]), `# >>> telepy pi >>>\nHost pi\n    HostName pi\n    ProxyCommand ssh -W %h:%p ${ME}\n# <<< telepy pi <<<\n`);
});

// ---------------------------------------------------------------- 各伺服器分開 / one block per Telepy server

const KEYS = `${ME} ssh-ed25519 AAAAnew\n`;

test("two Telepy servers keep their own server blocks and known_hosts lines", () => {
    const h = fakeHome(null);
    const other = "telepy-other.example-2222";
    h.writeKnownHosts(`${other} ssh-ed25519 AAAAother\n${ME} ssh-ed25519 AAAAold\n`);
    h.run(installCommand("posix", [server("other.example", other), device("cam", other)], `${other} ssh-ed25519 AAAAother\n`));
    h.run(installCommand("posix", [server("telepy.example"), device("pi")], KEYS));
    assert.deepEqual(hosts(h.config()), [other, "cam", ME, "pi"]);
    // 只換掉這台的那行（舊金鑰不留），別台的留著 / Only this server's line is replaced; the other server's stays
    assert.equal(h.knownHosts(), `${other} ssh-ed25519 AAAAother\n${ME} ssh-ed25519 AAAAnew\n`);
    h.run(installCommand("posix", [server("telepy.example"), device("pi")], KEYS));
    assert.equal(h.knownHosts(), `${other} ssh-ed25519 AAAAother\n${ME} ssh-ed25519 AAAAnew\n`, "re-running adds nothing");
});

test("the old shared server block goes once nothing uses it, and only if it is this server's", () => {
    // pi 換成新的區塊，沒有人再跳 telepy-ssh-server → 舊區塊拿掉 / pi re-added, nothing jumps through it → removed
    let h = fakeHome("Host github.com\n" + legacyServer() + legacyDevice("pi"));
    h.run(installCommand("posix", [server("telepy.example"), device("pi")], KEYS, null, LEGACY));
    assert.deepEqual(hosts(h.config()), ["github.com", ME, "pi"]);
    // cam 還沒重裝、還指著它 → 留著；之後 cam 也重裝 → 拿掉 / cam still uses it → kept, until cam is re-added too
    h = fakeHome(legacyServer() + legacyDevice("pi") + legacyDevice("cam"));
    h.run(installCommand("posix", [server("telepy.example"), device("pi")], KEYS, null, LEGACY));
    assert.deepEqual(hosts(h.config()), ["telepy-ssh-server", "cam", ME, "pi"]);
    h.run(installCommand("posix", [server("telepy.example"), device("cam")], KEYS, null, LEGACY));
    assert.deepEqual(hosts(h.config()), ["pi", ME, "cam"]);
    // 別台 Telepy 的舊區塊（HostKeyAlias 不同）→ 不碰；它的 cam 也是別台的，同名偵測讓它留著
    // Another server's old block → untouched; its cam is that server's too, so same-name detection keeps it
    h = fakeHome(legacyServer("telepy-other.example-2222") + legacyDevice("cam"));
    h.run(installCommand("posix", [server("telepy.example"), device("cam")], KEYS, null, LEGACY));
    assert.deepEqual(hosts(h.config()), ["telepy-ssh-server", "cam", ME]);
    // 沒有結尾標記 → 不碰 / Unterminated → untouched
    const open = "# >>> telepy telepy-ssh-server >>>\nHost telepy-ssh-server\n    HostKeyAlias " + ME + "\n";
    h = fakeHome(open);
    h.run(installCommand("posix", [server("telepy.example"), device("pi")], KEYS, null, LEGACY));
    assert.ok(h.config().startsWith(open), h.config());
});

// PowerShell：有 PWSH（pwsh 的路徑）時才跑；路徑的 \ 換成 /（.NET 在非 Windows 不認 \）。
// PowerShell: runs only with PWSH set to a pwsh binary; path backslashes become / (.NET off Windows ignores \).
const PWSH = process.env.PWSH;
function runShell(shell: ConfigShell, h: ReturnType<typeof fakeHome>, command: string) {
    if (shell === "posix") return h.run(command);
    const script = command.replace(/\$HOME\\\.ssh\\/g, "$HOME/.ssh/").replace(/\$HOME\\\.ssh"/g, '$HOME/.ssh"');
    const file = join(h.home, "run.ps1");
    writeFileSync(file, script);
    execFileSync(PWSH!, ["-NoProfile", "-NonInteractive", "-File", file], { env: { ...process.env, HOME: h.home } });
}

for (const shell of ["posix", "powershell"] as ConfigShell[]) {
    test(`${shell}: install, known_hosts merge and the old block, end to end`, { skip: shell === "powershell" && !PWSH ? "set PWSH to run" : false }, () => {
        const other = "telepy-other.example-2222";
        const h = fakeHome("Host github.com\n    User git\n" + legacyServer() + legacyDevice("pi") + legacyDevice("cam"));
        h.writeKnownHosts(`${other} ssh-ed25519 AAAAother\n${ME} ssh-ed25519 AAAAold\n`);
        runShell(shell, h, installCommand(shell, [server("telepy.example"), device("pi")], KEYS, null, LEGACY));
        assert.deepEqual(hosts(h.config()), ["github.com", "telepy-ssh-server", "cam", ME, "pi"], "cam still uses the old block");
        assert.deepEqual(h.knownHosts().trim().split("\n"), [`${other} ssh-ed25519 AAAAother`, `${ME} ssh-ed25519 AAAAnew`]);
        runShell(shell, h, installCommand(shell, [server("telepy.example"), device("pi"), device("cam")], KEYS, null, LEGACY));
        assert.deepEqual(hosts(h.config()), ["github.com", ME, "pi", "cam"], "no one uses the old block any more");
        assert.ok(h.config().startsWith("Host github.com\n    User git\n"), h.config());
        runShell(shell, h, removeCommand(shell, ["cam"]));
        assert.deepEqual(hosts(h.config()), ["github.com", ME, "pi"]);
    });
}

// ---------------------------------------------------------------- 同名偵測 / same-name detection

/** 跑一次、回 stderr（失敗就讓測試失敗）。/ Run once and return stderr (a failure fails the test). */
function runWithStderr(shell: ConfigShell, h: ReturnType<typeof fakeHome>, command: string): string {
    if (shell === "posix") {
        const r = spawnSync("/bin/sh", ["-c", command], { env: { ...process.env, HOME: h.home }, encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
        return r.stderr;
    }
    const script = command.replace(/\$HOME\\\.ssh\\/g, "$HOME/.ssh/").replace(/\$HOME\\\.ssh"/g, '$HOME/.ssh"');
    const file = join(h.home, "run.ps1");
    writeFileSync(file, script);
    const r = spawnSync(PWSH!, ["-NoProfile", "-NonInteractive", "-File", file], { env: { ...process.env, HOME: h.home }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return r.stderr + r.stdout;
}

for (const shell of ["posix", "powershell"] as ConfigShell[]) {
    test(`${shell}: a device another Telepy server already named is kept, and the command says so`, { skip: shell === "powershell" && !PWSH ? "set PWSH to run" : false }, () => {
        const other = "telepy-other.example-2222";
        const start = markedBlocks([server("other.example", other), device("pi", other), device("cam")]) + "Host nas\n    User me\n";
        const h = fakeHome(start);
        const out = runWithStderr(shell, h, installCommand(shell, [server("telepy.example"), device("pi"), device("cam"), device("nas")], KEYS, null, LEGACY));
        const text = h.config();
        // pi 還是別台的；cam 換成新的（沒有重複）；nas 加上了，但手寫的 Host nas 在前面 / pi stays the other server's
        assert.deepEqual(hosts(text), [other, "pi", "nas", ME, "cam", "nas"]);
        assert.ok(text.includes(`ProxyCommand ssh -W %h:%p ${other}`), text);
        assert.equal(text.match(/^Host pi$/gm)?.length, 1);
        assert.match(out, /did not overwrite pi/);
        assert.match(out, /own Host nas outside the Telepy blocks/);
        // 再跑一次：一樣保留，不會越加越多 / Running again keeps it the same
        runWithStderr(shell, h, installCommand(shell, [server("telepy.example"), device("pi"), device("cam"), device("nas")], KEYS, null, LEGACY));
        assert.deepEqual(hosts(h.config()), [other, "pi", "nas", ME, "cam", "nas"]);
    });

    test(`${shell}: old shared-alias blocks count as ours unless the shared block is another server's`, { skip: shell === "powershell" && !PWSH ? "set PWSH to run" : false }, () => {
        // 共用伺服器區塊是別台的 → pi 是別台的，保留 / The shared block is another server's → pi is theirs
        let h = fakeHome(legacyServer("telepy-other.example-2222") + legacyDevice("pi"));
        let out = runWithStderr(shell, h, installCommand(shell, [server("telepy.example"), device("pi")], KEYS, null, LEGACY));
        assert.match(out, /did not overwrite pi/);
        assert.deepEqual(hosts(h.config()), ["telepy-ssh-server", "pi", ME]);
        // 是這台的 → 換掉，舊區塊沒人用了也清掉 / Ours → replaced, and the unused old block goes
        h = fakeHome(legacyServer() + legacyDevice("pi"));
        out = runWithStderr(shell, h, installCommand(shell, [server("telepy.example"), device("pi")], KEYS, null, LEGACY));
        assert.doesNotMatch(out, /did not overwrite/);
        assert.deepEqual(hosts(h.config()), [ME, "pi"]);
    });
}
