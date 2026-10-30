import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addHost, applyFix, applyHostDraft, clearOption, effectChanges, fixesFor, hostTable, inheritedRow, OTHER, removeHost, renameHost, setOption, setOwnList } from "./sshConfigEdit.ts";
import { tidyConfig, type Note } from "./sshConfigTidy.ts";

const HAVE_SSH = spawnSync("ssh", ["-V"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "telepy-edit-"));
let no = 0;
/** 真的 ssh 讀這份設定時，這個名稱的某個設定。/ What the real ssh reads for one setting of one name. */
function sshGet(config: string, host: string, key: string): string[] {
    const file = join(dir, `e${no++}.conf`);
    writeFileSync(file, config);
    const out = spawnSync("ssh", ["-G", "-F", file, host], { encoding: "utf8" }).stdout;
    return out.split("\n").filter((l) => l.startsWith(key + " ")).map((l) => l.slice(key.length + 1));
}

const BASE = `Host web1
    HostName web1.example.com

Host web1 web2 db
    User deploy
    IdentityFile ~/.ssh/work

Host *
    ServerAliveInterval 60
    User nobody
`;

test("setting a value a shared block gives opens the host's own block before it; only that host changes", () => {
    const r = setOption(BASE, "web2", "User", "alice");
    assert.ok(r.text, JSON.stringify(r.error));
    assert.ok(r.text.includes("Host web2\n    User alice\n\nHost web1 web2 db"), r.text);
    const changes = effectChanges(BASE, r.text);
    assert.deepEqual(changes, [{ name: "web2", slot: "user", key: "User", before: "deploy", after: "alice" }]);
    if (HAVE_SSH) {
        assert.deepEqual(sshGet(r.text, "web2", "user"), ["alice"]);
        assert.deepEqual(sshGet(r.text, "web1", "user"), ["deploy"]);
    }
});

test("a value the host's own block gives is changed in place; an own block before the source takes new lines", () => {
    const r = setOption(BASE, "web1", "HostName", "10.0.0.1");
    assert.equal(r.text, BASE.replace("HostName web1.example.com", "HostName 10.0.0.1"));
    const p = setOption(BASE, "web1", "Port", "2222");
    assert.ok(p.text!.startsWith("Host web1\n    HostName web1.example.com\n    Port 2222\n"), p.text);
    const u = setOption(BASE, "web1", "User", "root");
    assert.ok(u.text!.startsWith("Host web1\n    HostName web1.example.com\n    User root\n"), "web1's own block is before the shared one");
    if (HAVE_SSH) assert.deepEqual(sshGet(u.text!, "web1", "user"), ["root"]);
});

test("values with spaces are quoted the way ssh reads them", () => {
    const r = setOption(BASE, "db", "IdentityFile", "~/My Keys/id");
    assert.ok(r.text!.includes('IdentityFile "~/My Keys/id"'), r.text);
    if (HAVE_SSH) assert.equal(sshGet(r.text!, "db", "identityfile")[0], "~/My Keys/id");
});

test("the global section can't be overridden for one host", () => {
    const g = "User root\n\nHost a\n    Port 22\n";
    const r = setOption(g, "a", "User", "bob");
    assert.deepEqual(r.error, { code: "global", line: 1, key: "User" });
});

test("clearing goes back to the inherited value", () => {
    const set = setOption(BASE, "web2", "User", "alice").text!;
    const r = clearOption(set, "web2", "User");
    assert.deepEqual(effectChanges(BASE, r.text!), []);
    assert.ok(!r.text!.includes("Host web2\n"), "the emptied block goes");
    assert.equal(clearOption(BASE, "web2", "User").error?.code, "not_found", "web2 has no own User line");
    assert.equal(inheritedRow(set, "web2").cells.user.value, "deploy");
});

test("own IdentityFile lines come first and keep their order", () => {
    const r = setOwnList(BASE, "web2", "IdentityFile", ["~/.ssh/a", "~/.ssh/b"]);
    const row = hostTable(r.text!).rows.find((x) => x.name === "web2")!;
    assert.deepEqual(row.stacks.identityfile.map((c) => c.value), ["~/.ssh/a", "~/.ssh/b", "~/.ssh/work"]);
    if (HAVE_SSH) assert.deepEqual(sshGet(r.text!, "web2", "identityfile"), ["~/.ssh/a", "~/.ssh/b", "~/.ssh/work"]);
});

test("a new host goes before the wildcard block so its values win", () => {
    const r = addHost(BASE, "nas", [{ key: "HostName", value: "192.168.1.5" }, { key: "User", value: "admin" }]);
    assert.ok(r.text!.includes("Host nas\n    HostName 192.168.1.5\n    User admin\n\nHost *"), r.text);
    if (HAVE_SSH) assert.deepEqual(sshGet(r.text!, "nas", "user"), ["admin"]);
    assert.equal(addHost(BASE, "web1", []).error?.code, "exists");
    assert.equal(addHost(BASE, "bad name", []).error?.code, "bad_name");
    assert.equal(addHost(BASE, "web-*", []).error?.code, "bad_name");
});

test("removing a host drops its own block and its name from shared Host lines", () => {
    const r = removeHost(BASE, "web1");
    assert.equal(r.text, "Host web2 db\n    User deploy\n    IdentityFile ~/.ssh/work\n\nHost *\n    ServerAliveInterval 60\n    User nobody\n");
    assert.deepEqual(hostTable(r.text!).rows.map((x) => x.name), ["web2", "db"]);
});

