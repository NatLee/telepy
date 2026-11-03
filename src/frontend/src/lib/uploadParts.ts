/**
 * 分段上傳的純函式（無 I/O）：每段多大、哪些失敗值得重送、等多久、伺服器的回答代表什麼，以及拖進來 / 選進來的
 * 資料夾變成哪些目標路徑。`uploadParts.test.ts` 有測試；送出在 `uploadXhr.ts`。
 *
 * 為什麼分段：一個大檔一個請求時，前面的代理會擋（Cloudflare 一個請求最多 100 MB；Nginx 先收完整個檔案才轉給
 * Telepy，再等裝置寫完，常常超過它的逾時），而且進度只代表「代理收到了」。分段後每段 8 MiB 一個請求，進度 =
 * 裝置真的收到了，斷掉只重送那一段。
 *
 * Pure helpers for uploading in parts: the part size, which failures are worth resending and after how long, what
 * the server's answer means, and the target paths for dropped / picked folders. One request per 8 MiB part keeps
 * big files clear of proxies' body limits and timeouts, makes the progress mean "on the device", and a failure
 * resends only that part.
 */

/** 一段多大（後端最多收 32 MiB）。/ Bytes per part (the backend accepts up to 32 MiB). */
export const PART_SIZE = 8 * 1024 * 1024;
/** 一段最多重送幾次。/ Resends per part at most. */
export const MAX_RETRIES = 5;
const DELAYS = [1000, 2000, 4000, 8000, 15000];

/** 新的上傳 id（後端要 8–64 個英數字）。/ A fresh upload id (8–64 letters or digits). */
export function newUploadId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
    const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from(random(16), (b) => abc[b % abc.length]).join("");
}

/**
 * 這次失敗要不要重送、等多久（毫秒）；null = 不重送。`status` 0 = 連線斷了 / 沒有回應。
 * 502 / 504 / 520–524 是前面的代理放棄了，429 / 503 是太忙，都值得再試一次。
 * Whether (and after how long) to resend after a failure; null = don't. 0 = the connection dropped.
 */
export function retryDelay(status: number, attempt: number): number | null {
    if (attempt >= MAX_RETRIES) return null;
    const transient = status === 0 || status === 408 || status === 429 || status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 524);
    return transient ? DELAYS[Math.min(attempt, DELAYS.length - 1)] : null;
}

export interface PartQuery {
    path: string;
    upload: string;
    offset: number;
    total: number;
    overwrite: boolean;
    parents: boolean;
    retry: boolean;
}

export function partQuery(q: PartQuery): string {
    const p = new URLSearchParams({ path: q.path, upload: q.upload, offset: String(q.offset), total: String(q.total) });
    if (q.overwrite) p.set("overwrite", "1");
    if (q.parents) p.set("parents", "1");
    if (q.retry) p.set("retry", "1");
    return p.toString();
}

export type PartOutcome =
    | { kind: "next"; offset: number }
    | { kind: "done"; path: string | null }
    | { kind: "restart" }
    /** 裝置上的暫存檔跟本機檔案對不上（被動過、或本機是另一個檔案）：從頭開新的上傳。/ Start a fresh upload. */
    | { kind: "fresh" }
    /** `kept` = 同名衝突，傳好的部分留在裝置上等使用者決定要不要取代。/ `kept` = a name clash; the upload waits. */
    | { kind: "fail"; code: string | null; error: string | null; kept?: boolean };

interface PartBody {
    received?: number;
    done?: boolean;
    path?: string;
    code?: string;
    error?: string;
    kept?: boolean;
}

/**
 * 伺服器回答一段之後下一步：200 = 下一段（或完成）；409 `upload_offset` = 從裝置上有的地方接著傳；
 * 409 `upload_gone` = 裝置上的暫存檔不見了，從頭來；其他 = 失敗（`code` 給翻譯）。
 * What to do after a part's answer: the next offset, done, start over, or fail.
 */
export function partOutcome(status: number, body: unknown): PartOutcome {
    const b = (body && typeof body === "object" ? body : {}) as PartBody;
    if (status >= 200 && status < 300) {
        if (b.done) return { kind: "done", path: typeof b.path === "string" ? b.path : null };
        if (typeof b.received === "number") return { kind: "next", offset: b.received };
    }
    if (status === 409 && b.code === "upload_offset" && typeof b.received === "number") return { kind: "next", offset: b.received };
    if (status === 409 && b.code === "upload_gone") return { kind: "restart" };
    if (status === 409 && b.code === "upload_mismatch") return { kind: "fresh" };
    const fail = { kind: "fail" as const, code: typeof b.code === "string" ? b.code : null, error: typeof b.error === "string" ? b.error : null };
    return b.kept ? { ...fail, kept: true } : fail;
}

// ---------------------------------------------------------------- resuming

