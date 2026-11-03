import { test } from "node:test";
import assert from "node:assert/strict";
import { foldersToCreate, MAX_RETRIES, newUploadId, PART_SIZE, partOutcome, partQuery, partRange, retryDelay, safeRel, topName, uploadClashes } from "./uploadParts.ts";

test("upload ids are what the backend accepts", () => {
    const id = newUploadId();
    assert.match(id, /^[a-z0-9]{16}$/);
    assert.equal(newUploadId(() => new Uint8Array(16)), "a".repeat(16));
});

test("only transient failures are resent, with growing waits", () => {
    for (const s of [0, 408, 429, 502, 503, 504, 520, 522, 524]) assert.equal(typeof retryDelay(s, 0), "number", String(s));
    for (const s of [400, 401, 403, 404, 409, 413, 500]) assert.equal(retryDelay(s, 0), null, String(s));
    assert.ok((retryDelay(502, 3) ?? 0) > (retryDelay(502, 0) ?? 0));
    assert.equal(retryDelay(502, MAX_RETRIES), null, "gives up");
});

test("the part query carries only the flags that are on", () => {
    const q = new URLSearchParams(partQuery({ path: "~/a b/照片.jpg", upload: "abcd1234", offset: 0, total: 9, overwrite: false, parents: true, retry: false }));
    assert.equal(q.get("path"), "~/a b/照片.jpg");
    assert.equal(q.get("parents"), "1");
    assert.equal(q.get("overwrite"), null);
    assert.equal(q.get("total"), "9");
});

test("answers decide the next step", () => {
    assert.deepEqual(partOutcome(200, { received: 8, done: false }), { kind: "next", offset: 8 });
    assert.deepEqual(partOutcome(200, { received: 9, done: true, path: "/h/x" }), { kind: "done", path: "/h/x" });
    assert.deepEqual(partOutcome(409, { code: "upload_offset", received: 4 }), { kind: "next", offset: 4 });
    assert.deepEqual(partOutcome(409, { code: "upload_gone" }), { kind: "restart" });
    assert.deepEqual(partOutcome(409, { code: "exists", error: "x exists" }), { kind: "fail", code: "exists", error: "x exists" });
    assert.deepEqual(partOutcome(502, null), { kind: "fail", code: null, error: null });
});

test("parts cover the file, an empty file is one empty part", () => {
    assert.deepEqual(partRange(0, 0), [0, 0]);
    assert.deepEqual(partRange(0, PART_SIZE + 1), [0, PART_SIZE]);
    assert.deepEqual(partRange(PART_SIZE, PART_SIZE + 1), [PART_SIZE, PART_SIZE + 1]);
});

test("relative paths can't climb out", () => {
    assert.equal(safeRel("../../etc/passwd"), "etc/passwd");
    assert.equal(safeRel("/a//b/./c"), "a/b/c");
    assert.equal(safeRel("a\\b"), "a/b");
    assert.equal(topName("photos/2024/a.jpg"), "photos");
});

test("clashes: same-name files are replaced, same-name folders are merged into", () => {
    const existing = [
        { name: "a.txt", dir: false },
        { name: "photos", dir: true },
        { name: "notes", dir: false },
    ];
    assert.deepEqual(uploadClashes(["a.txt", "b.txt", "photos/x.jpg", "photos/y/z.jpg", "notes/n.txt", "other/k"], existing), { files: ["a.txt"], folders: ["photos"] });
});

test("empty folders are created parents first", () => {
    assert.deepEqual(foldersToCreate(["a/b/c", "a/d", "x"]), ["a", "x", "a/b", "a/d", "a/b/c"]);
});