test("renaming keeps what the host reaches unless asked not to", () => {
    const text = "Host web1 web2\n    HostName %h.example.com\n    User deploy\n";
    const kept = renameHost(text, "web1", "w1");
    assert.ok(kept.text);
    assert.deepEqual(effectChanges(text, kept.text, { from: "web1", to: "w1" }), [], kept.text);
    if (HAVE_SSH) assert.deepEqual(sshGet(kept.text, "w1", "hostname"), ["web1.example.com"]);
    const plain = renameHost(text, "web1", "w1", false);
    assert.deepEqual(effectChanges(text, plain.text!, { from: "web1", to: "w1" }).map((c) => [c.slot, c.after]), [["hostname", "w1.example.com"]]);
    assert.equal(renameHost(text, "web1", "web2").error?.code, "exists");
});

test("Telepy-managed hosts can't be renamed but can be removed (shared Host line included)", () => {
    const ME = "telepy-t-1";
    const text = `# >>> telepy pi >>>\nHost pi\n    HostKeyAlias ${ME}-device-1\n    ProxyCommand ssh -W %h:%p ${ME}\n# <<< telepy pi <<<\n# >>> telepy cam >>>\nHost cam\n    ProxyCommand ssh -W %h:%p ${ME}\n# <<< telepy cam <<<\n# >>> telepy shared ${ME} >>>\nHost pi cam\n    Port 22\n# <<< telepy shared ${ME} <<<\n`;
    assert.equal(renameHost(text, "pi", "pi2").error?.code, "telepy");
    const r = removeHost(text, "pi");
    assert.ok(!r.text!.includes("telepy pi >>>") && !r.text!.includes("Host pi\n"), r.text);
    assert.ok(r.text!.includes(`# >>> telepy shared ${ME} >>>\nHost cam\n`), r.text);
    assert.ok(hostTable(text).rows.find((x) => x.name === "pi")!.telepy);
});

test("fixes: make a shadowed line apply, remove it, or ignore an unknown option", () => {
    const text = "Host *\n    ServerAliveInterval 60\n\nHost lab\n    HostName 10.0.0.9\n    ServerAliveInterval 15\n";
    const note = tidyConfig(text).notes[0] as Extract<Note, { kind: "shadowed" }>;
    assert.equal(note.kind, "shadowed");
    assert.deepEqual(fixesFor(note), ["apply", "remove"]);
    const apply = applyFix(text, note, "apply");
    assert.deepEqual(effectChanges(text, apply.text!), [{ name: "lab", slot: "serveraliveinterval", key: "ServerAliveInterval", before: "60", after: "15" }]);
    if (HAVE_SSH) assert.deepEqual(sshGet(apply.text!, "lab", "serveraliveinterval"), ["15"]);
    const remove = applyFix(text, note, "remove");
    assert.deepEqual(effectChanges(text, remove.text!), [], "removing a line that never applies changes nothing");
    // 同一個區塊裡：拿掉前面那行。/ In the same block: the earlier line goes.
    const same = "Host a\n    User one\n    User two\n";
    const n2 = tidyConfig(same).notes[0] as Note;
    assert.equal(applyFix(same, n2, "apply").text, "Host a\n    User two\n");
    // 不認得的選項：ssh 拒絕整份檔案；IgnoreUnknown 之後就讀得了。/ Unknown option: IgnoreUnknown makes ssh read it.
    const bad = "Host a\n    User x\n    FutureOption yes\n";
    const unknown = tidyConfig(bad).notes.find((x) => x.kind === "unknown")!;
    const ignored = applyFix(bad, unknown, "ignore");
    assert.equal(ignored.text, "IgnoreUnknown futureoption\n" + bad);
    if (HAVE_SSH) {
        assert.deepEqual(sshGet(bad, "a", "user"), [], "ssh refuses the file as it is");
        assert.deepEqual(sshGet(ignored.text!, "a", "user"), ["x"]);
    }
    assert.equal(applyFix(ignored.text!, tidyConfig(ignored.text!.replace("FutureOption", "OtherOption")).notes.find((x) => x.kind === "unknown")!, "ignore").text?.split("\n")[0], "IgnoreUnknown futureoption,otheroption");
});

test("the overview lists every name with where each value comes from, plus any other name", () => {
    const t = hostTable(BASE);
    assert.deepEqual(t.rows.map((r) => r.name), ["web1", "web2", "db"]);
    const web1 = t.rows[0];
    assert.equal(web1.cells.hostname.value, "web1.example.com");
    assert.equal(web1.cells.hostname.own, true);
    assert.equal(web1.cells.user.shared, true);
    assert.equal(web1.cells.user.header, "Host web1 web2 db");
    assert.equal(t.other.name, OTHER);
    assert.equal(t.other.cells.user.value, "nobody");
});

test("a form draft: set, clear, list and rename in one go", () => {
    const r = applyHostDraft(BASE, "web1", { name: "web-1", set: { User: "root", Port: "2200" }, clear: ["HostName"], lists: {} });
    assert.ok(r.text, JSON.stringify(r.error));
    const row = hostTable(r.text).rows.find((x) => x.name === "web-1")!;
    assert.equal(row.cells.user.value, "root");
    assert.equal(row.cells.port.value, "2200");
    assert.equal(row.cells.hostname, undefined, "back to ssh's default (the name)");
    const added = applyHostDraft(BASE, null, { name: "nas", set: { HostName: "10.1.1.1", User: "" }, clear: [], lists: { IdentityFile: ["~/.ssh/nas"] } });
    assert.ok(added.text!.includes("Host nas\n    HostName 10.1.1.1\n    IdentityFile ~/.ssh/nas\n"), added.text);
});
