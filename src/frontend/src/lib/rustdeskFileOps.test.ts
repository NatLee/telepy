import { test } from "node:test";
import assert from "node:assert/strict";
import {
    currentOp, deleteSteps, deleteSummary, emptyDirsPath, failureSpot, fileDirId, freeName, IDLE_ACTIVITY, isExistsError, missingFiles, needsConfirm, parseEmptyDirs,
    parseRecursiveListing, planRename, planUpload, rdFileSpots, readEmptyDirsMessage, relativeTo, remoteFromRel, selectionKinds, tooLargeForMemory, transferActivity, validName, withActivity, zipPlan,
} from "./rustdeskFileOps.ts";

const listing = JSON.stringify({ id: 7, path: "/home/dev/photos", entries: [
    { entry_type: 4, name: "a.jpg", size: 100, modified_time: 1 },
    { entry_type: 4, name: "2024/trip/b.jpg", size: 50, modified_time: 2 },
    { entry_type: 0, name: "skip-dir", size: 0, modified_time: 0 },
    { entry_type: 5, name: "link.txt", size: 0, modified_time: 0 },
    { entry_type: 4, name: "../escape", size: 1, modified_time: 0 },
] });

test("recursive listings keep files only, with safe relative names", () => {
    const l = parseRecursiveListing(listing)!;
    assert.equal(l.id, 7);
    assert.deepEqual(l.files.map((f) => f.rel), ["a.jpg", "2024/trip/b.jpg", "link.txt", "escape"]);
    assert.equal(fileDirId(listing), 7);
    assert.equal(fileDirId(JSON.stringify({ path: "/", entries: [] })), 0, "plain listings have no id");
    assert.equal(parseRecursiveListing("nope"), null);
    // Windows 的名稱（核心已把 \ 換成 /）。/ Windows names arrive with forward slashes.
    assert.deepEqual(parseRecursiveListing({ id: 1, path: "C:\\Users\\me", entries: [{ entry_type: 4, name: "docs/x.txt", size: 1 }] })!.files[0].rel, "docs/x.txt");
});

test("empty folders come back as absolute paths and are made relative", () => {
    assert.equal(relativeTo("/home/dev/photos", "/home/dev/photos/old/empty"), "old/empty");
    assert.equal(relativeTo("/home/dev/photos", "/home/dev/other"), null);
    assert.equal(relativeTo("C:\\Users\\me", "C:\\Users\\me\\a\\b"), "a/b");
    const v = JSON.stringify({ path: "/home/dev/photos", empty_dirs: [{ id: 0, path: "/home/dev/photos/old/empty", entries: [] }, { path: "/elsewhere" }] });
    assert.deepEqual(parseEmptyDirs(v, "/home/dev/photos"), ["old/empty"]);
    assert.equal(emptyDirsPath(v), "/home/dev/photos");
    assert.equal(parseEmptyDirs("{}", "/"), null);
});

test("the zip plan puts everything under the folder name and counts it", () => {
    const l = parseRecursiveListing(listing)!;
    const plan = zipPlan("photos", l.files, ["old/empty"]);
    assert.equal(plan.zipName, "photos.zip");
    assert.deepEqual(plan.files.map((f) => f.name), ["photos/a.jpg", "photos/2024/trip/b.jpg", "photos/link.txt", "photos/escape"]);
    assert.deepEqual(plan.folders, ["photos", "photos/old/empty"]);
    assert.deepEqual([plan.fileCount, plan.totalBytes], [4, 151]);
    assert.equal(needsConfirm(plan), false);
    assert.equal(needsConfirm({ fileCount: 501, totalBytes: 1 }), true);
    assert.equal(needsConfirm({ fileCount: 1, totalBytes: 2 * 1024 ** 3 + 1 }), true);
    assert.equal(tooLargeForMemory({ totalBytes: 3 * 1024 ** 3 }), true);
    // 核心沒開把手的只有 0 byte 的檔案。/ Only empty files are missing after the core is done.
    assert.deepEqual(missingFiles(plan, new Set(["photos/a.jpg", "photos/2024/trip/b.jpg"])).map((f) => f.name), ["photos/link.txt"]);
});

test("relative paths become remote paths on both systems", () => {
    assert.equal(remoteFromRel("/home/dev", "a/b.txt", false), "/home/dev/a/b.txt");
    assert.equal(remoteFromRel("C:\\Users", "a/b.txt", true), "C:\\Users\\a\\b.txt");
});

