import { test } from "node:test";
import assert from "node:assert/strict";
import {
    baseName, bitsToMode, EMPTY_SELECTION, extensionOf, fileErrorKey, fileKeyAction, fileSpotStates, flowNow, formatBytes, imageMime,
    joinPath, languageFor, linkFromClose, modeBits, modeFromString, modeOctal, moveCursor, nextUploads, parentPath, parseMode,
    previewKind, pruneSelection, selectAll, selectOnly, selectRange, toggleSelection, uploadSummary, validName, type UploadJob,
} from "./fileManager.ts";

test("paths join and climb on unix, SFTP-style Windows and backslash Windows paths", () => {
    assert.equal(joinPath("/home/u", "a"), "/home/u/a");
    assert.equal(joinPath("/", "etc"), "/etc");
    assert.equal(joinPath("~/", "x"), "~/x");
    assert.equal(joinPath("C:\\Users", "x"), "C:\\Users\\x");
    assert.equal(joinPath("/C:/Users", "x"), "/C:/Users/x");
    assert.equal(parentPath("/home/u/a"), "/home/u");
    assert.equal(parentPath("/home"), "/");
    assert.equal(parentPath("/"), null);
    assert.equal(parentPath("~/"), null);
    assert.equal(parentPath("~/docs"), "~/");
    assert.equal(parentPath("C:\\Users\\x"), "C:\\Users");
    assert.equal(parentPath("C:\\Users"), "C:\\");
    assert.equal(parentPath("C:\\"), null);
    assert.equal(parentPath("/C:/Users"), "/C:");
    assert.equal(parentPath("/C:"), null);
    assert.equal(baseName("/a/b/c.txt"), "c.txt");
    assert.equal(baseName("C:\\x\\y\\"), "y");
    assert.ok(validName("notes.txt") && validName(".env"));
    for (const bad of ["", ".", "..", "a/b", "a\\b", "x".repeat(256)]) assert.ok(!validName(bad), bad);
});

test("extensions pick the preview and the editor language", () => {
    assert.equal(extensionOf(".bashrc"), "");
    assert.equal(extensionOf("a.tar.GZ"), "gz");
    assert.equal(languageFor("app.tsx"), "tsx");
    assert.equal(languageFor("Dockerfile"), "dockerfile");
    assert.equal(languageFor("Dockerfile.prod"), "dockerfile");
    assert.equal(languageFor(".bashrc"), "shell");
    assert.equal(languageFor(".env.local"), "ini");
    assert.equal(languageFor("nginx.conf"), "nginx");
    assert.equal(languageFor("telepy.service"), "ini");
    assert.equal(languageFor("compose.YML"), "yaml");
    assert.equal(languageFor("README"), null);
    assert.equal(imageMime("x.SVG"), "image/svg+xml");
    assert.equal(imageMime("x.txt"), null);
    assert.equal(previewKind("photo.jpg", 2_000_000), "image");
    assert.equal(previewKind("huge.png", 11 * 1024 * 1024), "download");
    assert.equal(previewKind("notes", 100), "text", "no extension = try as text, the backend checks for NUL");
    assert.equal(previewKind("app.log", 2 * 1024 * 1024), "download");
    assert.equal(previewKind("backup.tar.gz", 10), "download");
    assert.equal(previewKind("doc.pdf", 10), "download");
});

test("selection: toggle, shift ranges from the anchor, select all, prune after a relist", () => {
    const order = ["a", "b", "c", "d", "e"];
    let s = toggleSelection(EMPTY_SELECTION, "b");
    assert.deepEqual(s, { names: ["b"], anchor: "b" });
    s = selectRange(s, order, "d");
    assert.deepEqual([...s.names].sort(), ["b", "c", "d"]);
    assert.equal(s.anchor, "b", "the anchor stays for the next shift-click");
    s = selectRange(s, order, "a");
    assert.deepEqual([...s.names].sort(), ["a", "b", "c", "d"]);
    s = toggleSelection(s, "c");
    assert.ok(!s.names.includes("c"));
    assert.deepEqual(selectRange(EMPTY_SELECTION, order, "c"), selectOnly("c"), "no anchor = just that one");
    assert.deepEqual(selectAll(order).names, order);
    const pruned = pruneSelection({ names: ["a", "x"], anchor: "x" }, order);
    assert.deepEqual(pruned, { names: ["a"], anchor: null });
    const same = { names: ["a"], anchor: "a" };
    assert.equal(pruneSelection(same, order), same, "unchanged selection keeps its identity");
    assert.equal(moveCursor(order, null, 1), "a");
    assert.equal(moveCursor(order, null, -1), "e");
    assert.equal(moveCursor(order, "e", 1), "e");
    assert.equal(moveCursor([], null, 1), null);
});