/** 比一段大的檔案先問伺服器能不能續傳（只有一段的檔案沒什麼好續）。/ Files above one part ask whether to resume. */
export function resumable(size: number): boolean {
    return size > PART_SIZE;
}

/** 續傳要的本機檔案身分：名字 + 大小 + 修改時間。/ The local file's identity for resuming. */
export function localIdentity(file: { name: string; lastModified: number }): { name: string; modified: number } {
    return { name: file.name, modified: Math.trunc(file.lastModified) };
}

export interface UnfinishedUpload {
    upload: string;
    name: string;
    target: string;
    part_name: string;
    total: number;
    received: number;
    by: string | null;
    mine: boolean;
    updated_at: string;
    active: boolean;
    removed_in: number;
    local_name: string | null;
    local_modified: number | null;
    can_discard: boolean;
}

/** 選回來的檔案是不是當初那一個（名字、大小、修改時間都一樣）。/ Whether a picked file is the one that was being uploaded. */
export function sameLocalFile(file: { name: string; size: number; lastModified: number }, u: Pick<UnfinishedUpload, "local_name" | "local_modified" | "total">): boolean {
    return u.local_name === file.name && u.total === file.size && u.local_modified === Math.trunc(file.lastModified);
}

/** Telepy 的上傳暫存檔名（`.<name>.telepy-upload-<id>.part`）。/ A Telepy upload part file's name. */
export function isPartFileName(name: string): boolean {
    return /^\..+\.telepy-upload-[A-Za-z0-9]{8,64}\.part$/.test(name);
}

/** 列表裡藏起帳上有的暫存檔（顯示成「未完成的上傳」）；不在帳上的照樣列出來。
 * Hide part files the ledger knows (they show as unfinished uploads); unknown ones stay listed. */
export function hideKnownParts<T extends { name: string }>(items: readonly T[], unfinished: readonly Pick<UnfinishedUpload, "part_name">[]): T[] {
    if (!unfinished.length) return [...items];
    const known = new Set(unfinished.map((u) => u.part_name));
    return items.filter((i) => !known.has(i.name));
}

/** 還要多久會被清掉（小時，至少 1）。/ Hours until the cleanup removes it (at least 1). */
export function hoursLeft(removedInSecs: number): number {
    return Math.max(1, Math.ceil(removedInSecs / 3600));
}

/** 一段的範圍 [start, end)。空檔案也有一段（0, 0）。/ The byte range of the part starting at `offset`. */
export function partRange(offset: number, size: number, partSize = PART_SIZE): [number, number] {
    return [offset, Math.min(size, offset + partSize)];
}

// ---------------------------------------------------------------- folders

/** 拖進來 / 選進來的一個檔案與它的相對路徑（`/` 分隔）。/ A local file and its relative path. */
export interface LocalItem {
    file: File;
    rel: string;
}

/** 相對路徑整理成安全的樣子：`/` 分隔、去掉 `.`、`..`、空段與開頭的 `/`。/ A safe relative path. */
export function safeRel(rel: string): string {
    return rel
        .split(/[\\/]+/)
        .filter((p) => p.length > 0 && p !== "." && p !== "..")
        .join("/");
}

/** 最上層的名字（`photos/a.jpg` → `photos`）。/ The top-level name of a relative path. */
export function topName(rel: string): string {
    return safeRel(rel).split("/")[0] ?? "";
}

/**
 * 跟這個資料夾裡已有的東西撞名的：同名檔案（會被取代）與同名資料夾（傳進去，裡面同名的檔案會被取代）。
 * What clashes with the listing: same-name files (replaced) and same-name folders (uploaded into).
 */
export function uploadClashes(rels: string[], existing: { name: string; dir: boolean }[]): { files: string[]; folders: string[] } {
    const files = new Set<string>();
    const folders = new Set<string>();
    const byName = new Map(existing.map((e) => [e.name, e.dir]));
    for (const rel of rels) {
        const clean = safeRel(rel);
        const top = topName(clean);
        if (!byName.has(top)) continue;
        const nested = clean.includes("/");
        // 檔案 ↔ 資料夾撞名不列：上傳時會說「那是一個資料夾 / 不是資料夾」。/ File vs folder clashes fail on their own.
        if (nested && byName.get(top)) folders.add(top);
        else if (!nested && !byName.get(top)) files.add(top);
    }
    return { files: [...files].sort(), folders: [...folders].sort() };
}

/** 空資料夾要先建（上層在前，去掉重複）。/ Empty folders to create, parents first. */
export function foldersToCreate(emptyDirs: string[]): string[] {
    const all = new Set<string>();
    for (const d of emptyDirs) {
        const parts = safeRel(d).split("/").filter(Boolean);
        for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join("/"));
    }
    return [...all].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}
