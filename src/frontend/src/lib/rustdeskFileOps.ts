/**
 * 網頁內 RustDesk「檔案」面板的資料夾下載、刪除、改名 / 搬移、新資料夾、上傳資料夾（純函式，無 React）。
 * 都是 RustDesk 自己的 `FileAction`，經 iframe 裡第二份核心的檔案 API 送出：
 * - 遞迴列出 = `read_dir_to_remove_recursive`（`ReadAllFiles`，回來的名稱是相對於資料夾的路徑）
 * - 刪檔 = `remove_file`；刪資料夾 = 逐一刪檔後 `remove_all_empty_dirs`（RustDesk 只刪「空的」樹）
 * - 改名 = `rename_file`（裝置把新名字接在原本的上一層後面，所以打 `../x/名字` 或絕對路徑就是同一顆磁碟裡的搬移）
 * - 新資料夾 = `create_dir`；空資料夾清單 = `ReadEmptyDirs`（核心沒有對外的呼叫，面板自己編這一則送出）
 * Pure helpers for folder downloads, delete, rename / move, new folder and folder uploads in the in-browser RustDesk
 * Files panel. All of them are RustDesk's own file actions, sent through the second core's file API.
 */
import { ENTRY_DIR, ENTRY_DIR_LINK, ENTRY_DRIVE, joinRemote, MAX_TRANSFER_BYTES, type RemoteEntry } from "./rustdeskFiles.ts";
import { statesAlong, type SpotState } from "./flow.ts";

/** zip 裡的名稱：`/` 分隔、去掉開頭的 `/`、`.`、`..` 與空段（不能逃出 zip 的根）。/ A safe entry name. */
export function zipEntryName(parts: string[]): string {
    return parts
        .flatMap((p) => p.split(/[\\/]+/))
        .filter((p) => p.length > 0 && p !== "." && p !== "..")
        .join("/");
}

/** 資料夾下載超過這些就先問。/ Ask before a folder download above these. */
export const FOLDER_CONFIRM_FILES = 500;
export const FOLDER_CONFIRM_BYTES = MAX_TRANSFER_BYTES;
/** 沒有存檔對話框時整個 zip 放在記憶體：上限同單一檔案。/ In-memory zip cap without a save picker. */
export const MEMORY_ZIP_CAP = MAX_TRANSFER_BYTES;

export interface ListedFile {
    /** 相對於資料夾的路徑，`/` 分隔。/ Path relative to the folder, `/`-separated. */
    rel: string;
    size: number;
    /** Unix 秒。/ Unix seconds. */
    modified: number;
}

export interface RecursiveListing {
    id: number;
    path: string;
    files: ListedFile[];
}

