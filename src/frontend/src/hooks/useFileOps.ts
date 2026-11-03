"use client";

/**
 * 檔案管理的 REST 操作（/api/sftp/*）：建資料夾 / 新檔案、改名、搬移、複製、權限、刪除（先數再刪）、stat、文字檔讀寫、
 * 下載（一次性連結，瀏覽器自己下載：直接寫到磁碟、有自己的進度；資料夾 / 多選是邊打包邊送的 zip），以及上傳佇列
 * （同時 3 個、每個分段送、斷了重送那段、可以取消；資料夾整個傳）。全部走後端連線池共用的那條 SFTP channel。
 * 「現在在做什麼」（busy）給 info 視覺說明用。錯誤碼 → `files.err.*`。
 * File-manager REST operations: downloads go through one-time links the browser opens itself (straight to disk, its
 * own progress; folders / several items stream as one zip), and the upload queue sends files in parts (three at a
 * time, failed parts resent, cancellable, folders included). `busy` feeds the FileFlow diagram.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { fileErrorKey, isActiveUpload, joinPath, nextUploads, type Busy, type BusyKind, type UploadJob } from "@/lib/fileManager";
import { foldersToCreate, newUploadId, safeRel, sameLocalFile, type LocalItem, type UnfinishedUpload } from "@/lib/uploadParts";
import { cancelUpload, uploadInParts } from "@/lib/uploadXhr";

export interface OpResult<T = Record<string, unknown>> {
    ok: boolean;
    status: number;
    data: T | null;
    code: string | null;
    /** 已翻譯的錯誤訊息。/ The translated error message. */
    message: string;
}

export interface Tally {
    files: number;
    dirs: number;
    links: number;
    bytes: number;
    entries: number;
    truncated: boolean;
}

export interface FileStat {
    path: string;
    name: string;
    type: "file" | "directory" | "symlink";
    size: number;
    mode: string;
    permissions: string;
    uid: number | null;
    gid: number | null;
    mtime: string | null;
    mtime_epoch: number | null;
    link_target: string | null;
    target_type: string | null;
}

export interface TextFile {
    path: string;
    name: string;
    size: number;
    mtime_epoch: number | null;
    mode: string;
    content?: string;
}

interface Failure {
    path: string;
    code: string | null;
    error: string | null;
}

