/**
 * 在瀏覽器裡邊收邊打包成 zip（client-zip，MIT，串流 + ZIP64），給「下載整個資料夾」用。
 * - RustDesk 核心下載資料夾時會向 `showDirectoryPicker()` 要一個資料夾把手，再對每個檔案
 *   `getDirectoryHandle(…)` / `getFileHandle(name).createWritable()` 逐一寫入、寫完 close。這裡做一個長得一樣的
 *   假把手（[`zipDirectoryHandle`]），每個檔案變成 zip 裡的一筆，內容一塊一塊流進去，不用先整個放記憶體。
 * - 輸出：有存檔對話框（File System Access API）就直接串流寫進使用者選的 .zip；沒有就收在記憶體裡（≤ 上限）再下載。
 * Streams a zip in the browser (client-zip: streaming, ZIP64) for whole-folder downloads. The RustDesk core writes
 * a folder through a directory handle, file by file; a look-alike handle turns each file into a zip entry whose
 * content streams in. The zip goes straight into the user's save-picker file, or into memory (capped) otherwise.
 */
import { makeZip } from "client-zip";
import { zipEntryName } from "./rustdeskFileOps.ts";

export { zipEntryName };

/** 一個檔案的內容緩衝超過這麼多就讓寫入的一方等。/ Back-pressure threshold per file. */
const HIGH_WATER = 8 * 1024 * 1024;

/** 先進先出的非同步佇列（`for await` 讀；`end` 結束、`fail` 讓讀的一方拋錯）。/ An async FIFO queue. */
export class AsyncQueue<T> implements AsyncIterable<T> {
    private items: T[] = [];
    private waiters: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }[] = [];
    private ended = false;
    private error: unknown = null;

    push(item: T) {
        if (this.ended || this.error) return;
        const w = this.waiters.shift();
        if (w) w.resolve({ value: item, done: false });
        else this.items.push(item);
    }

    end() {
        this.ended = true;
        for (const w of this.waiters.splice(0)) w.resolve({ value: undefined as never, done: true });
    }

    fail(err: unknown) {
        this.error = err ?? new Error("aborted");
        this.items = [];
        for (const w of this.waiters.splice(0)) w.reject(this.error);
    }

    get size(): number {
        return this.items.length;
    }

    next(): Promise<IteratorResult<T>> {
        if (this.error) return Promise.reject(this.error);
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return { next: () => this.next() };
    }
}

/** 一個檔案的內容通道：`write` 塞一塊（緩衝滿了會等）、`close` 結束、`abort` 讓 zip 失敗。/ One file's byte channel. */
export class ByteChannel implements AsyncIterable<Uint8Array> {
    private queue = new AsyncQueue<Uint8Array>();
    private buffered = 0;
    private drained: (() => void)[] = [];
    written = 0;

    async write(chunk: Uint8Array | ArrayBuffer | ArrayBufferView) {
        const bytes = chunk instanceof Uint8Array ? chunk : ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : new Uint8Array(chunk);
        if (bytes.length === 0) return;
        this.buffered += bytes.length;
        this.written += bytes.length;
        this.queue.push(bytes);
        if (this.buffered > HIGH_WATER) await new Promise<void>((resolve) => this.drained.push(resolve));
    }

    async close() {
        this.queue.end();
        this.release();
    }

    async abort(reason?: unknown) {
        this.queue.fail(reason ?? new Error("aborted"));
        this.release();
    }

    private release() {
        for (const r of this.drained.splice(0)) r();
    }

    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
            next: async () => {
                const r = await this.queue.next();
                if (!r.done) {
                    this.buffered -= r.value.length;
                    if (this.buffered <= HIGH_WATER / 2) this.release();
                }
                return r;
            },
        };
    }
}

/** zip 的一筆：串流的檔案、已知內容的檔案、或資料夾（client-zip 的三種輸入）。/ One zip entry. */
type ZipInput =
    | { name: string; input: AsyncIterable<Uint8Array>; lastModified?: Date }
    | { name: string; input: Uint8Array; size: number; lastModified?: Date }
    | { name: string; lastModified?: Date };

