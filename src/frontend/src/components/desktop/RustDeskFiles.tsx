"use client";

/**
 * 網頁內 RustDesk 的「檔案」面板：列出遠端那台的資料夾、下載（檔案，或整個資料夾打包成 zip）、上傳（檔案或資料夾）、
 * 改名 / 搬移、刪除（可多選；資料夾連內容一起，先數再確認）、新資料夾，附進度。
 * - RustDesk 的傳檔是另一條連線（登入成 file_transfer），所以先向 `POST …/rustdesk/{sid}/files` 要一個子 session，
 *   再用 RustDesk 核心自己的檔案 API（`read_remote_dir` / `send_files` / `select_files` + `send_local_files` /
 *   `read_dir_to_remove_recursive` / `remove_file` / `remove_all_empty_dirs` / `rename_file` / `create_dir`）。
 * - 核心是 window 上的全域物件，而且同一個核心裡「最上面」的 session 才拿得到畫面：檔案 session 若開在畫面那個
 *   核心裡，遠端畫面就停了。所以這裡在一個看不見的同源 iframe 裡再載一份核心，各管各的。
 * - 存檔 / 選檔對話框要使用者的點擊：在這一頁（點擊發生的地方）開，再交給 iframe 裡的核心（存檔把手、選好的 File）。
 *   沒有存檔對話框的瀏覽器（Firefox / Safari）由核心整個放記憶體再下載，所以有 2 GB 的上限。
 * - 下載資料夾：核心向 `showDirectoryPicker()` 要資料夾把手再逐檔寫入；這裡換成一個假把手，把每個檔案串流進
 *   瀏覽器裡現做的 zip（`lib/zipStream`），寫進使用者選的 .zip（或記憶體）。空資料夾用 `ReadEmptyDirs` 問
 *   （核心沒有送出的呼叫：面板自己編那一則，從 iframe 的 WebSocket 送）。
 * - Telepy 只中繼：中繼只准這條登入成傳檔（`codec::LoginGuard`），刪除與改名記進 tunnel 的 Logs（只有路徑與數量）。
 * The in-browser RustDesk Files panel. RustDesk transfers files on a second connection, so the panel asks for a files
 * child session and drives the core's own file API. A second copy of the core runs in a hidden same-origin iframe:
 * inside one core only the top-most session gets video, so a files session there would freeze the picture.
 * Pickers need the user's click, so they open in this page and the handle / files are handed to the iframe's core.
 * Folder downloads hand the core a look-alike directory handle that streams every file into a zip made here.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, CheckCircle2, Download, Eye, EyeOff, File as FileIcon, Folder, FolderPlus, FolderUp, HardDrive, Home, Info, Loader2, MoreHorizontal, PencilLine, RefreshCw, Trash2, Upload, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { apiFetch, readJson } from "@/lib/api";
import { getWsOrigin } from "@/lib/wsCommon";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { classifyMsgbox, peerIdFor, RUSTDESK_CORE_URL, rustdeskCloseFailure, rustdeskWsUrl, type RustDeskCore, type RustDeskFilesStart, type RustDeskStart } from "@/lib/rustdesk";
import { activeJobs, applyJobEvent, crumbsFor, formatBytes, isWindowsPeer, joinRemote, jobPercent, parentRemote, parseFileDir, withinLimit, type Job, type JobEvent, type RemoteDir, type RemoteEntry } from "@/lib/rustdeskFiles";
import {
    deleteSteps, deleteSummary, emptyDirsPath, fileDirId, freeName, IDLE_ACTIVITY, isExistsError, missingFiles, needsConfirm, parseEmptyDirs, parseRecursiveListing, planRename, planUpload,
    readEmptyDirsMessage, remoteFromRel, selectionKinds, tooLargeForMemory, transferActivity, validName, withActivity, zipPlan, MEMORY_ZIP_CAP,
    type DeleteItem, type FileActivity, type LocalItem, type RecursiveListing, type RenameProblem, type ZipPlan,
} from "@/lib/rustdeskFileOps";
import { collectZip, ZipCollector, zipDirectoryHandle, ZipTooLarge } from "@/lib/zipStream";
import { RustDeskFilesFlowDialog } from "./RustDeskFilesFlow";
import type { TranslationKey } from "@/locales/en";

type FrameWindow = Window & typeof globalThis & Partial<RustDeskCore> & {
    onGlobalEvent?: ((json: string) => void) | null;
    onInitFinished?: (() => void) | null;
    showSaveFilePicker?: (opts?: { suggestedName?: string }) => Promise<unknown>;
    showDirectoryPicker?: (opts?: unknown) => Promise<unknown>;
};

type SaveFilePicker = (opts?: { suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>;

/** 一個動作等裝置回答多久（遞迴列出大資料夾要更久）。/ How long an action waits for the device's answer. */
const OP_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 120_000;
/** `ReadEmptyDirs` 舊版 RustDesk 不認得：等這麼久沒回答就當沒有空資料夾。/ Older RustDesk ignores ReadEmptyDirs. */
const EMPTY_DIRS_TIMEOUT_MS = 4_000;

/** 看不見的同源 iframe + 一份自己的核心。/ A hidden same-origin iframe with its own copy of the core. */
function createCoreFrame(): Promise<{ frame: HTMLIFrameElement; win: FrameWindow }> {
    return new Promise((resolve, reject) => {
        const frame = document.createElement("iframe");
        frame.setAttribute("aria-hidden", "true");
        frame.tabIndex = -1;
        frame.title = "rustdesk-files";
        frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden;";
        document.body.appendChild(frame);
        const win = frame.contentWindow as FrameWindow | null;
        const doc = frame.contentDocument;
        if (!win || !doc) {
            frame.remove();
            reject(new Error("no iframe document"));
            return;
        }
        const s = doc.createElement("script");
        s.src = new URL(RUSTDESK_CORE_URL, window.location.href).href;
        s.onload = () => (typeof win.init === "function" && typeof win.setByName === "function" ? resolve({ frame, win }) : reject(new Error("core did not install")));
        s.onerror = () => reject(new Error("core failed to load"));
        (doc.head ?? doc.documentElement).appendChild(s);
    });
}

/**
 * 核心的 select_files 會建一個 <input type=file> 再 click()；那個 click 不在使用者的手勢裡（手勢在這一頁），
 * 所以把 iframe 裡的 click 換成「放進這一頁已經選好的檔案」。沒有待傳的檔案時照原本的行為。
 * The core's select_files creates a file input and clicks it outside any user gesture; hand it the files already
 * picked in this page instead. Without pending files the native click runs.
 */
function patchFileInput(win: FrameWindow, take: () => File[] | null) {
    const proto = win.HTMLInputElement.prototype;
    const nativeClick = proto.click;
    proto.click = function patchedClick(this: HTMLInputElement) {
        const files = this.type === "file" ? take() : null;
        if (files) {
            const dt = new win.DataTransfer();
            for (const f of files) dt.items.add(f);
            this.files = dt.files;
            this.onchange?.(new win.Event("change"));
            return;
        }
        nativeClick.call(this);
    };
}