function parseJson(value: unknown): Record<string, unknown> | null {
    let raw: unknown = value;
    if (typeof value === "string") {
        try {
            raw = JSON.parse(value);
        } catch {
            return null;
        }
    }
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

/** `file_dir` 事件裡帶的 id（一般的資料夾清單是 0）。/ The id a `file_dir` value carries (0 for plain listings). */
export function fileDirId(value: unknown): number {
    const o = parseJson(value);
    return Number(o?.id) || 0;
}

/** 遞迴列出的結果（`ReadAllFiles`）：只有檔案，名稱是相對路徑。/ A recursive listing: files only, relative names. */
export function parseRecursiveListing(value: unknown): RecursiveListing | null {
    const o = parseJson(value);
    if (!o || typeof o.path !== "string" || !Array.isArray(o.entries)) return null;
    const files: ListedFile[] = [];
    for (const e of o.entries) {
        if (!e || typeof e !== "object") continue;
        const r = e as { entry_type?: unknown; name?: unknown; size?: unknown; modified_time?: unknown };
        const type = Number(r.entry_type);
        if (typeof r.name !== "string" || type === ENTRY_DIR || type === ENTRY_DIR_LINK || type === ENTRY_DRIVE) continue;
        const rel = zipEntryName([r.name]);
        if (!rel) continue;
        files.push({ rel, size: Math.max(0, Number(r.size) || 0), modified: Number(r.modified_time) || 0 });
    }
    return { id: Number(o.id) || 0, path: o.path, files };
}

/** 裝置路徑 → 相對於 `root` 的路徑（不在底下 → null）。/ A device path relative to `root`. */
export function relativeTo(root: string, path: string): string | null {
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
    const r = norm(root);
    const p = norm(path);
    if (p === r) return "";
    const prefix = r === "" ? "/" : `${r}/`;
    if (!p.toLowerCase().startsWith(prefix.toLowerCase())) return null;
    return zipEntryName([p.slice(prefix.length)]);
}

/** `empty_dirs` 事件（`ReadEmptyDirs` 的回答）→ 相對於 `root` 的空資料夾。/ Empty folders under `root`. */
export function parseEmptyDirs(value: unknown, root: string): string[] | null {
    const o = parseJson(value);
    if (!o || !Array.isArray(o.empty_dirs)) return null;
    const out: string[] = [];
    for (const d of o.empty_dirs) {
        const p = d && typeof d === "object" ? (d as { path?: unknown }).path : null;
        if (typeof p !== "string") continue;
        const rel = relativeTo(root, p);
        if (rel) out.push(rel);
    }
    return out;
}

/** `empty_dirs` 是不是在回答這個資料夾。/ Whether an `empty_dirs` event answers this folder. */
export function emptyDirsPath(value: unknown): string | null {
    const o = parseJson(value);
    return typeof o?.path === "string" ? o.path : null;
}

export interface ZipPlan {
    /** zip 最上層的資料夾名稱。/ The zip's top folder. */
    root: string;
    zipName: string;
    files: { name: string; size: number; modified: number }[];
    folders: string[];
    fileCount: number;
    totalBytes: number;
}

/** 遞迴清單 + 空資料夾 → zip 的內容（全部放在 `<資料夾名>/` 底下）。/ What goes into the zip. */
export function zipPlan(folderName: string, files: ListedFile[], emptyDirs: string[]): ZipPlan {
    const root = zipEntryName([folderName]) || "folder";
    const folders = [root, ...emptyDirs.map((d) => zipEntryName([root, d])).filter(Boolean)];
    const planned = files.map((f) => ({ name: zipEntryName([root, f.rel]), size: f.size, modified: f.modified }));
    return {
        root,
        zipName: `${root}.zip`,
        files: planned,
        folders: [...new Set(folders)],
        fileCount: planned.length,
        totalBytes: planned.reduce((n, f) => n + f.size, 0),
    };
}

/** 要不要先問（很多檔案或很大）。/ Whether to ask first (many files or large). */
export function needsConfirm(plan: Pick<ZipPlan, "fileCount" | "totalBytes">): boolean {
    return plan.fileCount > FOLDER_CONFIRM_FILES || plan.totalBytes > FOLDER_CONFIRM_BYTES;
}

/** 沒有存檔對話框（只能放記憶體）時太大。/ Too big for an in-memory zip. */
export function tooLargeForMemory(plan: Pick<ZipPlan, "totalBytes">): boolean {
    return plan.totalBytes > MEMORY_ZIP_CAP;
}

/** 核心沒開把手的檔案（0 byte）：下載完再補進 zip。/ Planned files the core never opened (empty ones). */
export function missingFiles(plan: ZipPlan, written: Set<string>): ZipPlan["files"] {
    return plan.files.filter((f) => !written.has(f.name) && f.size === 0);
}

/** 相對路徑接在遠端資料夾後面（Windows 換成 `\`）。/ A relative path under a remote folder. */
export function remoteFromRel(base: string, rel: string, windows: boolean): string {
    return rel.split("/").filter(Boolean).reduce((acc, part) => joinRemote(acc, part, windows), base);
}

// ---- rename / move ------------------------------------------------------------------------------------------

export type RenameProblem = "empty" | "same" | "dots" | "trailing";

export interface RenamePlan {
    /** 送給裝置的 `new_name`（裝置接在原本的上一層後面）。/ The `new_name` sent to the device. */
    newName: string;
    /** 改完的完整路徑（顯示用）。/ The resulting path, for display. */
    target: string;
    /** 換了資料夾 = 搬移。/ Moved to another folder. */
    move: boolean;
}

function normalizeRemote(path: string, windows: boolean): string {
    const sep = windows ? "\\" : "/";
    const isAbs = windows ? /^[A-Za-z]:/.test(path) : path.startsWith("/");
    const drive = windows ? (/^([A-Za-z]:)/.exec(path)?.[1] ?? "") : "";
    const parts: string[] = [];
    for (const p of path.slice(drive.length).split(/[\\/]+/)) {
        if (p === "" || p === ".") continue;
        if (p === "..") parts.pop();
        else parts.push(p);
    }
    if (windows) return isAbs ? `${drive}\\${parts.join(sep)}` : parts.join(sep);
    return `/${parts.join(sep)}`;
}

/** 輸入的新名稱（或路徑）→ 送出去的 `new_name` 與結果路徑；不合理 → 問題代碼。/ Plan a rename or move. */
export function planRename(dir: string, oldName: string, input: string, windows: boolean): RenamePlan | RenameProblem {
    const value = input.trim();
    if (value === "") return "empty";
    if (/[\\/]$/.test(value) && value.replace(/[\\/]+/g, "") !== "") return "trailing";
    if (value === "." || value === ".." || /^[\\/.]+$/.test(value)) return "dots";
    if (value === oldName) return "same";
    const absolute = windows ? /^[A-Za-z]:[\\/]/.test(value) : value.startsWith("/");
    const target = normalizeRemote(absolute ? value : `${dir}${windows ? "\\" : "/"}${value}`, windows);
    const oldPath = normalizeRemote(`${dir}${windows ? "\\" : "/"}${oldName}`, windows);
    if (target === oldPath) return "same";
    const parentOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")));
    return { newName: value, target, move: parentOf(target).toLowerCase() !== parentOf(oldPath).toLowerCase() };
}

/** 「新資料夾」「新資料夾 (2)」…：不和現有名稱撞。/ A name that does not clash with the listing. */
export function freeName(base: string, existing: string[]): string {
    const taken = new Set(existing.map((n) => n.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n += 1) {
        const c = `${base} (${n})`;
        if (!taken.has(c.toLowerCase())) return c;
    }
}

/** 名稱可以當一個資料夾 / 檔案名（不含路徑分隔、不是 . / ..）。/ A valid single name. */
export function validName(name: string): boolean {
    const v = name.trim();
    return v !== "" && v !== "." && v !== ".." && !/[\\/]/.test(v);
}

// ---- delete -------------------------------------------------------------------------------------------------

export interface DeleteItem {
    name: string;
    path: string;
    isDir: boolean;
    size: number;
    /** 資料夾的遞迴清單（確認前先數）。/ A folder's recursive listing (counted before asking). */
    files?: ListedFile[];
    /** 列出時用的 id：刪除沿用它，中繼的稽核才能把整個資料夾記成一筆。/ The listing's id, reused by the removals. */
    listId?: number;
}

export interface DeleteSummary {
    folders: number;
    files: number;
    /** 資料夾裡面的檔案（含子資料夾）。/ Files inside the folders. */
    inside: number;
    bytes: number;
}

/** 確認對話框要講的數字。/ The numbers the confirmation names. */
export function deleteSummary(items: DeleteItem[]): DeleteSummary {
    let folders = 0;
    let files = 0;
    let inside = 0;
    let bytes = 0;
    for (const it of items) {
        if (it.isDir) {
            folders += 1;
            inside += it.files?.length ?? 0;
            bytes += (it.files ?? []).reduce((n, f) => n + f.size, 0);
        } else {
            files += 1;
            bytes += it.size;
        }
    }
    return { folders, files, inside, bytes };
}

export type DeleteStep = { op: "remove_file"; path: string; fileNum: number } | { op: "remove_all_empty_dirs"; path: string };

/** 一個項目的刪除步驟：檔案一步；資料夾 = 每個檔案一步 + 最後刪空的樹。/ The steps to delete one item. */
export function deleteSteps(item: DeleteItem, windows: boolean): DeleteStep[] {
    if (!item.isDir) return [{ op: "remove_file", path: item.path, fileNum: 0 }];
    const steps: DeleteStep[] = (item.files ?? []).map((f, i) => ({ op: "remove_file", path: remoteFromRel(item.path, f.rel, windows), fileNum: i }));
    steps.push({ op: "remove_all_empty_dirs", path: item.path });
    return steps;
}

// ---- folder upload ------------------------------------------------------------------------------------------

export interface LocalItem {
    file: File;
    /** 相對路徑（拖進來的資料夾 / webkitdirectory），`/` 分隔。/ The relative path. */
    rel: string;
}

export interface UploadPlan {
    /** 要先建的遠端資料夾（上層在前）。/ Remote folders to create first, parents first. */
    dirs: string[];
    files: { file: File; rel: string; to: string }[];
}

/** 上傳一批（可能含資料夾）的步驟：先建資料夾（含空的），再逐一傳檔。/ Plan an upload that may hold folders. */
export function planUpload(base: string, items: LocalItem[], emptyDirs: string[], windows: boolean): UploadPlan {
    const dirs = new Set<string>();
    const addParents = (rel: string, includeSelf: boolean) => {
        const parts = rel.split("/").filter(Boolean);
        const upto = includeSelf ? parts.length : parts.length - 1;
        for (let i = 1; i <= upto; i += 1) dirs.add(parts.slice(0, i).join("/"));
    };
    const files = items.map((it) => {
        const rel = zipEntryName([it.rel || it.file.name]) || it.file.name;
        addParents(rel, false);
        return { file: it.file, rel, to: remoteFromRel(base, rel, windows) };
    });
    for (const d of emptyDirs) {
        const rel = zipEntryName([d]);
        if (rel) addParents(rel, true);
    }
    const sorted = [...dirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    return { dirs: sorted.map((d) => remoteFromRel(base, d, windows)), files };
}

/** 建資料夾時「已經有了」不算錯。/ "Already exists" is fine when creating a folder. */
export function isExistsError(err: string): boolean {
    return /exist|file exists|os error 17|os error 183/i.test(err);
}

// ---- the ReadEmptyDirs message ------------------------------------------------------------------------------

function varint(n: number, out: number[]) {
    let v = n >>> 0;
    while (v >= 0x80) {
        out.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    out.push(v);
}

function lenField(num: number, bytes: Uint8Array | number[], out: number[]) {
    varint((num << 3) | 2, out);
    varint(bytes.length, out);
    for (const b of bytes) out.push(b);
}

/**
 * `Message { file_action { read_empty_dirs { path, include_hidden } } }`（message.proto：Message.file_action = 17、
 * FileAction.read_empty_dirs = 11）。核心有處理回答（`empty_dirs` 事件）但沒有送出的呼叫，所以面板自己編這一則。
 * The ReadEmptyDirs request: the core handles the answer but exposes no call to send it.
 */
export function readEmptyDirsMessage(path: string, includeHidden: boolean): Uint8Array {
    const inner: number[] = [];
    lenField(1, new TextEncoder().encode(path), inner);
    if (includeHidden) {
        varint(2 << 3, inner);
        varint(1, inner);
    }
    const action: number[] = [];
    lenField(11, inner, action);
    const msg: number[] = [];
    lenField(17, action, msg);
    return new Uint8Array(msg);
}

// ---- what is happening (diagrams) ---------------------------------------------------------------------------

export type FileOpKind = "download" | "upload" | "rename" | "delete";
export const FILE_OP_KINDS: readonly FileOpKind[] = ["download", "upload", "rename", "delete"];
export type FileOpState = "idle" | "running" | "done" | "failed";
export type FileActivity = Record<FileOpKind, FileOpState>;

export const IDLE_ACTIVITY: FileActivity = { download: "idle", upload: "idle", rename: "idle", delete: "idle" };

/** 一種動作的最新結果套上去（跑著的優先於結果）。/ Record the latest state of one kind of action. */
export function withActivity(a: FileActivity, kind: FileOpKind, state: FileOpState): FileActivity {
    return a[kind] === state ? a : { ...a, [kind]: state };
}

/** 現在正在做的（說明圖上亮起的那一個）：刪除 > 改名 > 上傳 > 下載。/ The action in flight, if any. */
export function currentOp(a: FileActivity): FileOpKind | null {
    for (const k of ["delete", "rename", "upload", "download"] as const) if (a[k] === "running") return k;
    return null;
}

/** 從工作清單算出上傳 / 下載的狀態。/ Upload / download state from the job list. */
export function transferActivity(jobs: { kind: "download" | "upload"; state: string }[], kind: "download" | "upload"): FileOpState {
    const mine = jobs.filter((j) => j.kind === kind);
    if (mine.some((j) => j.state === "running" || j.state === "confirm" || j.state === "listing" || j.state === "finishing")) return "running";
    const last = mine[mine.length - 1];
    if (!last) return "idle";
    return last.state === "failed" ? "failed" : last.state === "done" ? "done" : "idle";
}

/** 選取的項目裡有沒有資料夾 / 檔案（批次刪除的按鈕文字）。/ What the selection holds. */
export function selectionKinds(entries: RemoteEntry[], selected: Set<string>): { folders: number; files: number } {
    let folders = 0;
    let files = 0;
    for (const e of entries) {
        if (!selected.has(e.name)) continue;
        if (e.isDir) folders += 1;
        else files += 1;
    }
    return { folders, files };
}

// ---- the Files panel's path diagram -------------------------------------------------------------------------

/** 說明圖的站與線：瀏覽器（第二份核心）─ Telepy 中繼 ─ 隧道 ─ 裝置的 RustDesk ─ 磁碟。/ Spots on the files diagram. */
export type RdFileSpot = "browser" | "web" | "relay" | "tunnel" | "rustdesk" | "local" | "disk";
export const RD_FILE_SPOTS: readonly RdFileSpot[] = ["browser", "web", "relay", "tunnel", "rustdesk", "local", "disk"];
export type RdFilesPhase = "starting" | "connecting" | "ready" | "failed";

/** 面板的失敗原因 → 卡在哪一站。/ Where a panel failure stopped. */
export function failureSpot(key: string | null): RdFileSpot {
    if (!key) return "relay";
    if (key === "desktop.err.rdCore") return "browser";
    if (key === "desktop.err.network") return "web";
    if (key === "desktop.err.deviceOffline") return "tunnel";
    if (key === "desktop.err.rdDirectIpOff" || key === "desktop.err.rdPassword" || key.startsWith("desktop.err.rd")) return "rustdesk";
    return "relay";
}

/** 每一站的狀態：連線中逐段亮起、正在做的動作讓整條線流動、失敗標在那一站。/ The state of every spot. */
export function rdFileSpots(phase: RdFilesPhase, op: FileOpKind | null, failureKey: string | null): Record<RdFileSpot, SpotState> {
    switch (phase) {
        case "starting":
            return statesAlong(RD_FILE_SPOTS, { activeFrom: "web", activeTo: "relay" });
        case "connecting":
            return statesAlong(RD_FILE_SPOTS, { activeFrom: "tunnel", activeTo: "rustdesk" });
        case "failed":
            return statesAlong(RD_FILE_SPOTS, { failedAt: failureSpot(failureKey) });
        case "ready":
            return op ? statesAlong(RD_FILE_SPOTS, { activeFrom: "web", activeTo: "disk" }) : statesAlong(RD_FILE_SPOTS, { okUntil: "rustdesk" });
    }
}
