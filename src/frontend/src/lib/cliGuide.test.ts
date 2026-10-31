import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { firstOpenStep } from "./stepTabs.ts";
import {
    CLI_COMMANDS,
    CLI_TOPICS,
    archesFor,
    archiveName,
    cliHost,
    cliLanes,
    cliRecipes,
    cliTarget,
    detectPlatform,
    downloadUrl,
    filterCommands,
    HIDDEN_COMMAND,
    revealsHidden,
    githubActions,
    doctorSample,
    signInSample,
    installCommand,
    shq,
    startSteps,
    CLI_START_STEPS,
    verifyCommand,
    type CliContext,
} from "./cliGuide.ts";

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
const LINUX_ARM_UA = "Mozilla/5.0 (X11; Linux aarch64; rv:140.0) Gecko/20100101 Firefox/140.0";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

test("the release targets match the workflow's matrix", () => {
    // 網頁連的檔名必須是 workflow 真的會掛上去的。/ The page must link to files the workflow attaches.
    const workflow = readFileSync(new URL("../../../../.github/workflows/release-cli.yml", import.meta.url), "utf8");
    // carrier_only 的列只編 telepy-carrier（路由器用），不是 CLI 的下載。/ carrier_only rows build only telepy-carrier, not CLI downloads.
    const targets = [...workflow.matchAll(/target: ([a-z0-9_-]+)([^\n]*)/g)].filter((m) => !m[2].includes("carrier_only: true")).map((m) => m[1]);
    const ours = (["macos", "linux", "windows"] as const).flatMap((os) => archesFor(os).map((arch) => cliTarget({ os, arch })));
    assert.deepEqual([...ours].sort(), [...new Set(targets)].sort());
    assert.match(workflow, /pack src\/cli telepy telepy-\$\{\{ matrix\.target \}\}/, "archive names carry no version");
});

test("archive names and the latest-download URL", () => {
    assert.equal(archiveName({ os: "macos", arch: "arm64" }), "telepy-aarch64-apple-darwin.tar.gz");
    assert.equal(archiveName({ os: "linux", arch: "x86_64" }), "telepy-x86_64-unknown-linux-musl.tar.gz");
    assert.equal(archiveName({ os: "windows", arch: "x86_64" }), "telepy-x86_64-pc-windows-msvc.zip");
    assert.equal(downloadUrl({ os: "linux", arch: "arm64" }), "https://github.com/NatLee/telepy/releases/latest/download/telepy-aarch64-unknown-linux-musl.tar.gz");
    assert.deepEqual(archesFor("windows"), ["x86_64"]);
});

test("install commands: one paste, ends with the version", () => {
    const mac = installCommand({ os: "macos", arch: "arm64" });
    assert.equal(mac.language, "bash");
    assert.match(mac.value, /^curl -fsSL \S+telepy-aarch64-apple-darwin\.tar\.gz \| tar xz telepy$/m);
    assert.match(mac.value, /sudo mkdir -p \/usr\/local\/bin/);
    assert.match(mac.value, /telepy --version$/);
    const win = installCommand({ os: "windows", arch: "x86_64" });
    assert.equal(win.language, "powershell");
    assert.match(win.value, /Expand-Archive/);
    assert.match(win.value, /-notcontains \$dir/, "PATH is only extended once");
    assert.match(win.value, /\$env:LOCALAPPDATA\\telepy/);
    assert.match(verifyCommand({ os: "linux", arch: "x86_64" }).value, /\| sha256sum -c$/);
    assert.match(verifyCommand({ os: "macos", arch: "arm64" }).value, /\| shasum -a 256 -c$/);
    assert.match(verifyCommand({ os: "windows", arch: "x86_64" }).value, /Get-FileHash .* -eq /);
});

test("platform detection", () => {
    assert.deepEqual(detectPlatform({ userAgent: WIN_UA }), { os: "windows", arch: "x86_64", sure: true });
    // Safari 不說架構：先當 Apple silicon，但不確定。/ Safari doesn't tell: assume Apple silicon, not sure.
    assert.deepEqual(detectPlatform({ userAgent: MAC_UA, platform: "MacIntel" }), { os: "macos", arch: "arm64", sure: false });
    assert.deepEqual(detectPlatform({ userAgent: MAC_UA, architecture: "x86" }), { os: "macos", arch: "x86_64", sure: true });
    assert.deepEqual(detectPlatform({ userAgent: MAC_UA, architecture: "arm" }), { os: "macos", arch: "arm64", sure: true });
    assert.deepEqual(detectPlatform({ userAgent: LINUX_UA }), { os: "linux", arch: "x86_64", sure: true });
    assert.deepEqual(detectPlatform({ userAgent: LINUX_ARM_UA }), { os: "linux", arch: "arm64", sure: true });
    assert.deepEqual(detectPlatform({ userAgent: "Mozilla/5.0 (X11; Linux) Something" }), { os: "linux", arch: "x86_64", sure: false });
    assert.equal(detectPlatform({ userAgent: IPHONE_UA }).sure, false, "a phone is not where the CLI goes");
    assert.equal(detectPlatform({ userAgent: "" }).sure, false);
});