/** 邊收邊打包的 zip：檔案一個接一個加進來，`stream` 是 zip 的位元組。/ A zip assembled as files arrive. */
export class ZipCollector {
    private queue = new AsyncQueue<ZipInput>();
    private open: ByteChannel | null = null;
    /** 已經加進 zip 的名稱（檔案與資料夾）。/ Names already in the zip. */
    readonly names = new Set<string>();
    readonly stream: ReadableStream<Uint8Array>;
    /** 開始寫一個檔案時通知（第幾個、名稱）。/ Called when a file starts. */
    onFile: ((index: number, name: string) => void) | null = null;
    private files = 0;

    constructor() {
        this.stream = makeZip(this.queue);
    }

    /** 開一個檔案（同名的話加上「 (2)」）。/ Start a file entry; a duplicate name gets a " (2)" suffix. */
    openFile(name: string, lastModified?: Date): ByteChannel {
        const unique = uniqueEntry(name, this.names);
        this.names.add(unique);
        const ch = new ByteChannel();
        this.open = ch;
        this.queue.push({ name: unique, input: ch, lastModified });
        this.onFile?.(this.files++, unique);
        return ch;
    }

    /** 空檔案（核心不會為 0 byte 的檔案開把手）。/ An empty file (the core opens no handle for those). */
    addEmptyFile(name: string, lastModified?: Date) {
        const unique = uniqueEntry(name, this.names);
        this.names.add(unique);
        this.queue.push({ name: unique, input: new Uint8Array(0), size: 0, lastModified });
    }

    /** 資料夾（保留空資料夾）。/ A folder entry (keeps empty folders). */
    addFolder(name: string, lastModified?: Date) {
        const n = name.replace(/\/+$/, "");
        if (!n || this.names.has(`${n}/`)) return;
        this.names.add(`${n}/`);
        this.queue.push({ name: `${n}/`, lastModified });
    }

    finish() {
        this.queue.end();
    }

    abort(reason?: unknown) {
        void this.open?.abort(reason);
        this.queue.fail(reason ?? new Error("aborted"));
    }
}

/** 名稱重複時加「 (2)」「 (3)」…（副檔名之前）。/ " (2)", " (3)" … before the extension. */
export function uniqueEntry(name: string, taken: Set<string>): string {
    if (!taken.has(name)) return name;
    const slash = name.lastIndexOf("/");
    const dir = name.slice(0, slash + 1);
    const base = name.slice(slash + 1);
    const dot = base.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
    for (let n = 2; ; n += 1) {
        const candidate = `${dir}${stem} (${n})${ext}`;
        if (!taken.has(candidate)) return candidate;
    }
}

/** 核心寫入時看到的「可寫串流」。/ What the core writes into. */
interface WritableLike {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
}

/** 長得像 FileSystemDirectoryHandle 的假把手：每個檔案寫進 zip 的 `prefix/…`。/ A look-alike directory handle. */
export interface ZipDirectoryHandle {
    kind: "directory";
    name: string;
    getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<ZipDirectoryHandle>;
    getFileHandle(name: string, opts?: { create?: boolean }): Promise<{ kind: "file"; name: string; createWritable(): Promise<WritableLike> }>;
}

export function zipDirectoryHandle(zip: ZipCollector, prefix: string): ZipDirectoryHandle {
    return {
        kind: "directory",
        name: prefix.split("/").filter(Boolean).pop() ?? "",
        getDirectoryHandle: async (name) => zipDirectoryHandle(zip, zipEntryName([prefix, name])),
        getFileHandle: async (name) => ({
            kind: "file",
            name,
            createWritable: async () => {
                const ch = zip.openFile(zipEntryName([prefix, name]));
                return { write: (c) => ch.write(c), close: () => ch.close(), abort: (r) => ch.abort(r) };
            },
        }),
    };
}

/** 記憶體裡收集時超過上限。/ The in-memory zip went over the cap. */
export class ZipTooLarge extends Error {
    constructor() {
        super("zip too large to keep in memory");
        this.name = "ZipTooLarge";
    }
}

/** 把整個 zip 收進記憶體（> `cap` 就停、拋 ZipTooLarge）。/ Read the zip into memory, capped. */
export async function collectZip(stream: ReadableStream<Uint8Array>, cap: number): Promise<Blob> {
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > cap) {
            await reader.cancel().catch(() => undefined);
            throw new ZipTooLarge();
        }
        parts.push(value);
    }
    return new Blob(parts as BlobPart[], { type: "application/zip" });
}