test("keyboard map", () => {
    assert.equal(fileKeyAction({ key: "Enter" }), "open");
    assert.equal(fileKeyAction({ key: "Backspace" }), "up");
    assert.equal(fileKeyAction({ key: "Backspace", metaKey: true }), "delete", "⌘⌫ on a Mac");
    assert.equal(fileKeyAction({ key: "F2" }), "rename");
    assert.equal(fileKeyAction({ key: "Delete" }), "delete");
    assert.equal(fileKeyAction({ key: "a", ctrlKey: true }), "selectAll");
    assert.equal(fileKeyAction({ key: "A", metaKey: true, shiftKey: true }), "selectAll");
    assert.equal(fileKeyAction({ key: "a" }), null);
    assert.equal(fileKeyAction({ key: "Enter", ctrlKey: true }), null);
    assert.equal(fileKeyAction({ key: "ArrowDown" }), "next");
    assert.equal(fileKeyAction({ key: "Escape" }), "clear");
});

test("permission bits round-trip and keep the special bits", () => {
    assert.equal(parseMode("755"), 0o755);
    assert.equal(parseMode("0644"), 0o644);
    for (const bad of ["", "8", "rwx", "17777", "0x1"]) assert.equal(parseMode(bad), null, bad);
    assert.equal(modeOctal(0o100644), "0644");
    const bits = modeBits(0o4750);
    assert.deepEqual(bits.user, { read: true, write: true, exec: true });
    assert.deepEqual(bits.group, { read: true, write: false, exec: true });
    assert.deepEqual(bits.other, { read: false, write: false, exec: false });
    assert.equal(bitsToMode(bits, 0o4750), 0o4750);
    assert.equal(bitsToMode({ ...bits, other: { read: true, write: false, exec: false } }), 0o754);
    assert.equal(modeFromString("-rw-r--r--"), 0o644);
    assert.equal(modeFromString("drwxrwxrwt"), 0o1777);
    assert.equal(modeFromString("-rwsr-xr-x"), 0o4755);
    assert.equal(modeFromString(undefined), null);
});

test("uploads run two at a time and report progress by bytes", () => {
    const job = (id: number, state: UploadJob["state"], size = 100, loaded = 0): UploadJob => ({ id, name: `f${id}`, size, loaded, state, dir: "~/" });
    assert.deepEqual(nextUploads([job(1, "queued"), job(2, "queued"), job(3, "queued")]), [1, 2]);
    assert.deepEqual(nextUploads([job(1, "uploading"), job(2, "queued"), job(3, "queued")]), [2]);
    assert.deepEqual(nextUploads([job(1, "uploading"), job(2, "uploading"), job(3, "queued")]), []);
    assert.deepEqual(nextUploads([job(1, "done"), job(2, "failed"), job(3, "queued")]), [3]);
    const s = uploadSummary([job(1, "done", 100), job(2, "uploading", 300, 150), job(3, "failed", 100, 20)]);
    assert.deepEqual(s, { total: 3, done: 1, failed: 1, active: 1, percent: Math.round((100 + 150 + 20) / 500 * 100) });
    assert.equal(uploadSummary([job(1, "done", 0)]).percent, 100, "empty files count as complete");
    assert.equal(uploadSummary([]).percent, 0);
});

test("the diagram shows where it stopped and what is in flight", () => {
    assert.deepEqual(fileSpotStates("open", null), { browser: "ok", web: "ok", telepy: "ok", channel: "ok", account: "ok" });
    assert.deepEqual(fileSpotStates("open", { kind: "deleting", count: 3 }), { browser: "ok", web: "ok", telepy: "ok", channel: "active", account: "active" });
    assert.deepEqual(fileSpotStates("offline", null), { browser: "ok", web: "ok", telepy: "ok", channel: "failed", account: "waiting" });
    assert.deepEqual(fileSpotStates("stepup", null), { browser: "ok", web: "ok", telepy: "failed", channel: "waiting", account: "waiting" });
    assert.equal(fileSpotStates("retrying", null).web, "failed");
    assert.equal(fileSpotStates("connecting", null).web, "active");
    assert.equal(linkFromClose(4005), "offline");
    assert.equal(linkFromClose(4008), "stepup");
    assert.equal(linkFromClose(4003), "stopped");
    assert.equal(linkFromClose(1006), "retrying");
    assert.deepEqual(flowNow("open", { kind: "uploading", count: 4 }), { key: "files.flow.busy.uploading", vars: { count: 4 } });
    assert.equal(flowNow("open", null).key, "files.flow.now.idle");
    assert.equal(flowNow("offline", null).key, "files.flow.now.offline");
});

test("error codes and sizes", () => {
    assert.equal(fileErrorKey("modified"), "files.err.modified");
    assert.equal(fileErrorKey("something_new"), null);
    assert.equal(fileErrorKey(undefined), null);
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(50 * 1024 * 1024), "50 MB");
});