test("the CLI's sign-ins are recognised under Connected apps", () => {
    assert.equal(cliHost("telepy CLI (mac-studio.local)"), "mac-studio.local");
    assert.equal(cliHost("telepy CLI"), "");
    assert.equal(cliHost("Claude Desktop"), null);
    assert.equal(cliHost("my telepy CLI (x)"), null);
    assert.equal(cliHost(null), null);
});

test("shell quoting", () => {
    assert.equal(shq("box"), "box");
    assert.equal(shq("env=prod"), "env=prod");
    assert.equal(shq("box@pi"), "box@pi");
    assert.equal(shq("My lab"), "'My lab'");
    assert.equal(shq("it's"), `'it'\\''s'`);
    assert.equal(shq("$(rm -rf /)"), "'$(rm -rf /)'");
});

const FULL: CliContext = {
    base: "https://telepy.example.com",
    tunnel: "box",
    account: "pi",
    other: "nas",
    label: "env=prod",
    group: "Home lab",
    snippet: { name: "restart service", vars: ["svc"] },
};
const EMPTY: CliContext = { base: "", tunnel: null, account: null, other: null, label: null, group: null, snippet: null };

test("examples use the person's own names, quoted", () => {
    const all = CLI_TOPICS.flatMap((topic) => cliRecipes(topic, FULL));
    const cmd = (id: string) => all.find((r) => r.id === id)!.command.value;
    assert.equal(cmd("ssh"), "telepy ssh box");
    assert.equal(cmd("sshAccount"), "telepy ssh box@pi -- uname -a");
    assert.equal(cmd("execTwo"), "telepy exec box nas -- df -h /");
    assert.equal(cmd("execGroup"), "telepy exec --group 'Home lab' -- free -h");
    assert.equal(cmd("run"), "telepy run 'restart service' box --var svc=…");
    assert.match(cmd("ciActions"), /TELEPY_URL: https:\/\/telepy\.example\.com/);
    assert.ok(all.every((r) => !r.placeholder), "nothing is a placeholder when everything is known");
    // 每個範例都有自己的翻譯 key。/ Every example has its own keys.
    const ids = all.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const r of all) {
        assert.equal(r.title, `cli.ex.${r.id}`);
        assert.equal(r.note, `cli.ex.${r.id}Note`);
    }
});

test("without data the examples show placeholders and say so", () => {
    const everyday = cliRecipes("everyday", EMPTY);
    assert.equal(everyday.find((r) => r.id === "ssh")!.command.value, "telepy ssh <tunnel>");
    assert.equal(everyday.find((r) => r.id === "sshAccount")!.command.value, "telepy ssh <tunnel>@<account> -- uname -a");
    assert.equal(everyday.find((r) => r.id === "ssh")!.placeholder, true);
    assert.equal(everyday.find((r) => r.id === "ls")!.placeholder, false, "ls needs nothing of yours");
    // 只有一個帳號：寫隧道名就好，但那個例子要說明 @account 是佔位。/ One account: just the tunnel name.
    const oneAccount = cliRecipes("everyday", { ...FULL, account: null });
    assert.equal(oneAccount.find((r) => r.id === "sshAccount")!.command.value, "telepy ssh box -- uname -a");
    assert.equal(oneAccount.find((r) => r.id === "sshAccount")!.placeholder, true);
    assert.equal(cliRecipes("toolbox", { ...FULL, snippet: { name: "df", vars: [] } })[1].command.value, "telepy run df box");
});

test("what each example needs", () => {
    const needs = (topic: (typeof CLI_TOPICS)[number], id: string) => cliRecipes(topic, FULL).find((r) => r.id === id)!.needs;
    assert.ok(needs("everyday", "ssh").includes("ssh-key"), "ssh goes through OpenSSH with your key");
    assert.deepEqual(needs("files", "cpUp"), ["ssh:files"]);
    assert.deepEqual(needs("sessions", "sessionsEnd"), ["tunnels:manage"], "only an API token has tunnels:manage");
    assert.deepEqual(needs("network", "browse"), ["browser:use"]);
});

test("the GitHub Actions example keeps the expression for the secret", () => {
    const yaml = githubActions("https://t.example", "role=web");
    assert.match(yaml, /TELEPY_TOKEN: \$\{\{ secrets\.TELEPY_TOKEN \}\}/);
    assert.match(yaml, /telepy-x86_64-unknown-linux-musl\.tar\.gz \| tar xz -C "\$RUNNER_TEMP" telepy/);
    assert.match(yaml, /--label role=web/);
});

