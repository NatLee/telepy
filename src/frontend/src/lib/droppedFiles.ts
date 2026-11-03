"use client";

/**
 * 拖進來的東西（可能有資料夾）→ 檔案 + 相對路徑 + 空資料夾。檔案管理和 RustDesk 檔案面板共用。
 * 只有 Chromium / Safari / Firefox 的 `webkitGetAsEntry` 看得到資料夾；沒有就只拿得到最上層的檔案。
 * Dropped items, folders included (files with relative paths plus empty folders); shared by the file manager and the
 * RustDesk files panel. Folders need `webkitGetAsEntry`; without it only top-level files come through.
 */
import type { LocalItem } from "./uploadParts.ts";

export async function readDropped(dt: DataTransfer): Promise<{ items: LocalItem[]; emptyDirs: string[] }> {
    type Entry = { isFile: boolean; isDirectory: boolean; name: string; file?: (ok: (f: File) => void, err: (e: unknown) => void) => void; createReader?: () => { readEntries(ok: (e: Entry[]) => void, err: (e: unknown) => void): void } };
    const entries = Array.from(dt.items ?? [])
        .map((i) => (i.kind === "file" ? ((i.webkitGetAsEntry?.() ?? null) as unknown as Entry | null) : null))
        .filter((e): e is Entry => !!e);
    if (entries.length === 0 || entries.every((e) => e.isFile)) return { items: Array.from(dt.files).map((file) => ({ file, rel: file.name })), emptyDirs: [] };
    const items: LocalItem[] = [];
    const emptyDirs: string[] = [];
    const walk = async (entry: Entry, prefix: string): Promise<void> => {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isFile && entry.file) {
            const file = await new Promise<File>((ok, err) => entry.file!(ok, err));
            items.push({ file, rel });
            return;
        }
        if (!entry.isDirectory || !entry.createReader) return;
        const reader = entry.createReader();
        const children: Entry[] = [];
        for (;;) {
            const batch = await new Promise<Entry[]>((ok, err) => reader.readEntries(ok, err));
            if (batch.length === 0) break;
            children.push(...batch);
        }
        if (children.length === 0) emptyDirs.push(rel);
        for (const c of children) await walk(c, rel);
    };
    for (const e of entries) await walk(e, "");
    return { items, emptyDirs };
}