/**
 * 記住核心最後開的那條 WebSocket（relay 角色那條），讓面板能送核心沒提供呼叫的那一則（`ReadEmptyDirs`）。
 * Remember the core's latest WebSocket (the relay one) so the panel can send the one message the core has no call for.
 */
function trackSockets(win: FrameWindow): (bytes: Uint8Array) => boolean {
    const Native = win.WebSocket;
    let latest: WebSocket | null = null;
    const Tracked = function Tracked(url: string | URL, protocols?: string | string[]) {
        const ws = new Native(url, protocols);
        latest = ws;
        return ws;
    } as unknown as typeof WebSocket;
    Object.assign(Tracked, { CONNECTING: Native.CONNECTING, OPEN: Native.OPEN, CLOSING: Native.CLOSING, CLOSED: Native.CLOSED });
    Tracked.prototype = Native.prototype;
    win.WebSocket = Tracked;
    return (bytes) => {
        if (!latest || latest.readyState !== Native.OPEN) return false;
        latest.send(bytes);
        return true;
    };
}

/** 拖進來的東西（可能有資料夾）→ 檔案 + 相對路徑 + 空資料夾。/ Dropped items, folders included. */
async function readDropped(dt: DataTransfer): Promise<{ items: LocalItem[]; emptyDirs: string[] }> {
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

/** 存一個 Blob（沒有存檔對話框時）。/ Save a blob through a download link. */
function saveBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
    }, 60_000);
}

type Phase = "starting" | "connecting" | "ready" | "failed";

const START_ERROR: Record<string, TranslationKey> = {
    file_transfer_disabled: "desktop.files.err.disabled",
    not_connected: "desktop.files.err.notConnected",
    desktop_disabled: "desktop.err.disabled",
    device_offline: "desktop.err.deviceOffline",
    target_unreachable: "desktop.err.rdDirectIpOff",
};

const RENAME_PROBLEM: Record<RenameProblem, TranslationKey> = {
    empty: "desktop.files.rename.empty",
    same: "desktop.files.rename.same",
    dots: "desktop.files.rename.dots",
    trailing: "desktop.files.rename.trailing",
};

interface Waiter {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
}

/** 進行中的資料夾 zip 下載。/ A folder zip download in progress. */
interface FolderCtl {
    zip: ZipCollector;
    plan: ZipPlan;
    output: Promise<void>;
    finish: () => void;
    fail: (err: string) => void;
}

interface Busy {
    key: TranslationKey;
    done: number;
    total: number;
}

interface Props {
    /** 畫面那條 session。/ The screen session. */
    parent: RustDeskStart;
    /** RustDesk 的密碼（檔案連線也要登入）。/ The RustDesk password (the files connection logs in too). */
    password: string;
    onClose: () => void;
    /** 面板狀態（說明圖用）。/ The panel's state, for the info diagram. */
    onStateChange?: (open: boolean) => void;
    /** 各種檔案動作的狀態（資料流圖用）。/ The state of each kind of file action, for the streams diagram. */
    onActivity?: (a: FileActivity) => void;
    /** 裝置名稱（說明圖用）。/ The device's name, for the info diagram. */
    deviceName?: string;
}