/** 讓瀏覽器自己打開下載連結（Content-Disposition: attachment，頁面不會離開）。/ Let the browser download a link. */
function startBrowserDownload(url: string) {
    const a = document.createElement("a");
    a.href = `${process.env.NEXT_PUBLIC_API_BASE || ""}${url}`;
    a.rel = "noopener";
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

let nextJobId = 1;
/** 有「正在上傳」的未完成上傳時多久再看一次。/ How soon an "uploading now" entry is looked at again. */
const UNFINISHED_RECHECK = 15_000;

export function useFileOps(serverId: string, username: string, currentPath: string, reload: () => void) {
    const { t } = useI18n();
    const { showError, showSuccess, showToast } = useToast();
    const [busy, setBusy] = useState<Busy | null>(null);
    const [uploads, setUploads] = useState<UploadJob[]>([]);
    const started = useRef(new Set<number>());
    /** 排隊中的 File 物件（state 裡只放可序列化的欄位）。/ The queued File objects. */
    const filesRef = useRef(new Map<number, File>());
    /** 傳到一半的可以停。/ Running uploads can be stopped. */
    const abortsRef = useRef(new Map<number, AbortController>());
    const reloadRef = useRef(reload);
    useEffect(() => {
        reloadRef.current = reload;
    }, [reload]);

    const base = useCallback((op: string) => `/api/sftp/${op}/${serverId}/${encodeURIComponent(username)}`, [serverId, username]);
    const pathOf = useCallback((name: string) => joinPath(currentPath, name), [currentPath]);

    const errorText = useCallback(
        (res: Response, data: { code?: string; error?: string } | null) => {
            const key = fileErrorKey(data?.code);
            return key ? t(key) : responseError(res, data, t("files.genericError"));
        },
        [t],
    );

    /** 打一個操作；不吐 toast（呼叫端決定）。/ One call; the caller decides what to show. */
    const request = useCallback(
        async <T,>(op: string, init: { method?: string; body?: unknown; query?: string } = {}, kind?: BusyKind, count?: number): Promise<OpResult<T>> => {
            if (kind) setBusy({ kind, count });
            try {
                const res = await apiFetch(`${base(op)}${init.query ?? ""}`, {
                    method: init.method ?? "POST",
                    body: init.body === undefined ? undefined : JSON.stringify(init.body),
                });
                const data = await readJson<T & { code?: string; error?: string }>(res);
                return { ok: res.ok, status: res.status, data, code: data?.code ?? null, message: res.ok ? "" : errorText(res, data) };
            } catch (e) {
                return { ok: false, status: 0, data: null, code: null, message: t("files.err.network", { error: e instanceof Error ? e.message : String(e) }) };
            } finally {
                if (kind) setBusy(null);
            }
        },
        [base, errorText, t],
    );

    /** 批次結果：有失敗就說第一個為什麼。/ Batch results: explain the first failure. */
    const reportFailures = useCallback(
        (failed: Failure[] | undefined) => {
            if (!failed?.length) return false;
            const first = failed[0];
            const key = fileErrorKey(first.code);
            showError(t("files.someFailed", { count: failed.length, name: first.path.split(/[/\\]/).pop() || first.path, reason: key ? t(key) : first.error || "" }));
            return true;
        },
        [showError, t],
    );

    const simple = useCallback(
        async (op: string, body: unknown, kind: BusyKind, success: string, count?: number) => {
            const r = await request<{ failed?: Failure[] }>(op, { body }, kind, count);
            if (!r.ok) {
                showError(r.message);
                return false;
            }
            const failed = reportFailures(r.data?.failed);
            if (!failed && success) showSuccess(success);
            reloadRef.current();
            return !failed;
        },
        [request, reportFailures, showError, showSuccess],
    );

    const mkdir = useCallback((name: string) => simple("mkdir", { path: pathOf(name) }, "creating", t("files.done.mkdir", { name })), [simple, pathOf, t]);
    const touch = useCallback((name: string) => simple("touch", { path: pathOf(name) }, "creating", t("files.done.touch", { name })), [simple, pathOf, t]);
    const rename = useCallback(
        (from: string, to: string) => simple("rename", { from: pathOf(from), to: pathOf(to) }, "renaming", t("files.done.rename", { name: to })),
        [simple, pathOf, t],
    );
    const move = useCallback(
        (names: string[], destination: string) => simple("rename", { paths: names.map(pathOf), destination }, "moving", t("files.done.move", { count: names.length, dest: destination.split(/[/\\]/).filter(Boolean).pop() || destination }), names.length),
        [simple, pathOf, t],
    );
    const copy = useCallback(
        (names: string[], destination: string) => simple("copy", { paths: names.map(pathOf), destination }, "copying", t("files.done.copy", { count: names.length, dest: destination.split(/[/\\]/).filter(Boolean).pop() || destination }), names.length),
        [simple, pathOf, t],
    );
    const chmod = useCallback(
        (names: string[], mode: string, recursive: boolean) => simple("chmod", { paths: names.map(pathOf), mode, recursive }, "chmod", t("files.done.chmod", { mode }), names.length),
        [simple, pathOf, t],
    );
    const countDelete = useCallback((names: string[]) => request<Tally>("delete", { body: { paths: names.map(pathOf) }, query: "?count=1" }, "counting", names.length), [request, pathOf]);
    const remove = useCallback(
        async (names: string[]) => {
            const r = await request<{ removed: number; failed?: Failure[] }>("delete", { body: { paths: names.map(pathOf) } }, "deleting", names.length);
            if (!r.ok) {
                showError(r.message);
                return false;
            }
            if (!reportFailures(r.data?.failed)) showSuccess(t("files.done.delete", { count: r.data?.removed ?? 0 }));
            reloadRef.current();
            return true;
        },
        [request, pathOf, reportFailures, showError, showSuccess, t],
    );
    const stat = useCallback((name: string) => request<FileStat>("stat", { method: "GET", query: `?path=${encodeURIComponent(pathOf(name))}` }, "reading"), [request, pathOf]);
    const readText = useCallback((path: string) => request<TextFile>("text", { method: "GET", query: `?path=${encodeURIComponent(path)}` }, "reading"), [request]);
    const saveText = useCallback(
        (path: string, content: string, opened: { mtime: number | null; size: number }, force = false) =>
            request<TextFile>("text", { method: "PUT", body: { path, content, mtime: opened.mtime ?? undefined, size: opened.size, force } }, "saving"),
        [request],
    );

    /** 原始檔案內容（圖片預覽）。/ Raw bytes (image preview). */
    const fetchBlob = useCallback(
        async (path: string): Promise<Blob | null> => {
            setBusy({ kind: "reading" });
            try {
                const res = await apiFetch(`${base("download")}?path=${encodeURIComponent(path)}`);
                return res.ok ? await res.blob() : null;
            } catch {
                return null;
            } finally {
                setBusy(null);
            }
        },
        [base],
    );

    /**
     * 下載（完整路徑）：一個檔案 = 檔案本身，資料夾 / 多個 = 一個邊打包邊送的 zip。先拿一次性連結，再讓瀏覽器自己下載。
     * Download: one file = the file, a folder or several = one streamed zip. A one-time link, opened by the browser.
     */
    const download = useCallback(
        async (paths: string[]) => {
            if (!paths.length) return;
            const r = await request<{ url: string; name: string; zip: boolean }>("download-link", { body: { paths } }, "downloading", paths.length);
            if (!r.ok || !r.data?.url) {
                showError(t("files.downloadFailed", { error: r.message || t("files.genericError") }));
                return;
            }
            startBrowserDownload(r.data.url);
            showSuccess(t(r.data.zip ? "files.downloadStartedZip" : "files.downloadStarted", { name: r.data.name }));
        },
        [request, showError, showSuccess, t],
    );

    // ------------------------------------------------------------ uploads

    // ------------------------------------------------------------ unfinished uploads (the ledger)

    /** 這個資料夾裡沒傳完的上傳（Telepy 記下的暫存檔）。/ Unfinished uploads into this folder (Telepy's own part files). */
    const [unfinished, setUnfinished] = useState<UnfinishedUpload[]>([]);
    const loadUnfinished = useCallback(async () => {
        if (!currentPath) return;
        const r = await request<{ uploads: UnfinishedUpload[] }>("uploads", { method: "GET", query: `?dir=${encodeURIComponent(currentPath)}` });
        setUnfinished(r.ok && Array.isArray(r.data?.uploads) ? r.data.uploads : []);
    }, [currentPath, request]);
    useEffect(() => {
        setUnfinished([]);
        void loadUnfinished();
    }, [loadUnfinished]);
    // 「正在上傳」的那一筆可能是剛關掉的分頁：過一下再看一次，才會變成可以繼續 / 捨棄。
    // An "uploading now" entry may be a tab that just closed: look again shortly so it becomes continuable.
    useEffect(() => {
        if (!unfinished.some((u) => u.active)) return;
        const timer = setTimeout(() => void loadUnfinished(), UNFINISHED_RECHECK);
        return () => clearTimeout(timer);
    }, [unfinished, loadUnfinished]);

    /** 捨棄一個沒傳完的上傳（自己的；擁有者 / Admin 可以捨棄別人的）。/ Discard an unfinished upload. */
    const discardUnfinished = useCallback(
        async (u: UnfinishedUpload) => {
            const r = await request("upload-part", { method: "DELETE", query: `?${new URLSearchParams({ path: u.target, upload: u.upload }).toString()}` }, "deleting");
            if (!r.ok) showError(r.message);
            await loadUnfinished();
            reloadRef.current();
        },
        [request, showError, loadUnfinished],
    );

    /**
     * 排進佇列。`items` 的 `rel` 是相對路徑（資料夾上傳時含資料夾，`parents` 會把它們建起來）；`emptyDirs` 先建。
     * Queue files; `rel` may hold folders (created on the way); `emptyDirs` are created first.
     */
    const enqueue = useCallback(
        async (items: LocalItem[], opts: { overwrite?: boolean; emptyDirs?: string[] } = {}) => {
            const dir = currentPath;
            for (const d of foldersToCreate(opts.emptyDirs ?? [])) {
                // 已經有了沒關係。/ "exists" is fine.
                await request("mkdir", { body: { path: joinPath(dir, d) } });
            }
            if (!items.length) {
                if (opts.emptyDirs?.length) reloadRef.current();
                return;
            }
            const jobs: UploadJob[] = items.map(({ file, rel }) => {
                const clean = safeRel(rel) || file.name;
                return {
                    id: nextJobId++,
                    name: clean,
                    size: file.size,
                    loaded: 0,
                    state: "queued",
                    dir,
                    target: joinPath(dir, clean),
                    overwrite: !!opts.overwrite,
                    parents: clean.includes("/"),
                    upload: newUploadId(),
                    retry: 0,
                };
            });
            filesRef.current = new Map([...filesRef.current, ...jobs.map((j, i) => [j.id, items[i].file] as const)]);
            setUploads((prev) => [...prev.filter(isActiveUpload), ...jobs]);
        },
        [currentPath, request],
    );
    const patchJob = useCallback((id: number, patch: Partial<UploadJob>) => setUploads((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j))), []);

    /** 選回當初那個檔案就接著傳；不是同一個（名字、大小、修改時間不同）回 false。/ Continue with the same local file. */
    const continueUnfinished = useCallback(
        (u: UnfinishedUpload, file: File) => {
            if (!sameLocalFile(file, u)) return false;
            void enqueue([{ file, rel: u.name }]);
            return true;
        },
        [enqueue],
    );

    useEffect(() => {
        const ids = nextUploads(uploads).filter((id) => !started.current.has(id));
        if (!ids.length) {
            const finished = uploads.length > 0 && !uploads.some(isActiveUpload);
            if (finished && started.current.size > 0) {
                started.current.clear();
                const failed = uploads.filter((j) => j.state === "failed" && !j.kept);
                const kept = uploads.filter((j) => j.kept);
                const done = uploads.filter((j) => j.state === "done").length;
                if (failed.length) showError(t("files.uploadSomeFailed", { count: failed.length, name: failed[0].name, reason: failed[0].error ?? "" }));
                else if (kept.length) showToast(t("files.upload.keptToast", { name: kept[0].name, count: kept.length }), "warning");
                else if (done) showSuccess(t("files.uploadedCount", { count: done }));
                reloadRef.current();
                void loadUnfinished();
            }
            return;
        }
        for (const id of ids) {
            started.current.add(id);
            const job = uploads.find((j) => j.id === id)!;
            const file = filesRef.current.get(id);
            patchJob(id, { state: "uploading" });
            if (!file) {
                patchJob(id, { state: "failed", error: t("files.genericError") });
                continue;
            }
            const abort = new AbortController();
            abortsRef.current.set(id, abort);
            let keepFile = false;
            uploadInParts({ start: base("upload-start"), part: base("upload-part") }, file, {
                upload: job.upload,
                lease: job.lease,
                target: job.target,
                overwrite: job.overwrite,
                parents: job.parents,
                onProgress: (loaded) => patchJob(id, { loaded }),
                onRetry: (retry) => patchJob(id, { retry }),
                onWaitingOther: (waitingOther) => patchJob(id, { waitingOther }),
                onStarted: ({ upload, lease, resumedFrom }) => patchJob(id, { upload, lease, resumedFrom }),
                signal: abort.signal,
            })
                .then((r) => {
                    if (r.ok) patchJob(id, { state: "done", loaded: job.size, retry: 0, kept: false });
                    else {
                        const key = fileErrorKey(r.code);
                        // 同名衝突時傳好的部分還在裝置上：留著本機檔案，「取代」就不必重傳。
                        // On a name clash the upload waits on the device: keep the local file so replacing needs no re-upload.
                        keepFile = !!r.kept;
                        patchJob(id, {
                            state: "failed",
                            retry: 0,
                            kept: !!r.kept,
                            upload: r.upload,
                            lease: r.lease,
                            error: r.kept ? t("files.upload.keptNote") : key ? t(key) : r.error || (r.status ? `HTTP ${r.status}` : t("files.err.network", { error: "" })),
                        });
                    }
                })
                .catch((e) => {
                    if (e instanceof DOMException && e.name === "AbortError") patchJob(id, { state: "cancelled", retry: 0 });
                    else patchJob(id, { state: "failed", retry: 0, error: e instanceof Error ? e.message : String(e) });
                })
                .finally(() => {
                    if (!keepFile) filesRef.current.delete(id);
                    abortsRef.current.delete(id);
                });
        }
    }, [uploads, base, patchJob, showError, showSuccess, showToast, t, loadUnfinished]);

    /** 取消一個（排隊中的直接拿掉；傳到一半的停下來並刪裝置上的暫存檔）。/ Cancel one upload. */
    const cancelUploads = useCallback(
        (ids?: number[]) => {
            const which = (j: UploadJob) => isActiveUpload(j) && (!ids || ids.includes(j.id));
            for (const j of uploads.filter(which)) {
                const abort = abortsRef.current.get(j.id);
                if (abort) {
                    abort.abort();
                    void cancelUpload(base("upload-part"), j.target, j.upload);
                }
                filesRef.current.delete(j.id);
            }
            setUploads((prev) => prev.map((j) => (which(j) ? { ...j, state: "cancelled", retry: 0 } : j)));
        },
        [uploads, base],
    );

    /** 同名衝突後選「取代」：同一個上傳接著用（裝置上已經傳完，只差改名）。/ Replace after a name clash: no re-upload. */
    const replaceKept = useCallback(
        (id: number) => {
            if (!filesRef.current.has(id)) return;
            started.current.delete(id);
            setUploads((prev) => prev.map((j) => (j.id === id && j.kept ? { ...j, state: "queued", overwrite: true, kept: false, error: undefined, retry: 0 } : j)));
        },
        [],
    );

    /** 同名衝突後選「捨棄」：刪掉裝置上傳好的部分。/ Discard after a name clash: remove what was uploaded. */
    const discardKept = useCallback(
        (id: number) => {
            const job = uploads.find((j) => j.id === id && j.kept);
            if (!job) return;
            void cancelUpload(base("upload-part"), job.target, job.upload).then(() => void loadUnfinished());
            filesRef.current.delete(id);
            patchJob(id, { state: "cancelled", kept: false });
        },
        [uploads, base, patchJob, loadUnfinished],
    );

    // 面板收起來（終端機頁切到工具箱）時，傳到一半的照樣在背景傳完，跟以前一樣；排隊中的等面板回來。
    // A hidden panel (terminal page → Toolbox) lets running uploads finish in the background, as before.

    const clearUploads = useCallback(() => setUploads((prev) => prev.filter(isActiveUpload)), []);

    const uploading = uploads.filter(isActiveUpload).length;
    const effectiveBusy: Busy | null = busy ?? (uploading ? { kind: "uploading", count: uploading } : null);

    return {
        busy: effectiveBusy,
        uploads,
        enqueue,
        cancelUploads,
        clearUploads,
        replaceKept,
        discardKept,
        unfinished,
        loadUnfinished,
        discardUnfinished,
        continueUnfinished,
        pathOf,
        mkdir,
        touch,
        rename,
        move,
        copy,
        chmod,
        countDelete,
        remove,
        stat,
        readText,
        saveText,
        fetchBlob,
        download,
    };
}

export type FileOps = ReturnType<typeof useFileOps>;
