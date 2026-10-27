/**
 * 網頁內 RustDesk 的「檔案」面板的純函式（無 React）：核心的 `file_dir` 事件 → 清單、遠端路徑（Windows / Unix）、
 * 傳輸工作的狀態（`job_progress` / `job_done` / `job_error` / `override_file_confirm` …）、大小上限。
 * 傳檔是 RustDesk 自己的協定（另一條登入成 file_transfer 的連線），Telepy 只中繼，所以這裡只是把核心的事件整理成畫面要的樣子。
 * Pure helpers for the in-browser RustDesk Files panel: the core's `file_dir` events as a listing, remote paths
 * (Windows and Unix), transfer job state from the core's job events, and the size limit.
 */

/** 一次最多傳 2 GB（沒有存檔對話框的瀏覽器會整個放在記憶體裡）。/ Per-file limit (browsers without a save picker buffer in memory). */
export const MAX_TRANSFER_BYTES = 2 * 1024 * 1024 * 1024;

/** RustDesk 的 `FileType`。/ RustDesk's FileType enum. */
export const ENTRY_DIR = 0;
export const ENTRY_DIR_LINK = 2;
export const ENTRY_DRIVE = 3;
export const ENTRY_FILE = 4;
export const ENTRY_FILE_LINK = 5;

export interface RemoteEntry {
    name: string;
    /** 資料夾、資料夾連結、磁碟機（點進去）。/ A folder, a folder link or a drive (opened by a click). */
    isDir: boolean;
    isDrive: boolean;
    isLink: boolean;
    size: number;
    /** Unix 秒。/ Unix seconds. */
    modified: number;
}

export interface RemoteDir {
    path: string;
    entries: RemoteEntry[];
}

/** `file_dir` 事件的 `value`（JSON 字串）→ 清單：資料夾在前，名稱不分大小寫排序。/ The `file_dir` value as a sorted listing. */
export function parseFileDir(value: unknown): RemoteDir | null {
    let raw: unknown = value;
    if (typeof value === "string") {
        try {
            raw = JSON.parse(value);
        } catch {
            return null;
        }
    }
    if (!raw || typeof raw !== "object") return null;
    const o = raw as { path?: unknown; entries?: unknown };
    if (typeof o.path !== "string" || !Array.isArray(o.entries)) return null;
    const entries: RemoteEntry[] = [];
    for (const e of o.entries) {
        if (!e || typeof e !== "object") continue;
        const r = e as { entry_type?: unknown; name?: unknown; size?: unknown; modified_time?: unknown };
        if (typeof r.name !== "string" || r.name === "" || r.name === "." || r.name === "..") continue;
        const type = Number(r.entry_type);
        entries.push({
            name: r.name,
            isDir: type === ENTRY_DIR || type === ENTRY_DIR_LINK || type === ENTRY_DRIVE,
            isDrive: type === ENTRY_DRIVE,
            isLink: type === ENTRY_DIR_LINK || type === ENTRY_FILE_LINK,
            size: Number(r.size) || 0,
            modified: Number(r.modified_time) || 0,
        });
    }
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) : a.isDir ? -1 : 1));
    return { path: o.path, entries };
}

/** 對方是 Windows（路徑用 `\`，最上層是磁碟機清單 = 空字串）。/ A Windows peer: backslashes, the drive list is "". */
export function isWindowsPeer(platform: string | null | undefined): boolean {
    return /windows/i.test(platform ?? "");
}