test("rename: a name, a move by path, and the mistakes", () => {
    assert.deepEqual(planRename("/home/dev", "a.txt", "b.txt", false), { newName: "b.txt", target: "/home/dev/b.txt", move: false });
    assert.deepEqual(planRename("/home/dev", "a.txt", "../shared/a.txt", false), { newName: "../shared/a.txt", target: "/home/shared/a.txt", move: true });
    assert.deepEqual(planRename("/home/dev", "a.txt", "/tmp/x.txt", false), { newName: "/tmp/x.txt", target: "/tmp/x.txt", move: true });
    assert.deepEqual(planRename("C:\\Users\\me", "a.txt", "..\\b.txt", true), { newName: "..\\b.txt", target: "C:\\Users\\b.txt", move: true });
    assert.equal(planRename("/home/dev", "a.txt", "  ", false), "empty");
    assert.equal(planRename("/home/dev", "a.txt", "a.txt", false), "same");
    assert.equal(planRename("/home/dev", "a.txt", "./a.txt", false), "same");
    assert.equal(planRename("/home/dev", "a.txt", "..", false), "dots");
    assert.equal(planRename("/home/dev", "a.txt", "dir/", false), "trailing");
    assert.equal(validName("New folder"), true);
    assert.equal(validName("a/b"), false);
    assert.equal(validName(".."), false);
    assert.equal(freeName("New folder", ["new folder", "New folder (2)"]), "New folder (3)");
    assert.equal(freeName("x", []), "x");
});

test("delete: the confirmation counts, and a folder is every file then the emptied tree", () => {
    const items = [
        { name: "photos", path: "/home/dev/photos", isDir: true, size: 0, files: parseRecursiveListing(listing)!.files },
        { name: "x.log", path: "/home/dev/x.log", isDir: false, size: 9 },
    ];
    assert.deepEqual(deleteSummary(items), { folders: 1, files: 1, inside: 4, bytes: 160 });
    const steps = deleteSteps(items[0], false);
    assert.equal(steps.length, 5);
    assert.deepEqual(steps[1], { op: "remove_file", path: "/home/dev/photos/2024/trip/b.jpg", fileNum: 1 });
    assert.deepEqual(steps[4], { op: "remove_all_empty_dirs", path: "/home/dev/photos" });
    assert.deepEqual(deleteSteps(items[1], false), [{ op: "remove_file", path: "/home/dev/x.log", fileNum: 0 }]);
    const entries = [{ name: "photos", isDir: true }, { name: "x.log", isDir: false }, { name: "y", isDir: false }] as never[];
    assert.deepEqual(selectionKinds(entries, new Set(["photos", "y"])), { folders: 1, files: 1 });
});

test("a folder upload creates every folder first, parents before children", () => {
    const f = (name: string) => ({ name }) as File;
    const plan = planUpload("/home/dev", [
        { file: f("b.txt"), rel: "proj/src/b.txt" },
        { file: f("a.txt"), rel: "proj/a.txt" },
        { file: f("solo.txt"), rel: "" },
    ], ["proj/empty/deeper"], false);
    assert.deepEqual(plan.dirs, ["/home/dev/proj", "/home/dev/proj/empty", "/home/dev/proj/src", "/home/dev/proj/empty/deeper"]);
    assert.deepEqual(plan.files.map((x) => x.to), ["/home/dev/proj/src/b.txt", "/home/dev/proj/a.txt", "/home/dev/solo.txt"]);
    assert.deepEqual(planUpload("C:\\", [{ file: f("x"), rel: "d/x" }], [], true).files[0].to, "C:\\d\\x");
    assert.equal(isExistsError("File exists (os error 17)"), true);
    assert.equal(isExistsError("Permission denied (os error 13)"), false);
});

test("the ReadEmptyDirs message is Message.file_action(17).read_empty_dirs(11)", () => {
    assert.deepEqual([...readEmptyDirsMessage("/a", true)], [0x8a, 0x01, 8, 0x5a, 6, 0x0a, 2, 0x2f, 0x61, 0x10, 1]);
    assert.deepEqual([...readEmptyDirsMessage("/a", false)].slice(0, 3), [0x8a, 0x01, 6]);
});

test("activity: the action in flight and the latest result per kind", () => {
    let a = withActivity(IDLE_ACTIVITY, "download", "running");
    assert.equal(currentOp(a), "download");
    a = withActivity(a, "delete", "running");
    assert.equal(currentOp(a), "delete", "a delete outranks a download");
    a = withActivity(withActivity(a, "delete", "failed"), "download", "done");
    assert.equal(currentOp(a), null);
    assert.equal(withActivity(a, "download", "done"), a, "unchanged state keeps the object");
    assert.equal(transferActivity([{ kind: "upload", state: "done" }, { kind: "upload", state: "running" }], "upload"), "running");
    assert.equal(transferActivity([{ kind: "download", state: "failed" }], "download"), "failed");
    assert.equal(transferActivity([], "download"), "idle");
});

test("the diagram lights the path for the action and marks where a failure stopped", () => {
    const ready = rdFileSpots("ready", null, null);
    assert.deepEqual([ready.rustdesk, ready.disk], ["ok", "waiting"]);
    const busy = rdFileSpots("ready", "delete", null);
    assert.deepEqual([busy.browser, busy.relay, busy.disk], ["ok", "active", "active"]);
    assert.equal(rdFileSpots("failed", null, "desktop.files.err.refused").relay, "failed");
    assert.equal(rdFileSpots("failed", null, "desktop.err.rdPassword").rustdesk, "failed");
    assert.equal(failureSpot("desktop.err.rdCore"), "browser");
    assert.equal(rdFileSpots("connecting", null, null).rustdesk, "active");
});
