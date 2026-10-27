import { test } from "node:test";
import assert from "node:assert/strict";
import { AsyncQueue, collectZip, uniqueEntry, ZipCollector, zipDirectoryHandle, zipEntryName, ZipTooLarge } from "./zipStream.ts";

/** 讀 zip 的中央目錄：名稱 → 內容（client-zip 不壓縮）。/ Read the central directory: name → content (stored). */
async function unzip(blob: Blob): Promise<Map<string, string>> {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    const out = new Map<string, string>();
    const dec = new TextDecoder();
    for (let i = 0; i + 46 <= buf.length; i += 1) {
        if (dv.getUint32(i, true) !== 0x02014b50) continue;
        const size = dv.getUint32(i + 20, true);
        const nameLen = dv.getUint16(i + 28, true);
        const local = dv.getUint32(i + 42, true);
        const name = dec.decode(buf.subarray(i + 46, i + 46 + nameLen));
        const lName = dv.getUint16(local + 26, true);
        const lExtra = dv.getUint16(local + 28, true);
        const start = local + 30 + lName + lExtra;
        out.set(name, dec.decode(buf.subarray(start, start + size)));
    }
    return out;
}

test("entry names stay inside the zip", () => {
    assert.equal(zipEntryName(["photos", "2024\\trip/a.jpg"]), "photos/2024/trip/a.jpg");
    assert.equal(zipEntryName(["/etc", "../../passwd"]), "etc/passwd");
    assert.equal(zipEntryName([".", ""]), "");
});

test("duplicate names get a counter before the extension", () => {
    const taken = new Set(["a/b.txt", "a/b (2).txt", "a/README"]);
    assert.equal(uniqueEntry("a/b.txt", taken), "a/b (3).txt");
    assert.equal(uniqueEntry("a/README", taken), "a/README (2)");
    assert.equal(uniqueEntry("a/new.txt", taken), "a/new.txt");
});

test("the queue hands items to a waiting reader and ends", async () => {
    const q = new AsyncQueue<number>();
    const got: number[] = [];
    const reading = (async () => { for await (const n of q) got.push(n); })();
    q.push(1);
    q.push(2);
    q.end();
    await reading;
    assert.deepEqual(got, [1, 2]);
    const f = new AsyncQueue<number>();
    const p = f.next();
    f.fail(new Error("stop"));
    await assert.rejects(p, /stop/);
});

test("files written through the look-alike directory handle land in the zip, folders and empty files too", async () => {
    const zip = new ZipCollector();
    const opened: string[] = [];
    zip.onFile = (i, name) => opened.push(`${i}:${name}`);
    const root = zipDirectoryHandle(zip, "photos");
    const blob = collectZip(zip.stream, 10 * 1024 * 1024);
    // 核心的寫法：逐層 getDirectoryHandle，最後 getFileHandle → createWritable → write… → close。
    const sub = await (await root.getDirectoryHandle("2024", { create: true })).getDirectoryHandle("trip", { create: true });
    const w1 = await (await sub.getFileHandle("a.jpg", { create: true })).createWritable();
    await w1.write(new TextEncoder().encode("hello "));
    await w1.write(new TextEncoder().encode("world"));
    await w1.close();
    const w2 = await (await root.getFileHandle("notes.txt", { create: true })).createWritable();
    await w2.write(new TextEncoder().encode("n"));
    await w2.close();
    zip.addEmptyFile("photos/empty.log");
    zip.addFolder("photos");
    zip.addFolder("photos/nothing-here");
    zip.finish();
    const files = await unzip(await blob);
    assert.equal(files.get("photos/2024/trip/a.jpg"), "hello world");
    assert.equal(files.get("photos/notes.txt"), "n");
    assert.equal(files.get("photos/empty.log"), "");
    assert.ok(files.has("photos/nothing-here/"), [...files.keys()].join(","));
    assert.deepEqual(opened, ["0:photos/2024/trip/a.jpg", "1:photos/notes.txt"]);
    assert.ok(zip.names.has("photos/notes.txt"));
});

test("an in-memory zip over the cap stops, and an abort fails the stream", async () => {
    const zip = new ZipCollector();
    const blob = collectZip(zip.stream, 1000);
    const w = await (await zipDirectoryHandle(zip, "x").getFileHandle("big")).createWritable();
    void w.write(new Uint8Array(4000)).catch(() => undefined);
    void w.close();
    zip.finish();
    await assert.rejects(blob, (e) => e instanceof ZipTooLarge);

    const z2 = new ZipCollector();
    const b2 = collectZip(z2.stream, 1e9);
    const w2 = await (await zipDirectoryHandle(z2, "y").getFileHandle("f")).createWritable();
    void w2.write(new Uint8Array(10)).catch(() => undefined);
    z2.abort(new Error("cancelled"));
    await assert.rejects(b2, /cancelled/);
});
