import { test } from "node:test";
import assert from "node:assert/strict";
import { foldersToCreate, hideKnownParts, hoursLeft, isPartFileName, localIdentity, MAX_RETRIES, newUploadId, PART_SIZE, partOutcome, partQuery, partRange, resumable, retryDelay, safeRel, sameLocalFile, topName, uploadClashes } from "./uploadParts.ts";

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

test("a changed device copy or a different local file starts over; a name clash keeps the upload", () => {
    assert.deepEqual(partOutcome(409, { code: "upload_mismatch" }), { kind: "fresh" });
    assert.deepEqual(partOutcome(409, { code: "exists", kept: true, error: "x" }), { kind: "fail", code: "exists", error: "x", kept: true });
    assert.deepEqual(partOutcome(409, { code: "upload_taken" }), { kind: "fail", code: "upload_taken", error: null });
});

test("only files above one part try to resume, and only the same local file matches", () => {
    assert.equal(resumable(PART_SIZE), false);
    assert.equal(resumable(PART_SIZE + 1), true);
    const file = { name: "a.iso", size: 9, lastModified: 1700000000123.4 };
    assert.deepEqual(localIdentity(file), { name: "a.iso", modified: 1700000000123 });
    const row = { local_name: "a.iso", local_modified: 1700000000123, total: 9 };
    assert.ok(sameLocalFile(file, row));
    assert.ok(!sameLocalFile({ ...file, size: 10 }, row), "another size");
    assert.ok(!sameLocalFile({ ...file, lastModified: 1 }, row), "changed since");
    assert.ok(!sameLocalFile({ ...file, name: "b.iso" }, row), "another file");
    assert.ok(!sameLocalFile(file, { ...row, local_name: null }), "no identity recorded");
});

test("part files the ledger knows are hidden, others stay visible", () => {
    assert.ok(isPartFileName(".a b.iso.telepy-upload-abcd1234.part"));
    assert.ok(!isPartFileName("a.telepy-upload-abcd1234.part"), "not hidden");
    assert.ok(!isPartFileName(".a.telepy-upload-ab.part"), "id too short");
    const items = [{ name: "a.iso" }, { name: ".a.iso.telepy-upload-abcd1234.part" }, { name: ".b.iso.telepy-upload-zzzz9999.part" }];
    assert.deepEqual(hideKnownParts(items, [{ part_name: ".a.iso.telepy-upload-abcd1234.part" }]).map((i) => i.name), ["a.iso", ".b.iso.telepy-upload-zzzz9999.part"]);
    assert.equal(hoursLeft(0), 1);
    assert.equal(hoursLeft(23 * 3600 + 1), 24);
});