test("command search matches the command and its text", () => {
    const describe = (c: { key: string }) => (c.key === "exec" ? "Run a command on many devices" : "");
    assert.equal(filterCommands(CLI_COMMANDS, "", describe).length, CLI_COMMANDS.length);
    assert.deepEqual(filterCommands(CLI_COMMANDS, "many devices", describe).map((c) => c.key), ["exec"]);
    assert.deepEqual(filterCommands(CLI_COMMANDS, "SFTP", describe).map((c) => c.key), ["sftp"]);
    assert.deepEqual(filterCommands(CLI_COMMANDS, "zzz", describe), []);
});

test("every command the page lists is a real subcommand", () => {
    const lib = readFileSync(new URL("../../../cli/src/lib.rs", import.meta.url), "utf8");
    const block = lib.slice(lib.indexOf("pub enum Cmd {"), lib.indexOf("}", lib.indexOf("pub enum Cmd {")));
    const variants = [...block.matchAll(/^\s{4}([A-Z][a-z]+)/gm)].map((m) => m[1].toLowerCase());
    const listed = CLI_COMMANDS.map((c) => c.usage.split(" ")[0]);
    // 隱藏的指令不列。/ Hidden commands are not listed.
    const hidden = [...block.matchAll(/#\[command\(hide = true\)\]\s*\n\s*([A-Z][a-z]+)/g)].map((m) => m[1].toLowerCase());
    assert.deepEqual(listed.sort(), variants.filter((v) => !hidden.includes(v)).sort());
});

test("getting-started steps", () => {
    assert.deepEqual(startSteps(0), { install: "todo", signIn: "todo", try: "todo" });
    assert.deepEqual(startSteps(2), { install: "done", signIn: "done", try: "todo" });
    // 打開在第一個沒打勾的：還沒登入 → 安裝；登入過 → 試試看。/ Opens on the first unticked step.
    const open = (n: number) => firstOpenStep(CLI_START_STEPS.map((value) => ({ value, state: startSteps(n)[value] })));
    assert.equal(open(0), "install");
    assert.equal(open(1), "try");
});

test("the hidden command only shows up when searched for by name", () => {
    assert.equal(revealsHidden("dig"), true);
    assert.equal(revealsHidden("  telepy dig "), true);
    assert.equal(revealsHidden("DIG"), true);
    assert.equal(revealsHidden("di"), false);
    assert.equal(revealsHidden("digest"), false);
    assert.ok(!CLI_COMMANDS.some((c) => c.key === HIDDEN_COMMAND.key), "never in the list itself");
    const lib = readFileSync(new URL("../../../cli/src/lib.rs", import.meta.url), "utf8");
    assert.match(lib, /#\[command\(hide = true\)\]\s*\n\s*Dig,/, "still a hidden subcommand of the CLI");
});

test("the output previews are what the CLI really prints", () => {
    const lib = readFileSync(new URL("../../../cli/src/lib.rs", import.meta.url), "utf8");
    const oauth = readFileSync(new URL("../../../cli/src/oauth.rs", import.meta.url), "utf8");
    assert.ok(oauth.includes("Opening Telepy in your browser to approve the CLI. If nothing opens, visit:"));
    assert.ok(lib.includes('"Signed in to {server} as {} (credentials in the {}).'));
    assert.ok(lib.includes('"system keyring" } else { "config file" }'));
    assert.ok(lib.includes('"Everything looks good."'));
    for (const what of ["server", "sign-in", "scopes", "ssh config dir"]) assert.ok(lib.includes(`"${what}"`), what);
    const login = signInSample("https://t.example", "alice", "macos");
    assert.equal(login.at(-1)!.text, "Signed in to https://t.example as alice (credentials in the system keyring).");
    assert.match(signInSample("https://t.example", "alice", "linux").at(-1)!.text, /config file/);
    const doctor = doctorSample("https://t.example", "alice", "macos");
    assert.equal(doctor[0].text, "telepy doctor");
    assert.ok(doctor.slice(1, -1).every((l) => l.text.startsWith("✓ ")));
});

test("the diagram's lanes follow the sign-in and the personal keys", () => {
    assert.deepEqual(cliLanes(false, null).rest, { you: "ok", credential: "waiting", telepy: "waiting", tunnel: "waiting", device: "waiting" });
    assert.equal(cliLanes(true, 2).rest.device, "ok");
    assert.equal(cliLanes(true, 0).ssh.credential, "failed", "no key: ssh stops at the key");
    assert.equal(cliLanes(true, 0).ssh.device, "waiting");
    assert.equal(cliLanes(false, 3).ssh.device, "ok", "the ssh lane is the login itself: your key, not the sign-in");
    assert.equal(cliLanes(true, null).ssh.credential, "waiting");
});