export function RustDeskFiles({ parent, password, onClose, onStateChange, onActivity, deviceName }: Props) {
    const { t, locale } = useI18n();
    const [phase, setPhase] = useState<Phase>("starting");
    const [failure, setFailure] = useState<TranslationKey | null>(null);
    const [failureText, setFailureText] = useState("");
    const [dir, setDir] = useState<RemoteDir | null>(null);
    const [home, setHome] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [showHidden, setShowHidden] = useState(false);
    const [jobs, setJobs] = useState<Job[]>([]);
    const [platform, setPlatform] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(() => new Set());
    const [busy, setBusy] = useState<Busy | null>(null);
    const [opActivity, setOpActivity] = useState<FileActivity>(IDLE_ACTIVITY);
    const [deleteAsk, setDeleteAsk] = useState<DeleteItem[] | null>(null);
    const [renaming, setRenaming] = useState<RemoteEntry | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState("");
    const [flowOpen, setFlowOpen] = useState(false);
    const winRef = useRef<FrameWindow | null>(null);
    const dirRef = useRef<RemoteDir | null>(null);
    const jobId = useRef(1);
    const pendingFiles = useRef<File[] | null>(null);
    const relQueue = useRef<string[]>([]);
    const uploadTarget = useRef(new Map<number, string>());
    const waiters = useRef(new Map<number, Waiter>());
    const emptyWaiters = useRef(new Map<string, (dirs: string[]) => void>());
    const folderJobs = useRef(new Map<number, FolderCtl>());
    const confirmFolder = useRef(new Map<number, (go: boolean) => void>());
    const sendRaw = useRef<((bytes: Uint8Array) => boolean) | null>(null);
    const fileInput = useRef<HTMLInputElement | null>(null);
    const folderInput = useRef<HTMLInputElement | null>(null);
    const showHiddenRef = useRef(showHidden);
    const passwordRef = useRef(password);
    // t 換語言時會變；連線只建一次，所以從 ref 讀。/ `t` changes with the language; the connection is built once.
    const tRef = useRef(t);
    const windows = isWindowsPeer(platform);
    const windowsRef = useRef(windows);
    useEffect(() => {
        dirRef.current = dir;
        tRef.current = t;
        showHiddenRef.current = showHidden;
        windowsRef.current = windows;
    });

    const call = useCallback((name: string, arg?: unknown) => {
        const w = winRef.current;
        if (!w?.setByName) return;
        w.setByName(name, typeof arg === "string" || arg === undefined ? arg : JSON.stringify(arg));
    }, []);

    const open = useCallback((path: string) => {
        setLoading(true);
        setSelected(new Set());
        call("read_remote_dir", { path, include_hidden: showHiddenRef.current });
    }, [call]);
    const refresh = useCallback(() => {
        const cur = dirRef.current;
        if (cur) open(cur.path);
    }, [open]);

    /** 送一個核心呼叫、等裝置對這個 id 的 done / error。/ Call the core and wait for the device's answer to `id`. */
    const runOp = useCallback((name: string, arg: Record<string, unknown>, id: number, timeout = OP_TIMEOUT_MS) => new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
            if (waiters.current.get(id)?.resolve === wrapped) {
                waiters.current.delete(id);
                reject(new Error(tRef.current("desktop.files.noAnswer")));
            }
        }, timeout);
        const wrapped = (v: unknown) => {
            clearTimeout(timer);
            resolve(v);
        };
        waiters.current.set(id, { resolve: wrapped, reject: (e) => { clearTimeout(timer); reject(e); } });
        call(name, arg);
    }), [call]);

    /** 遞迴列出一個資料夾（`ReadAllFiles`）。/ List a folder recursively. */
    const listRecursive = useCallback((id: number, path: string, includeHidden: boolean) =>
        runOp("read_dir_to_remove_recursive", { id, path, show_hidden: includeHidden }, id, LIST_TIMEOUT_MS) as Promise<RecursiveListing>, [runOp]);

    /** 資料夾底下的空資料夾（舊版 RustDesk 不回答 → 空清單）。/ Empty folders under a folder. */
    const readEmptyDirs = useCallback((path: string, includeHidden: boolean) => new Promise<string[]>((resolve) => {
        const send = sendRaw.current;
        if (!send || !send(readEmptyDirsMessage(path, includeHidden))) {
            resolve([]);
            return;
        }
        const timer = setTimeout(() => {
            emptyWaiters.current.delete(path);
            resolve([]);
        }, EMPTY_DIRS_TIMEOUT_MS);
        emptyWaiters.current.set(path, (dirs) => {
            clearTimeout(timer);
            emptyWaiters.current.delete(path);
            resolve(dirs);
        });
    }), []);

    const activity = useMemo<FileActivity>(() => ({ ...opActivity, download: transferActivity(jobs, "download"), upload: transferActivity(jobs, "upload") }), [opActivity, jobs]);
    useEffect(() => {
        onActivity?.(activity);
    }, [activity, onActivity]);
    useEffect(() => () => onActivity?.(IDLE_ACTIVITY), [onActivity]);

    useEffect(() => {
        onStateChange?.(true);
        return () => onStateChange?.(false);
    }, [onStateChange]);

    useEffect(() => {
        let disposed = false;
        let frame: HTMLIFrameElement | null = null;
        // 這次開的子 session；還沒連上就被收掉時請後端作廢票證。/ This run's child session; voided when dropped unconnected.
        let childId: string | null = null;
        let childConnected = false;
        const pending = waiters.current;
        const folders = folderJobs.current;
        const fail = (key: TranslationKey, text = "") => {
            if (disposed) return;
            setFailure(key);
            setFailureText(text);
            setPhase("failed");
            setLoading(false);
        };
        (async () => {
            const res = await apiFetch(`/api/reverse/server/rustdesk/${parent.session_id}/files`, { method: "POST", body: "{}" }).catch(() => null);
            if (!res) return fail("desktop.err.network");
            const data = await readJson<RustDeskFilesStart & { code?: string; error?: string }>(res);
            if (!res.ok || !data?.ticket) return fail(START_ERROR[data?.code ?? ""] ?? "desktop.files.err.start", data?.error ?? "");
            childId = data.session_id;
            if (disposed) {
                void apiFetch(`/api/reverse/server/rustdesk/${data.session_id}/stop`, { method: "POST", body: "{}" }).catch(() => undefined);
                return;
            }
            setPhase("connecting");
            let made: { frame: HTMLIFrameElement; win: FrameWindow };
            try {
                made = await createCoreFrame();
            } catch {
                return fail("desktop.err.rdCore");
            }
            frame = made.frame;
            const win = made.win;
            if (disposed) {
                frame.remove();
                return;
            }
            winRef.current = win;
            sendRaw.current = trackSockets(win);
            // 上傳：核心的 select_files 會建一個 <input type=file> 再 click()；那個 click 不在使用者的手勢裡，
            // 所以換成「把這一頁選好的檔案放進去」。/ Uploads: hand the files picked in this page to the core's input.
            patchFileInput(win, () => {
                const files = pendingFiles.current;
                pendingFiles.current = null;
                return files;
            });
            win.onGlobalEvent = (json: string) => {
                let e: Record<string, unknown>;
                try {
                    e = JSON.parse(json);
                } catch {
                    return;
                }
                const name = String(e.name ?? "");
                switch (name) {
                    case "peer_info":
                        childConnected = true;
                        setPlatform(String(e.platform ?? ""));
                        setPhase("ready");
                        // 登入後裝置不一定主動送第一個清單：自己要一次（空路徑 = 家目錄）。/ Ask for the first listing (empty = home).
                        if (!dirRef.current) call("read_remote_dir", { path: "", include_hidden: showHiddenRef.current });
                        break;
                    case "file_dir": {
                        if (e.is_local === "true") break;
                        // 帶 id 的是遞迴列出的回答（下載 / 刪除資料夾前）。/ One with an id answers a recursive listing.
                        const listId = fileDirId(e.value);
                        const w = listId ? pending.get(listId) : undefined;
                        if (w) {
                            pending.delete(listId);
                            const listing = parseRecursiveListing(e.value);
                            if (listing) w.resolve(listing);
                            else w.reject(new Error("bad listing"));
                            break;
                        }
                        const d = parseFileDir(e.value);
                        if (!d) break;
                        setDir(d);
                        setHome((h) => h ?? d.path);
                        setLoading(false);
                        setPhase("ready");
                        break;
                    }
                    case "empty_dirs": {
                        const p = emptyDirsPath(e.value);
                        const w = p !== null ? emptyWaiters.current.get(p) : undefined;
                        if (w && p !== null) w(parseEmptyDirs(e.value, p) ?? []);
                        break;
                    }
                    case "job_done":
                    case "job_error": {
                        const id = Number(e.id);
                        const w = pending.get(id);
                        if (w) {
                            // 刪除 / 改名 / 建資料夾 / 列出：等著的那一方收下。/ A waiting action takes it.
                            pending.delete(id);
                            if (name === "job_done") w.resolve(undefined);
                            else w.reject(new Error(String(e.err ?? "") || "error"));
                            break;
                        }
                        const folder = folders.get(id);
                        if (folder) {
                            if (name === "job_done") folder.finish();
                            else folder.fail(String(e.err ?? ""));
                            break;
                        }
                        setJobs((list) => applyJobEvent(list, e as unknown as JobEvent));
                        // 上傳完成 → 重讀它所在的資料夾。/ An upload finished: re-read its folder.
                        if (name === "job_done") {
                            const target = uploadTarget.current.get(id);
                            const cur = dirRef.current;
                            if (target && cur && parentRemote(target, windowsRef.current) === cur.path) open(cur.path);
                        }
                        break;
                    }
                    case "job_progress":
                    case "update_folder_files":
                    case "override_file_confirm":
                        setJobs((list) => applyJobEvent(list, e as unknown as JobEvent));
                        break;
                    case "selected_files": {
                        let f: { name?: string; size?: number } = {};
                        try {
                            f = JSON.parse(String(e.file ?? "{}"));
                        } catch {
                            break;
                        }
                        const cur = dirRef.current;
                        // 資料夾上傳：相對路徑按選檔的順序排好了。/ Folder uploads: relative paths queued in order.
                        const rel = relQueue.current.shift();
                        const fileName = rel ?? String(f.name ?? "file");
                        const size = Number(f.size) || 0;
                        const id = jobId.current++;
                        if (!cur) break;
                        if (!withinLimit(size)) {
                            setJobs((list) => [...list, { id, kind: "upload", name: fileName, total: size, done: 0, speed: 0, state: "failed", error: tRef.current("desktop.files.tooLarge") }]);
                            break;
                        }
                        const to = rel ? remoteFromRel(cur.path, rel, windowsRef.current) : joinRemote(cur.path, fileName, windowsRef.current);
                        uploadTarget.current.set(id, to);
                        setJobs((list) => [...list, { id, kind: "upload", name: fileName, total: size, done: 0, speed: 0, state: "running", error: null }]);
                        call("send_local_files", { id, handle_index: String(e.handleIndex ?? ""), to });
                        break;
                    }
                    case "msgbox": {
                        const m = { type: String(e.type ?? ""), title: String(e.title ?? ""), text: String(e.text ?? "") };
                        const closed = /WebSocket closed \((\d+)\)/.exec(m.text);
                        if (closed) {
                            const code = Number(closed[1]);
                            if (code === 4403) fail("desktop.files.err.refused");
                            else if (code === 4014) fail("desktop.files.err.ended");
                            else fail(rustdeskCloseFailure(code)?.key ?? "desktop.files.err.ended");
                            break;
                        }
                        if (m.type === "success") break;
                        const action = classifyMsgbox(m);
                        // 核心先發事件、之後才等答案：下一個 tick 再答。/ The core stores the resolver after emitting: answer next tick.
                        if (action.kind === "continue") setTimeout(() => call("common", { name: "continue-insecure-connection", value: "Y" }), 0);
                        else if (action.kind === "failure") fail(action.failure.key, m.text);
                        break;
                    }
                    default:
                        break;
                }
            };
            if (!win.rdCore?.ready) {
                await new Promise<void>((resolve) => {
                    win.onInitFinished = () => resolve();
                    win.init?.();
                });
            }
            if (disposed) return;
            const url = rustdeskWsUrl(getWsOrigin(), data);
            call("option", { name: "custom-rendezvous-server", value: url });
            call("option", { name: "relay-server", value: url });
            call("option", { name: "key", value: "" });
            call("session_add_sync", { id: peerIdFor(data), password: passwordRef.current, isFileTransfer: true, isTerminal: false });
            call("session_start", { id: peerIdFor(data) });
        })();
        return () => {
            disposed = true;
            const w = winRef.current;
            if (w?.setByName) {
                try {
                    w.setByName("session_close", "");
                } catch {
                    // 已經關了。/ Already closed.
                }
            }
            if (w) w.onGlobalEvent = null;
            winRef.current = null;
            sendRaw.current = null;
            for (const x of pending.values()) x.reject(new Error("closed"));
            pending.clear();
            for (const f of folders.values()) f.zip.abort(new Error("closed"));
            folders.clear();
            frame?.remove();
            if (childId && !childConnected) void apiFetch(`/api/reverse/server/rustdesk/${childId}/stop`, { method: "POST", body: "{}", keepalive: true }).catch(() => undefined);
        };
    }, [parent.session_id, call, open]);

    const patchJob = (id: number, f: (j: Job) => Job) => setJobs((list) => list.map((j) => (j.id === id ? f(j) : j)));

    const download = async (entry: RemoteEntry) => {
        const cur = dirRef.current;
        if (!cur || entry.isDir) return;
        if (!withinLimit(entry.size)) {
            setNotice(t("desktop.files.tooLarge"));
            return;
        }
        const w = winRef.current;
        if (!w) return;
        // 存檔對話框在這一頁開（點擊在這裡），把手交給 iframe 裡的核心。/ Open the save dialog here, hand the handle over.
        const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
        let restore: (() => void) | null = null;
        if (picker) {
            let handle: unknown;
            try {
                handle = await picker.call(window, { suggestedName: entry.name });
            } catch (err) {
                if ((err as { name?: string })?.name === "AbortError") return;
                handle = null;
            }
            if (handle) {
                const before = w.showSaveFilePicker;
                w.showSaveFilePicker = async () => handle;
                restore = () => {
                    w.showSaveFilePicker = before;
                };
            }
        }
        const id = jobId.current++;
        setJobs((list) => [...list, { id, kind: "download", name: entry.name, total: entry.size, done: 0, speed: 0, state: "running", error: null }]);
        call("send_files", { id, path: joinRemote(cur.path, entry.name, windows), include_hidden: false, is_remote: true, is_dir: false });
        setTimeout(() => restore?.(), 0);
    };

    /**
     * 整個資料夾 → zip：存檔對話框（要在點擊裡開）→ 遞迴列出 + 空資料夾 → 太多 / 太大先問 → 核心逐檔下載，
     * 每個檔案串流進 zip → 補上空檔案 / 空資料夾 → 收尾。
     * A whole folder as a zip: save dialog (inside the click), recursive listing + empty folders, ask when large,
     * the core downloads file by file into the zip, then empty files / folders are added and the zip is closed.
     */
    const downloadFolder = async (entry: RemoteEntry) => {
        const cur = dirRef.current;
        const w = winRef.current;
        if (!cur || !w || !entry.isDir) return;
        const path = joinRemote(cur.path, entry.name, windows);
        const zipName = `${entry.name.replace(/[\\/:]+/g, "_") || "folder"}.zip`;
        const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
        let writable: WritableStream<Uint8Array> | null = null;
        if (picker) {
            try {
                const handle = await picker.call(window, { suggestedName: zipName, types: [{ description: "ZIP", accept: { "application/zip": [".zip"] } }] });
                writable = await handle.createWritable();
            } catch (err) {
                if ((err as { name?: string })?.name === "AbortError") return;
                writable = null;
            }
        }
        const id = jobId.current++;
        const includeHidden = showHiddenRef.current;
        setJobs((list) => [...list, { id, kind: "download", name: zipName, total: 0, done: 0, speed: 0, state: "running", error: null, folder: { phase: "listing", files: 0, bytes: 0, current: 0, currentName: "" } }]);
        const failJob = (error: string | null, cancelled = false) => {
            void writable?.abort().catch(() => undefined);
            patchJob(id, (j) => ({ ...j, state: cancelled ? "cancelled" : "failed", error, speed: 0 }));
        };
        let listing: RecursiveListing;
        let empty: string[];
        try {
            listing = await listRecursive(id, path, includeHidden);
            empty = await readEmptyDirs(path, includeHidden);
        } catch (err) {
            failJob((err as Error).message);
            return;
        }
        const plan = zipPlan(entry.name, listing.files, empty);
        patchJob(id, (j) => ({ ...j, total: plan.totalBytes, folder: { ...j.folder!, files: plan.fileCount, bytes: plan.totalBytes } }));
        if (!writable && tooLargeForMemory(plan)) {
            failJob(t("desktop.files.folderTooLarge", { size: formatBytes(MEMORY_ZIP_CAP) }));
            return;
        }
        if (needsConfirm(plan)) {
            patchJob(id, (j) => ({ ...j, folder: { ...j.folder!, phase: "confirm" } }));
            const go = await new Promise<boolean>((resolve) => confirmFolder.current.set(id, resolve));
            confirmFolder.current.delete(id);
            if (!go) {
                failJob(null, true);
                return;
            }
        }
        const zip = new ZipCollector();
        zip.onFile = (i, name) => patchJob(id, (j) => ({ ...j, folder: { ...j.folder!, current: i + 1, currentName: name.slice(plan.root.length + 1) } }));
        const output = writable ? zip.stream.pipeTo(writable) : collectZip(zip.stream, MEMORY_ZIP_CAP).then((blob) => saveBlob(blob, zipName));
        const finish = () => {
            folderJobs.current.delete(id);
            patchJob(id, (j) => ({ ...j, folder: { ...j.folder!, phase: "finishing" } }));
            for (const f of missingFiles(plan, zip.names)) zip.addEmptyFile(f.name, f.modified ? new Date(f.modified * 1000) : undefined);
            for (const d of plan.folders) zip.addFolder(d);
            zip.finish();
            output.then(
                () => patchJob(id, (j) => ({ ...j, state: "done", done: j.total, speed: 0, folder: { ...j.folder!, phase: "finishing" } })),
                (err) => failJob(err instanceof ZipTooLarge ? t("desktop.files.folderTooLarge", { size: formatBytes(MEMORY_ZIP_CAP) }) : String((err as Error)?.message ?? err)),
            );
        };
        const ctl: FolderCtl = {
            zip,
            plan,
            output,
            finish,
            fail: (err) => {
                folderJobs.current.delete(id);
                zip.abort(new Error(err || "cancel"));
                output.catch(() => undefined);
                if (err === "cancel" || err === "skipped") failJob(null, true);
                else failJob(err || null);
            },
        };
        output.catch(() => undefined);
        if (plan.fileCount === 0) {
            // 沒有檔案（只有空資料夾）：不用核心下載。/ No files at all: nothing for the core to download.
            finish();
            return;
        }
        folderJobs.current.set(id, ctl);
        patchJob(id, (j) => ({ ...j, folder: { ...j.folder!, phase: "running" } }));
        // 核心向 showDirectoryPicker 要資料夾把手：換成寫進 zip 的假把手。/ Hand the core the zip-backed directory handle.
        const before = w.showDirectoryPicker;
        w.showDirectoryPicker = async () => zipDirectoryHandle(zip, plan.root);
        call("send_files", { id, path, include_hidden: includeHidden, is_remote: true, is_dir: true });
        setTimeout(() => {
            w.showDirectoryPicker = before;
        }, 0);
    };

    const upload = (files: File[], rels?: string[]) => {
        if (files.length === 0 || !dirRef.current) return;
        pendingFiles.current = files;
        relQueue.current = rels ? [...rels] : [];
        call("select_files", "false");
    };

    /** 上傳一批（可能含資料夾）：先建資料夾（含空的），再傳檔。/ Upload a batch that may hold folders. */
    const uploadItems = async (items: LocalItem[], emptyDirs: string[]) => {
        const cur = dirRef.current;
        if (!cur || (items.length === 0 && emptyDirs.length === 0)) return;
        const plan = planUpload(cur.path, items, emptyDirs, windows);
        if (plan.dirs.length > 0) {
            setBusy({ key: "desktop.files.busy.folders", done: 0, total: plan.dirs.length });
            setOpActivity((a) => withActivity(a, "upload", "running"));
            for (const [i, d] of plan.dirs.entries()) {
                const id = jobId.current++;
                try {
                    await runOp("create_dir", { id, path: d }, id);
                } catch (err) {
                    const msg = (err as Error).message;
                    if (!isExistsError(msg)) {
                        setNotice(t("desktop.files.opFailed", { what: d, error: msg }));
                        setBusy(null);
                        setOpActivity((a) => withActivity(a, "upload", "failed"));
                        return;
                    }
                }
                setBusy({ key: "desktop.files.busy.folders", done: i + 1, total: plan.dirs.length });
            }
            setBusy(null);
            setOpActivity((a) => withActivity(a, "upload", "idle"));
            refresh();
        }
        if (plan.files.length > 0) upload(plan.files.map((f) => f.file), plan.files.map((f) => f.rel));
    };

    /** 先數資料夾裡有什麼，再問。/ Count what the folders hold, then ask. */
    const askDelete = async (entries: RemoteEntry[]) => {
        const cur = dirRef.current;
        if (!cur || entries.length === 0) return;
        setBusy({ key: "desktop.files.busy.counting", done: 0, total: entries.length });
        const items: DeleteItem[] = [];
        for (const [i, en] of entries.entries()) {
            const path = joinRemote(cur.path, en.name, windows);
            if (!en.isDir) {
                items.push({ name: en.name, path, isDir: false, size: en.size });
                continue;
            }
            const id = jobId.current++;
            try {
                // 刪資料夾要連隱藏檔一起數（不然剩下的隱藏檔讓資料夾刪不掉）。/ Hidden files count too, or the folder stays.
                const listing = await listRecursive(id, path, true);
                items.push({ name: en.name, path, isDir: true, size: 0, files: listing.files, listId: id });
            } catch (err) {
                setBusy(null);
                setNotice(t("desktop.files.opFailed", { what: en.name, error: (err as Error).message }));
                return;
            }
            setBusy({ key: "desktop.files.busy.counting", done: i + 1, total: entries.length });
        }
        setBusy(null);
        setDeleteAsk(items);
    };

    const doDelete = async (items: DeleteItem[]) => {
        const steps = items.map((it) => ({ it, steps: deleteSteps(it, windows), id: it.listId ?? jobId.current++ }));
        const total = steps.reduce((n, s) => n + s.steps.length, 0);
        let done = 0;
        const errors: string[] = [];
        setOpActivity((a) => withActivity(a, "delete", "running"));
        setBusy({ key: "desktop.files.busy.deleting", done, total });
        for (const s of steps) {
            for (const step of s.steps) {
                try {
                    if (step.op === "remove_file") await runOp("remove_file", { id: s.id, path: step.path, file_num: step.fileNum }, s.id);
                    else await runOp("remove_all_empty_dirs", { id: s.id, path: step.path }, s.id);
                } catch (err) {
                    errors.push(`${step.path}: ${(err as Error).message}`);
                }
                done += 1;
                setBusy({ key: "desktop.files.busy.deleting", done, total });
            }
        }
        setBusy(null);
        setSelected(new Set());
        setOpActivity((a) => withActivity(a, "delete", errors.length ? "failed" : "done"));
        if (errors.length) setNotice(errors.length === 1 ? t("desktop.files.deleteFailedOne", { error: errors[0] }) : t("desktop.files.deleteFailedMany", { count: errors.length, error: errors[0] }));
        refresh();
    };

    const renamePlan = renaming && dir ? planRename(dir.path, renaming.name, renameValue, windows) : null;
    const doRename = async () => {
        const cur = dirRef.current;
        const entry = renaming;
        if (!cur || !entry || !renamePlan || typeof renamePlan === "string") return;
        setRenaming(null);
        const id = jobId.current++;
        setOpActivity((a) => withActivity(a, "rename", "running"));
        try {
            await runOp("rename_file", { id, path: joinRemote(cur.path, entry.name, windows), new_name: renamePlan.newName }, id);
            setOpActivity((a) => withActivity(a, "rename", "done"));
        } catch (err) {
            setOpActivity((a) => withActivity(a, "rename", "failed"));
            setNotice(t("desktop.files.opFailed", { what: entry.name, error: (err as Error).message }));
        }
        refresh();
    };

    const doCreate = async () => {
        const cur = dirRef.current;
        const name = newName.trim();
        if (!cur || !validName(name)) return;
        setCreating(false);
        const id = jobId.current++;
        try {
            await runOp("create_dir", { id, path: joinRemote(cur.path, name, windows) }, id);
        } catch (err) {
            setNotice(t("desktop.files.opFailed", { what: name, error: (err as Error).message }));
        }
        refresh();
    };

    const cancel = (j: Job) => {
        const ask = confirmFolder.current.get(j.id);
        if (ask) {
            ask(false);
            return;
        }
        const folder = folderJobs.current.get(j.id);
        call("cancel_job", String(j.id));
        if (folder) folder.fail("cancel");
        setJobs((list) => list.map((x) => (x.id === j.id ? { ...x, state: "cancelled", speed: 0 } : x)));
    };
    const decide = (j: Job, replace: boolean) => {
        call("confirm_override_file", { id: j.id, file_num: j.confirm?.fileNum ?? 0, need_override: replace, is_upload: true });
        setJobs((list) => list.map((x) => (x.id === j.id ? { ...x, state: replace ? "running" : "cancelled", confirm: undefined } : x)));
    };

    const toggle = (name: string) => setSelected((s) => {
        const next = new Set(s);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
    });

    const ready = phase === "ready" && !!dir;
    const crumbs = dir ? crumbsFor(dir.path, windows) : [];
    const up = dir ? parentRemote(dir.path, windows) : null;
    const running = activeJobs(jobs);
    // 清單只顯示最近幾筆（還在跑的優先），不讓傳輸把檔案清單擠掉。/ Show the latest few (running first) so transfers never crowd the listing.
    const shownJobs = [...jobs.filter((j) => j.state === "running" || j.state === "confirm"), ...jobs.filter((j) => j.state !== "running" && j.state !== "confirm").reverse()].slice(0, 4);
    const dateFmt = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);
    const selection = dir ? selectionKinds(dir.entries, selected) : { folders: 0, files: 0 };
    const selectedEntries = dir ? dir.entries.filter((e) => selected.has(e.name)) : [];
    const summary = deleteAsk ? deleteSummary(deleteAsk) : null;
    const deleteMessage = (() => {
        if (!deleteAsk || !summary) return "";
        if (deleteAsk.length === 1) {
            const it = deleteAsk[0];
            return it.isDir
                ? t("desktop.files.deleteFolderMessage", { name: it.name, count: summary.inside, size: formatBytes(summary.bytes) })
                : t("desktop.files.deleteFileMessage", { name: it.name, size: formatBytes(summary.bytes) });
        }
        return t("desktop.files.deleteManyMessage", { count: deleteAsk.length, folders: summary.folders, files: summary.files, inside: summary.inside, size: formatBytes(summary.bytes) });
    })();
    const jobLabel = (j: Job): string => {
        if (j.state === "failed") return t("desktop.files.failed");
        if (j.state === "cancelled") return t("desktop.files.cancelled");
        if (j.state === "done") return formatBytes(j.total);
        if (j.folder?.phase === "listing") return t("desktop.files.counting");
        if (j.folder?.phase === "confirm") return "";
        if (j.folder?.phase === "finishing") return t("desktop.files.finishingZip");
        return `${jobPercent(j)}%${j.speed > 0 ? ` · ${formatBytes(j.speed)}/s` : ""}`;
    };

    return (
        <aside className="@container flex h-full min-h-0 flex-col bg-card text-card-foreground" aria-label={t("desktop.files.title")}>
            <div className="flex shrink-0 flex-col gap-2 border-b border-border p-3">
                <div className="flex items-center justify-between gap-2">
                    <h2 className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                        <Folder size={16} className="shrink-0 text-primary" aria-hidden /> {t("desktop.files.title")}
                        <span className={cn("size-2 shrink-0 rounded-full", phase === "ready" ? "bg-success" : phase === "failed" ? "bg-destructive" : "animate-pulse bg-warning")} title={t(phase === "ready" ? "common.connected" : phase === "failed" ? "common.disconnected" : "desktop.files.connecting")} />
                    </h2>
                    <div className="flex shrink-0 items-center gap-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setFlowOpen(true)} title={t("desktop.files.flow.open")} aria-label={t("desktop.files.flow.open")}>
                            <Info size={14} />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => dir && open(dir.path)} disabled={!ready || loading} title={t("common.refresh")} aria-label={t("common.refresh")}>
                            <RefreshCw size={14} className={loading && phase === "ready" ? "animate-spin" : ""} />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
                            <X size={14} />
                        </Button>
                    </div>
                </div>
                {ready && (
                    <>
                        <nav className="flex min-w-0 flex-wrap items-center gap-x-0.5 gap-y-1 font-mono text-xs" aria-label={t("desktop.files.path")}>
                            {crumbs.map((c, i) => (
                                <React.Fragment key={c.path || "root"}>
                                    {i > 1 && <span className="text-muted-foreground">{windows ? "\\" : "/"}</span>}
                                    <button type="button" onClick={() => open(c.path)} className={cn("max-w-40 truncate rounded-sm px-1 hover:bg-muted", i === crumbs.length - 1 ? "text-foreground" : "text-muted-foreground")}>
                                        {c.label || t("desktop.files.drives")}
                                    </button>
                                </React.Fragment>
                            ))}
                        </nav>
                        <div className="flex flex-wrap gap-1.5">
                            <Button size="sm" variant="outline" className="h-8 gap-1 px-2 text-xs" onClick={() => up !== null && open(up)} disabled={up === null} title={t("desktop.files.up")} aria-label={t("desktop.files.up")}>
                                <ArrowUp size={14} />
                            </Button>
                            <Button size="sm" variant="outline" className="h-8 gap-1 px-2 text-xs" onClick={() => home !== null && open(home)} disabled={home === null} title={t("desktop.files.home")} aria-label={t("desktop.files.home")}>
                                <Home size={14} />
                            </Button>
                            <Button size="sm" variant="outline" className="h-8 gap-1 px-2 text-xs" onClick={() => { const next = !showHidden; setShowHidden(next); showHiddenRef.current = next; if (dir) open(dir.path); }} aria-pressed={showHidden} title={t("desktop.files.hidden")} aria-label={t("desktop.files.hidden")}>
                                {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
                            </Button>
                            <Button size="sm" variant="outline" className="h-8 gap-1 px-2 text-xs" onClick={() => { setNewName(freeName(t("desktop.files.newFolderDefault"), dir.entries.map((e) => e.name))); setCreating(true); }} disabled={windows && dir.path === ""} title={t("desktop.files.newFolder")} aria-label={t("desktop.files.newFolder")}>
                                <FolderPlus size={14} />
                            </Button>
                            <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => { upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
                            <input
                                ref={folderInput}
                                type="file"
                                multiple
                                className="hidden"
                                {...{ webkitdirectory: "" }}
                                onChange={(e) => {
                                    const files = Array.from(e.target.files ?? []);
                                    void uploadItems(files.map((file) => ({ file, rel: file.webkitRelativePath || file.name })), []);
                                    e.target.value = "";
                                }}
                            />
                            <Button size="sm" variant="outline" className="h-8 gap-1 px-2 text-xs" onClick={() => folderInput.current?.click()} disabled={windows && dir.path === ""} title={t("desktop.files.uploadFolder")} aria-label={t("desktop.files.uploadFolder")}>
                                <FolderUp size={14} />
                            </Button>
                            <Button size="sm" className="h-8 flex-1 gap-1.5 text-xs" onClick={() => fileInput.current?.click()} disabled={windows && dir.path === ""}>
                                <Upload size={14} /> {t("desktop.files.upload")}
                            </Button>
                        </div>
                    </>
                )}
                {selected.size > 0 && (
                    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5 text-xs" data-selection>
                        <span className="min-w-0 flex-1 text-foreground">{t("desktop.files.selected", { folders: selection.folders, files: selection.files })}</span>
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setSelected(new Set())}>{t("desktop.files.clearSelection")}</Button>
                        <Button size="sm" variant="destructive" className="h-6 gap-1 px-2 text-xs" onClick={() => void askDelete(selectedEntries)} disabled={!!busy}>
                            <Trash2 size={12} /> {t("desktop.files.delete")}
                        </Button>
                    </div>
                )}
                {busy && (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status" data-busy>
                        <Loader2 size={12} className="shrink-0 animate-spin" aria-hidden />
                        <span className="min-w-0 flex-1">{t(busy.key, { done: busy.done, total: busy.total })}</span>
                    </p>
                )}
                {notice && (
                    <p className="flex items-start gap-1.5 text-xs text-warning" role="alert">
                        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{notice}</span>
                        <button type="button" onClick={() => setNotice(null)} aria-label={t("common.dismiss")}><X size={12} /></button>
                    </p>
                )}
            </div>

            {jobs.length > 0 && (
                <div className="shrink-0 border-b border-border bg-surface text-xs">
                    <div className="flex items-center gap-2 px-3 py-1.5 text-muted-foreground">
                        <span className="min-w-0 flex-1">{running > 0 ? t("desktop.files.transfersActive", { count: running }) : t("desktop.files.transfersDone")}</span>
                        {running === 0 && <button type="button" className="hover:text-foreground" onClick={() => setJobs([])} title={t("common.dismiss")} aria-label={t("common.dismiss")}><X size={13} /></button>}
                    </div>
                    <ul className="divide-y divide-border">
                        {shownJobs.map((j) => (
                            <li key={j.id} className="space-y-1 px-3 py-1.5" data-job={j.folder ? "folder" : j.kind} data-state={j.state} data-phase={j.folder?.phase}>
                                <div className="flex items-center gap-2">
                                    {j.state === "done" ? <CheckCircle2 size={12} className="shrink-0 text-success" /> : j.state === "failed" ? <XCircle size={12} className="shrink-0 text-destructive" /> : j.state === "cancelled" ? <X size={12} className="shrink-0 text-muted-foreground" /> : j.kind === "download" ? <Download size={12} className="shrink-0 text-primary" /> : <Upload size={12} className="shrink-0 text-primary" />}
                                    <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={j.error ? `${j.name}: ${j.error}` : j.name}>{j.name}</span>
                                    <span className={cn("shrink-0 tabular-nums", j.state === "failed" ? "text-destructive" : "text-muted-foreground")}>{jobLabel(j)}</span>
                                    {(j.state === "running" || j.state === "confirm") && j.folder?.phase !== "finishing" && (
                                        <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => cancel(j)} title={t("common.cancel")} aria-label={t("common.cancel")}><X size={12} /></button>
                                    )}
                                </div>
                                {j.folder && j.folder.phase !== "listing" && j.folder.phase !== "confirm" && j.state !== "failed" && j.state !== "cancelled" && (
                                    <p className="truncate text-muted-foreground" title={j.folder.currentName || undefined}>
                                        {j.folder.phase === "running" && j.folder.current > 0
                                            ? t("desktop.files.folderProgress", { current: j.folder.current, count: j.folder.files, name: j.folder.currentName })
                                            : t("desktop.files.folderSummary", { count: j.folder.files, size: formatBytes(j.folder.bytes) })}
                                    </p>
                                )}
                                {j.state === "running" && j.folder?.phase !== "confirm" && j.folder?.phase !== "listing" && <div className="h-1 rounded-full bg-muted"><div className="h-1 rounded-full bg-primary transition-[width]" style={{ width: `${jobPercent(j)}%` }} /></div>}
                                {j.folder?.phase === "confirm" && j.state === "running" && (
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="min-w-0 flex-1 text-foreground">{t("desktop.files.folderConfirm", { count: j.folder.files, size: formatBytes(j.folder.bytes) })}</span>
                                        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => confirmFolder.current.get(j.id)?.(false)}>{t("common.cancel")}</Button>
                                        <Button size="sm" className="h-6 px-2 text-xs" onClick={() => { confirmFolder.current.get(j.id)?.(true); }}>{t("desktop.files.download")}</Button>
                                    </div>
                                )}
                                {j.state === "confirm" && (
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="min-w-0 flex-1 text-foreground">{t(j.confirm?.identical ? "desktop.files.identical" : "desktop.files.exists")}</span>
                                        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => decide(j, false)}>{t("desktop.files.skip")}</Button>
                                        <Button size="sm" className="h-6 px-2 text-xs" onClick={() => decide(j, true)}>{t("desktop.files.replace")}</Button>
                                    </div>
                                )}
                                {j.state === "failed" && j.error && <p className="text-destructive [overflow-wrap:anywhere]">{j.error}</p>}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <div
                className={cn("min-h-0 flex-1 overflow-y-auto bg-background", dragging && "ring-2 ring-inset ring-primary")}
                onDragOver={(e) => { if (ready && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    if (!ready) return;
                    void readDropped(e.dataTransfer).then(({ items, emptyDirs }) => {
                        if (emptyDirs.length === 0 && items.every((it) => !it.rel.includes("/"))) upload(items.map((it) => it.file));
                        else void uploadItems(items, emptyDirs);
                    });
                }}
            >
                {phase === "failed" ? (
                    <div className="p-3">
                        <Callout tone="danger">
                            <p>{t(failure ?? "desktop.files.err.start")}</p>
                            {failureText && <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{failureText}</p>}
                        </Callout>
                    </div>
                ) : !dir ? (
                    <div className="flex flex-col items-center gap-2 p-8 text-center text-xs text-muted-foreground">
                        <Loader2 size={20} className="animate-spin" aria-hidden />
                        {t("desktop.files.connecting")}
                    </div>
                ) : dir.entries.length === 0 ? (
                    <p className="p-6 text-center text-xs text-muted-foreground">{t("desktop.files.empty")}</p>
                ) : (
                    <ul className="divide-y divide-border/60 text-sm">
                        {dir.entries.map((en) => {
                            const drive = en.isDrive;
                            return (
                                <li key={en.name} className={cn("group flex items-center gap-2 px-3 py-1.5 hover:bg-muted/60", selected.has(en.name) && "bg-primary/5")} data-entry={en.name}>
                                    {!drive && (
                                        <input
                                            type="checkbox"
                                            className="size-3.5 shrink-0 accent-(--primary)"
                                            checked={selected.has(en.name)}
                                            onChange={() => toggle(en.name)}
                                            aria-label={t("desktop.files.selectName", { name: en.name })}
                                        />
                                    )}
                                    {drive ? <HardDrive size={16} className="shrink-0 text-muted-foreground" /> : en.isDir ? <Folder size={16} className="shrink-0 fill-info/15 text-info" /> : <FileIcon size={16} className="shrink-0 text-muted-foreground" />}
                                    {en.isDir ? (
                                        <button type="button" className="min-w-0 flex-1 truncate text-left text-foreground" onClick={() => open(joinRemote(dir.path, en.name, windows))} title={en.name}>{en.name}</button>
                                    ) : (
                                        <span className="min-w-0 flex-1 truncate text-foreground" title={en.name}>{en.name}</span>
                                    )}
                                    {!en.isDir && <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground @[18rem]:inline" title={en.modified ? dateFmt.format(new Date(en.modified * 1000)) : undefined}>{formatBytes(en.size)}</span>}
                                    {!drive && (
                                        <>
                                            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => void (en.isDir ? downloadFolder(en) : download(en))} title={en.isDir ? t("desktop.files.downloadZip") : t("desktop.files.download")} aria-label={en.isDir ? t("desktop.files.downloadZipName", { name: en.name }) : t("desktop.files.downloadName", { name: en.name })}>
                                                <Download size={14} />
                                            </Button>
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" title={t("desktop.files.more")} aria-label={t("desktop.files.moreName", { name: en.name })}>
                                                        <MoreHorizontal size={14} />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end">
                                                    <DropdownMenuItem onSelect={() => void (en.isDir ? downloadFolder(en) : download(en))}>
                                                        <Download /> {en.isDir ? t("desktop.files.downloadZip") : t("desktop.files.download")}
                                                    </DropdownMenuItem>
                                                    <DropdownMenuItem onSelect={() => { setRenameValue(en.name); setRenaming(en); }}>
                                                        <PencilLine /> {t("desktop.files.rename")}
                                                    </DropdownMenuItem>
                                                    <DropdownMenuSeparator />
                                                    <DropdownMenuItem variant="destructive" onSelect={() => void askDelete([en])} disabled={!!busy}>
                                                        <Trash2 /> {t("desktop.files.delete")}
                                                    </DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
            <p className="flex shrink-0 items-start gap-1.5 border-t border-border px-3 py-2 text-xs text-muted-foreground">
                <Info size={13} className="mt-px shrink-0" aria-hidden /> {t("desktop.files.footnote")}
            </p>

            <ConfirmDialog
                isOpen={!!deleteAsk}
                onClose={() => setDeleteAsk(null)}
                onConfirm={() => { const items = deleteAsk; if (items) void doDelete(items); }}
                title={deleteAsk && deleteAsk.length === 1 ? t(deleteAsk[0].isDir ? "desktop.files.deleteFolderTitle" : "desktop.files.deleteFileTitle", { name: deleteAsk[0].name }) : t("desktop.files.deleteManyTitle", { count: deleteAsk?.length ?? 0 })}
                message={deleteMessage}
                confirmText={t("desktop.files.delete")}
                isDestructive
            />

            <Modal
                isOpen={!!renaming}
                onClose={() => setRenaming(null)}
                title={t("desktop.files.renameTitle", { name: renaming?.name ?? "" })}
                icon={<PencilLine />}
                size="md"
                footer={
                    <>
                        <Button variant="outline" onClick={() => setRenaming(null)}>{t("common.cancel")}</Button>
                        <Button onClick={() => void doRename()} disabled={!renamePlan || typeof renamePlan === "string"}>
                            {renamePlan && typeof renamePlan !== "string" && renamePlan.move ? t("desktop.files.move") : t("desktop.files.rename")}
                        </Button>
                    </>
                }
            >
                <form onSubmit={(e) => { e.preventDefault(); void doRename(); }} className="space-y-2">
                    <Field
                        label={t("desktop.files.renameLabel")}
                        hint={renamePlan && typeof renamePlan !== "string" ? t(renamePlan.move ? "desktop.files.renameMoveTo" : "desktop.files.renameTo", { path: renamePlan.target }) : t("desktop.files.renameHint")}
                        error={typeof renamePlan === "string" && renamePlan !== "same" && renamePlan !== "empty" ? t(RENAME_PROBLEM[renamePlan]) : undefined}
                    >
                        <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus className="font-mono" spellCheck={false} autoComplete="off" />
                    </Field>
                </form>
            </Modal>

            <Modal
                isOpen={creating}
                onClose={() => setCreating(false)}
                title={t("desktop.files.newFolder")}
                icon={<FolderPlus />}
                size="md"
                footer={
                    <>
                        <Button variant="outline" onClick={() => setCreating(false)}>{t("common.cancel")}</Button>
                        <Button onClick={() => void doCreate()} disabled={!validName(newName)}>{t("desktop.files.create")}</Button>
                    </>
                }
            >
                <form onSubmit={(e) => { e.preventDefault(); void doCreate(); }}>
                    <Field label={t("desktop.files.newFolderLabel")} hint={dir ? t("desktop.files.newFolderIn", { path: dir.path }) : undefined} error={newName.trim() && !validName(newName) ? t("desktop.files.nameInvalid") : undefined}>
                        <Input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus spellCheck={false} autoComplete="off" />
                    </Field>
                </form>
            </Modal>

            <RustDeskFilesFlowDialog
                isOpen={flowOpen}
                onClose={() => setFlowOpen(false)}
                ctx={{ phase, failure, activity, deviceName: deviceName ?? t("desktop.flow.device"), path: dir?.path ?? null }}
            />
        </aside>
    );
}