/** 資料夾 + 名稱。Windows 的磁碟機（`C:`）接成 `C:\`。/ Join a folder and a name; a Windows drive becomes `C:\`. */
export function joinRemote(dir: string, name: string, windows: boolean): string {
    const sep = windows ? "\\" : "/";
    if (windows && dir === "") return /^[A-Za-z]:$/.test(name) ? `${name}\\` : name;
    if (dir === "") return `/${name}`;
    return dir.endsWith(sep) || (windows && dir.endsWith("/")) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** 上一層；已經在最上層 → null（Unix 的 `/`、Windows 的磁碟機清單）。/ The parent folder, or null at the top. */
export function parentRemote(path: string, windows: boolean): string | null {
    if (windows) {
        if (path === "") return null;
        const trimmed = path.replace(/[\\/]+$/, "");
        if (/^[A-Za-z]:$/.test(trimmed)) return "";
        const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
        if (i < 0) return "";
        const parent = trimmed.slice(0, i);
        return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
    }
    if (path === "/" || path === "") return null;
    const trimmed = path.replace(/\/+$/, "");
    const i = trimmed.lastIndexOf("/");
    return i <= 0 ? "/" : trimmed.slice(0, i);
}

export interface Crumb {
    label: string;
    path: string;
}

/** 麵包屑：每一層一個（Windows 的最上層 = 「本機」由畫面翻譯）。/ Breadcrumbs, one per level. */
export function crumbsFor(path: string, windows: boolean): Crumb[] {
    if (windows) {
        const out: Crumb[] = [{ label: "", path: "" }];
        const parts = path.split(/[\\/]+/).filter(Boolean);
        let acc = "";
        for (const p of parts) {
            acc = acc === "" ? `${p}\\` : joinRemote(acc, p, true);
            out.push({ label: p, path: acc });
        }
        return out;
    }
    const out: Crumb[] = [{ label: "/", path: "/" }];
    let acc = "";
    for (const p of path.split("/").filter(Boolean)) {
        acc = `${acc}/${p}`;
        out.push({ label: p, path: acc });
    }
    return out;
}

// ---- transfers --------------------------------------------------------------

export type JobKind = "download" | "upload";
/** 整個資料夾下載成 zip 的進度：先數、（太大時）問、下載、收尾。/ A whole-folder zip download's progress. */
export interface FolderJob {
    phase: "listing" | "confirm" | "running" | "finishing";
    files: number;
    bytes: number;
    /** 正在寫第幾個檔案（1 起算）與名稱。/ The file being written (1-based) and its name. */
    current: number;
    currentName: string;
}
export type JobState = "running" | "confirm" | "done" | "failed" | "cancelled";

export interface Job {
    id: number;
    kind: JobKind;
    name: string;
    /** 位元組；下載在核心回報資料夾大小前是 entry 的大小。/ Bytes. */
    total: number;
    done: number;
    /** 位元組 / 秒。/ Bytes per second. */
    speed: number;
    state: JobState;
    error: string | null;
    /** 等使用者決定要不要覆蓋（上傳到已存在的檔案）。/ Waiting for an overwrite decision. */
    confirm?: { fileNum: number; identical: boolean };
    /** 整個資料夾（zip）。/ A whole folder as a zip. */
    folder?: FolderJob;
}

export type JobEvent =
    | { name: "job_progress"; id: string; finished_size?: string; speed?: string }
    | { name: "job_done"; id: string }
    | { name: "job_error"; id: string; err?: string; file_num?: string }
    | { name: "update_folder_files"; info: string }
    | { name: "override_file_confirm"; id: string; file_num?: string; is_identical?: string };

/** 核心的傳輸事件套到工作清單上（沒有的工作不理）。/ Apply one of the core's job events to the list. */
export function applyJobEvent(jobs: Job[], e: JobEvent): Job[] {
    const idOf = (v: string | undefined) => Number(v);
    const patch = (id: number, f: (j: Job) => Job) => (jobs.some((j) => j.id === id) ? jobs.map((j) => (j.id === id ? f(j) : j)) : jobs);
    switch (e.name) {
        case "job_progress": {
            const done = Number(e.finished_size);
            const speed = Number(e.speed);
            return patch(idOf(e.id), (j) => (j.state === "running" ? { ...j, done: Number.isFinite(done) ? Math.max(j.done, done) : j.done, speed: Number.isFinite(speed) ? speed : j.speed } : j));
        }
        case "job_done":
            return patch(idOf(e.id), (j) => ({ ...j, state: "done", done: Math.max(j.done, j.total), speed: 0, confirm: undefined }));
        case "job_error": {
            const err = e.err ?? "";
            return patch(idOf(e.id), (j) => ({ ...j, state: err === "cancel" || err === "skipped" ? "cancelled" : "failed", error: err === "cancel" || err === "skipped" ? null : err || null, speed: 0, confirm: undefined }));
        }
        case "update_folder_files": {
            let info: { id?: unknown; total_size?: unknown } = {};
            try {
                info = JSON.parse(e.info);
            } catch {
                return jobs;
            }
            const total = Number(info.total_size);
            return Number.isFinite(total) && total > 0 ? patch(Number(info.id), (j) => ({ ...j, total })) : jobs;
        }
        case "override_file_confirm":
            return patch(idOf(e.id), (j) => ({ ...j, state: "confirm", confirm: { fileNum: Number(e.file_num) || 0, identical: e.is_identical === "true" } }));
    }
    return jobs;
}

/** 進度百分比（0–100）。/ Progress in percent. */
export function jobPercent(j: Job): number {
    if (j.state === "done") return 100;
    if (j.total <= 0) return 0;
    return Math.min(100, Math.round((j.done / j.total) * 100));
}

/** 還在跑的工作數。/ Jobs still running or waiting. */
export function activeJobs(jobs: Job[]): number {
    return jobs.filter((j) => j.state === "running" || j.state === "confirm").length;
}

/** 太大就不傳。/ Whether a file is within the limit. */
export function withinLimit(size: number): boolean {
    return size <= MAX_TRANSFER_BYTES;
}

/** `1.5 MB` 這類。/ Human-readable bytes. */
export function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n < 0) return "—";
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i += 1;
    }
    return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}
