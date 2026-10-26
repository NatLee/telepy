/**
 * 檔案管理的純函式（無 React）：路徑、副檔名 → 預覽方式 / 編輯器語言、多選、鍵盤對應、權限位元、上傳佇列、
 * 錯誤碼 → 翻譯 key，以及 info 視覺說明（FileFlow）每一段的狀態。`fileManager.test.ts` 有測試。
 * Pure helpers for the file manager: paths, extension → preview kind / editor language, multi-select, the key map,
 * permission bits, the upload queue, error codes → translation keys, and the state of every spot on the FileFlow diagram.
 */
import { statesAlong, type SpotState } from "./flow.ts";
import type { TranslationKey } from "@/locales/en";

/** 編輯器 / 文字預覽的上限（和後端 `ops::TEXT_LIMIT` 一樣）。/ Same as the backend's TEXT_LIMIT. */
export const TEXT_LIMIT = 1024 * 1024;
/** 圖片預覽的上限。/ Largest image previewed. */
export const IMAGE_LIMIT = 10 * 1024 * 1024;
/** 同時上傳幾個。/ Uploads running at once. */
export const UPLOAD_CONCURRENCY = 2;

// ---------------------------------------------------------------- paths

/** 用哪種分隔符：只有反斜線（`C:\x`）就用 `\`，否則 `/`（SFTP 回的路徑一律是 `/`，Windows 也是 `/C:/x`）。 */
function separatorOf(path: string): "/" | "\\" {
    return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

export function joinPath(dir: string, name: string): string {
    const sep = separatorOf(dir);
    return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/** 上一層；已經在最上層（`/`、`~`、`C:\`、`/C:`）回 null。/ The parent, or null at the top. */
export function parentPath(path: string): string | null {
    if (path === "/" || path === "~" || path === "~/") return null;
    const sep = separatorOf(path);
    const trimmed = path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
    if (/^\/?[A-Za-z]:$/.test(trimmed)) return null;
    const i = trimmed.lastIndexOf(sep);
    if (i < 0) return null;
    if (i === 0) return sep;
    const parent = trimmed.slice(0, i);
    if (parent === "~") return "~/";
    // `C:` → `C:\`（磁碟機根目錄要帶分隔符）。/ A bare drive needs its separator.
    if (/^[A-Za-z]:$/.test(parent)) return parent + sep;
    return parent;
}

export function baseName(path: string): string {
    const parts = path.split(/[/\\]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : path;
}

/** 一個檔名可以用嗎（和後端 `ops::valid_name` 一樣）。/ Mirrors the backend's valid_name. */
export function validName(name: string): boolean {
    return name.length > 0 && name !== "." && name !== ".." && new TextEncoder().encode(name).length <= 255 && !/[/\\\0]/.test(name);
}

// ---------------------------------------------------------------- extensions → preview / language

/** 副檔名（小寫、不含點）；`.bashrc` 這種點開頭的檔名沒有副檔名。/ Lower-case extension; dotfiles have none. */
export function extensionOf(name: string): string {
    const i = name.lastIndexOf(".");
    return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export type EditorLanguage =
    | "javascript" | "typescript" | "jsx" | "tsx" | "json" | "python" | "markdown" | "html" | "css" | "yaml" | "xml"
    | "rust" | "go" | "sql" | "shell" | "toml" | "ini" | "dockerfile" | "nginx";

const LANG_BY_EXT: Record<string, EditorLanguage> = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
    json: "json", jsonc: "json", webmanifest: "json",
    py: "python", pyw: "python",
    md: "markdown", markdown: "markdown",
    html: "html", htm: "html", vue: "html", svelte: "html",
    css: "css", scss: "css", less: "css",
    yml: "yaml", yaml: "yaml",
    xml: "xml", svg: "xml", plist: "xml", xsd: "xml",
    rs: "rust", go: "go", sql: "sql",
    sh: "shell", bash: "shell", zsh: "shell", ksh: "shell", profile: "shell",
    toml: "toml", ini: "ini", conf: "ini", cfg: "ini", env: "ini", properties: "ini", service: "ini", timer: "ini", desktop: "ini",
};

const LANG_BY_NAME: Record<string, EditorLanguage> = {
    dockerfile: "dockerfile", containerfile: "dockerfile",
    ".bashrc": "shell", ".bash_profile": "shell", ".profile": "shell", ".zshrc": "shell", ".zprofile": "shell", ".bash_aliases": "shell",
    ".env": "ini", ".gitconfig": "ini", ".editorconfig": "ini",
    "nginx.conf": "nginx",
    "cargo.lock": "toml", "pipfile": "toml",
};

/** 編輯器用哪種語法上色；認不得回 null（純文字）。/ The editor language for a file name; null = plain text. */
export function languageFor(name: string): EditorLanguage | null {
    const lower = name.toLowerCase();
    if (LANG_BY_NAME[lower]) return LANG_BY_NAME[lower];
    if (lower.startsWith("dockerfile.") || lower.endsWith(".dockerfile")) return "dockerfile";
    if (lower.startsWith(".env.")) return "ini";
    return LANG_BY_EXT[extensionOf(lower)] ?? null;
}

const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

/** 圖片的 MIME（不是圖片回 null）。/ The image MIME type, or null. */
export function imageMime(name: string): string | null {
    return IMAGE_MIME[extensionOf(name)] ?? null;
}

/** 一看就知道不是文字的副檔名（不必先讀再被後端拒絕）。/ Extensions that are never text. */
const BINARY_EXT = new Set([
    "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "tar", "jar", "war", "deb", "rpm", "apk", "dmg", "iso", "img",
    "exe", "dll", "so", "dylib", "o", "a", "bin", "class", "pyc", "wasm",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods",
    "mp3", "mp4", "m4a", "mov", "mkv", "avi", "wav", "flac", "ogg", "webm",
    "ico", "bmp", "tif", "tiff", "heic", "psd", "ttf", "otf", "woff", "woff2", "sqlite", "db",
]);

export type PreviewKind = "image" | "text" | "download";

/**
 * 點開一個檔案時做什麼：≤ 10 MiB 的圖片 → 圖片預覽；≤ 1 MiB 且不是已知的二進位格式 → 文字（後端還會看 NUL 判斷）；
 * 其他 → 只能下載。/ What opening a file does: image preview, text, or download only.
 */
export function previewKind(name: string, bytes: number | null | undefined): PreviewKind {
    const size = bytes ?? 0;
    if (imageMime(name)) return size <= IMAGE_LIMIT ? "image" : "download";
    if (BINARY_EXT.has(extensionOf(name))) return "download";
    return size <= TEXT_LIMIT ? "text" : "download";
}

// ---------------------------------------------------------------- selection

/** 多選：選了哪些（依名稱）+ Shift 範圍選取的錨點。/ Multi-select state: selected names + the shift-range anchor. */
export interface Selection {
    names: readonly string[];
    anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { names: [], anchor: null };

export function isSelected(sel: Selection, name: string): boolean {
    return sel.names.includes(name);
}

/** 勾選框 / Ctrl+點：切換一個。/ Toggle one (checkbox, Ctrl/Cmd+click). */
export function toggleSelection(sel: Selection, name: string): Selection {
    return isSelected(sel, name) ? { names: sel.names.filter((n) => n !== name), anchor: name } : { names: [...sel.names, name], anchor: name };
}

/** 只選這一個。/ Select only this one. */
export function selectOnly(name: string): Selection {
    return { names: [name], anchor: name };
}

/** Shift+點：從錨點到這個（依畫面順序）。沒有錨點就只選它。/ Shift+click: from the anchor to this one, in list order. */
export function selectRange(sel: Selection, order: readonly string[], name: string): Selection {
    const from = sel.anchor ? order.indexOf(sel.anchor) : -1;
    const to = order.indexOf(name);
    if (from < 0 || to < 0) return selectOnly(name);
    const [a, b] = from <= to ? [from, to] : [to, from];
    const range = order.slice(a, b + 1);
    return { names: [...sel.names.filter((n) => !range.includes(n)), ...range], anchor: sel.anchor };
}

export function selectAll(order: readonly string[]): Selection {
    return { names: [...order], anchor: order[0] ?? null };
}

/** 重新列目錄後拿掉已經不在的。/ Drop names that are gone after a relist. */
export function pruneSelection(sel: Selection, order: readonly string[]): Selection {
    const names = sel.names.filter((n) => order.includes(n));
    if (names.length === sel.names.length && (!sel.anchor || order.includes(sel.anchor))) return sel;
    return { names, anchor: sel.anchor && order.includes(sel.anchor) ? sel.anchor : null };
}

/** 方向鍵移動游標：到頭停住；沒有游標時往下 = 第一個、往上 = 最後一個。/ Arrow keys move the cursor, clamped. */
export function moveCursor(order: readonly string[], current: string | null, delta: 1 | -1): string | null {
    if (!order.length) return null;
    const i = current ? order.indexOf(current) : -1;
    if (i < 0) return delta > 0 ? order[0] : order[order.length - 1];
    return order[Math.min(order.length - 1, Math.max(0, i + delta))];
}

// ---------------------------------------------------------------- keyboard

export type FileKeyAction = "open" | "up" | "rename" | "delete" | "selectAll" | "next" | "prev" | "clear";

export interface KeyLike {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
}

/**
 * 列表上的按鍵 → 動作：Enter 開啟、Backspace 上一層、F2 改名、Delete（Mac：⌘⌫）刪除、Ctrl/⌘+A 全選、↑↓ 移動、Esc 取消選取。
 * 打字中的輸入框不會走到這裡（呼叫端先過濾）。/ Keys on the list → actions; text fields are filtered out by the caller.
 */
export function fileKeyAction(e: KeyLike): FileKeyAction | null {
    const mod = !!(e.ctrlKey || e.metaKey);
    if (mod && !e.altKey && e.key.toLowerCase() === "a") return "selectAll";
    if (e.metaKey && e.key === "Backspace") return "delete";
    if (mod || e.altKey) return null;
    switch (e.key) {
        case "Enter":
            return "open";
        case "Backspace":
            return "up";
        case "F2":
            return "rename";
        case "Delete":
            return "delete";
        case "ArrowDown":
            return "next";
        case "ArrowUp":
            return "prev";
        case "Escape":
            return "clear";
    }
    return null;
}

/** 提示列上的按鍵（字是 keycap，不翻譯）。/ The keys shown in the hint (keycaps, not translated). */
export const KEY_HINTS: { keys: string; label: TranslationKey }[] = [
    { keys: "Enter", label: "files.key.open" },
    { keys: "⌫", label: "files.key.up" },
    { keys: "F2", label: "files.key.rename" },
    { keys: "Del", label: "files.key.delete" },
    { keys: "Ctrl/⌘ A", label: "files.key.selectAll" },
];

// ---------------------------------------------------------------- permissions

export interface PermBits {
    read: boolean;
    write: boolean;
    exec: boolean;
}

export type PermWho = "user" | "group" | "other";
export const PERM_WHO: readonly PermWho[] = ["user", "group", "other"];

/** 八進位字串 → 數值（`644` / `0755`，≤ 0o7777）；不合法回 null。/ Parse an octal mode (mirrors the backend). */
export function parseMode(s: string): number | null {
    const t = s.trim();
    if (!/^[0-7]{1,5}$/.test(t)) return null;
    const v = parseInt(t, 8);
    return v <= 0o7777 ? v : null;
}

export function modeOctal(mode: number): string {
    return (mode & 0o7777).toString(8).padStart(4, "0");
}

export function modeBits(mode: number): Record<PermWho, PermBits> {
    const at = (shift: number): PermBits => ({ read: !!(mode & (4 << shift)), write: !!(mode & (2 << shift)), exec: !!(mode & (1 << shift)) });
    return { user: at(6), group: at(3), other: at(0) };
}

/** 勾選 → 數值（保留原本的 setuid / setgid / sticky）。/ Checkboxes → mode, keeping the special bits. */
export function bitsToMode(bits: Record<PermWho, PermBits>, special = 0): number {
    const one = (b: PermBits, shift: number) => ((b.read ? 4 : 0) | (b.write ? 2 : 0) | (b.exec ? 1 : 0)) << shift;
    return (special & 0o7000) | one(bits.user, 6) | one(bits.group, 3) | one(bits.other, 0);
}

/** `-rw-r--r--` 這種字串 → 數值（列表沒有八進位時用）。/ A `ls -l` string → mode. */
export function modeFromString(s: string | undefined | null): number | null {
    if (!s || s.length < 10) return null;
    let m = 0;
    const set = (i: number, bit: number) => { if (s[i] !== "-" && s[i] !== "S" && s[i] !== "T") m |= bit; };
    [[1, 0o400], [2, 0o200], [3, 0o100], [4, 0o040], [5, 0o020], [6, 0o010], [7, 0o004], [8, 0o002], [9, 0o001]].forEach(([i, b]) => set(i, b));
    if (s[3] === "s" || s[3] === "S") m |= 0o4000;
    if (s[6] === "s" || s[6] === "S") m |= 0o2000;
    if (s[9] === "t" || s[9] === "T") m |= 0o1000;
    return m;
}

// ---------------------------------------------------------------- uploads

export type UploadState = "queued" | "uploading" | "done" | "failed";

export interface UploadJob {
    id: number;
    name: string;
    size: number;
    loaded: number;
    state: UploadState;
    /** 上傳到哪個資料夾（排隊時的目前目錄）。/ The folder it goes into (the current one when queued). */
    dir: string;
    error?: string;
}

/** 接下來要開始哪幾個（同時最多 `limit` 個，照排隊順序）。/ Which queued jobs to start next. */
export function nextUploads(jobs: readonly UploadJob[], limit = UPLOAD_CONCURRENCY): number[] {
    const running = jobs.filter((j) => j.state === "uploading").length;
    const room = Math.max(0, limit - running);
    return jobs.filter((j) => j.state === "queued").slice(0, room).map((j) => j.id);
}

export interface UploadSummary {
    total: number;
    done: number;
    failed: number;
    active: number;
    /** 0–100，用位元組算。/ By bytes. */
    percent: number;
}

export function uploadSummary(jobs: readonly UploadJob[]): UploadSummary {
    const bytes = jobs.reduce((s, j) => s + j.size, 0);
    const loaded = jobs.reduce((s, j) => s + (j.state === "done" ? j.size : Math.min(j.loaded, j.size)), 0);
    return {
        total: jobs.length,
        done: jobs.filter((j) => j.state === "done").length,
        failed: jobs.filter((j) => j.state === "failed").length,
        active: jobs.filter((j) => j.state === "queued" || j.state === "uploading").length,
        percent: bytes > 0 ? Math.round((loaded / bytes) * 100) : jobs.length && jobs.every((j) => j.state === "done") ? 100 : 0,
    };
}

// ---------------------------------------------------------------- errors

const ERROR_KEYS: Record<string, TranslationKey> = {
    path_required: "files.err.path_required",
    invalid_name: "files.err.invalid_name",
    exists: "files.err.exists",
    not_found: "files.err.not_found",
    permission_denied: "files.err.permission_denied",
    dir_not_writable: "files.err.dir_not_writable",
    protected: "files.err.protected",
    into_itself: "files.err.into_itself",
    invalid_mode: "files.err.invalid_mode",
    is_directory: "files.err.is_directory",
    too_large: "files.err.too_large",
    binary: "files.err.binary",
    not_utf8: "files.err.not_utf8",
    modified: "files.err.modified",
    timeout: "files.err.timeout",
    device: "files.err.device",
    failed: "files.err.failed",
    step_up_required: "files.err.step_up_required",
};

/** 後端的 `code` → 翻譯 key；認不得回 null（顯示後端原文）。/ Backend code → key; null = show the backend text. */
export function fileErrorKey(code: string | null | undefined): TranslationKey | null {
    return code ? ERROR_KEYS[code] ?? null : null;
}

// ---------------------------------------------------------------- the FileFlow diagram

/** 示意圖的位置：你的瀏覽器 ─web─ Telepy ─channel─ 裝置帳號。/ Spots on the path. */
export type FileSpot = "browser" | "web" | "telepy" | "channel" | "account";
export type { SpotState };
const SPOTS: readonly FileSpot[] = ["browser", "web", "telepy", "channel", "account"];

/**
 * 連線狀態：connecting / open / retrying（斷了、等一下重連）/ offline（4005 裝置離線）/ stepup（4008 要先確認是你）/
 * stopped（權限之類，不會重連）。/ The socket's state as the diagram sees it.
 */
export type FileLink = "connecting" | "open" | "retrying" | "offline" | "stepup" | "stopped";

/** 關閉碼 → 狀態。/ A close code → the link state. */
export function linkFromClose(code: number): FileLink {
    if (code === 4005) return "offline";
    if (code === 4008) return "stepup";
    if ([4000, 4001, 4002, 4003, 4004, 4006, 4009].includes(code)) return "stopped";
    return "retrying";
}

export type BusyKind = "listing" | "uploading" | "deleting" | "counting" | "moving" | "copying" | "renaming" | "chmod" | "saving" | "reading" | "creating" | "downloading";

export interface Busy {
    kind: BusyKind;
    /** 幾個項目（上傳 / 刪除 / 搬移…）。/ How many items. */
    count?: number;
}

/**
 * 每一段的狀態：連線中 → 前兩段在進行；開著 → 全通，有操作在跑時 channel 與帳號那兩段「進行中」；
 * 裝置離線 → 卡在隧道（channel）；要 step-up → 卡在 Telepy；斷線 / 停止 → 卡在 web 那段。
 * The state of every spot for a link state and the operation in flight.
 */
export function fileSpotStates(link: FileLink, busy: Busy | null): Record<FileSpot, SpotState> {
    switch (link) {
        case "connecting":
            return statesAlong(SPOTS, { activeFrom: "web", activeTo: "telepy" });
        case "offline":
            return statesAlong(SPOTS, { failedAt: "channel" });
        case "stepup":
            return statesAlong(SPOTS, { failedAt: "telepy" });
        case "retrying":
        case "stopped":
            return statesAlong(SPOTS, { failedAt: "web" });
        case "open":
            return busy ? statesAlong(SPOTS, { activeFrom: "channel", activeTo: "account" }) : statesAlong(SPOTS, { done: true });
    }
}

const BUSY_KEYS: Record<BusyKind, TranslationKey> = {
    listing: "files.flow.busy.listing",
    uploading: "files.flow.busy.uploading",
    deleting: "files.flow.busy.deleting",
    counting: "files.flow.busy.counting",
    moving: "files.flow.busy.moving",
    copying: "files.flow.busy.copying",
    renaming: "files.flow.busy.renaming",
    chmod: "files.flow.busy.chmod",
    saving: "files.flow.busy.saving",
    reading: "files.flow.busy.reading",
    creating: "files.flow.busy.creating",
    downloading: "files.flow.busy.downloading",
};

/** 「現在在做什麼」那一行。/ The "happening now" line. */
export function flowNow(link: FileLink, busy: Busy | null): { key: TranslationKey; vars?: Record<string, string | number> } {
    switch (link) {
        case "connecting":
            return { key: "files.flow.now.connecting" };
        case "offline":
            return { key: "files.flow.now.offline" };
        case "stepup":
            return { key: "files.flow.now.stepup" };
        case "retrying":
            return { key: "files.flow.now.retrying" };
        case "stopped":
            return { key: "files.flow.now.stopped" };
        case "open":
            return busy ? { key: BUSY_KEYS[busy.kind], vars: { count: busy.count ?? 1 } } : { key: "files.flow.now.idle" };
    }
}

/** 人看的大小。/ Human-readable size. */
export function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n < 0) return "";
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
