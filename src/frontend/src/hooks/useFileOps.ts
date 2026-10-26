"use client";

/**
 * 檔案管理的 REST 操作（/api/sftp/*）：建資料夾 / 新檔案、改名、搬移、複製、權限、刪除（先數再刪）、stat、文字檔讀寫、
 * 多選打包下載，以及上傳佇列（同時 2 個、每個檔案有進度）。全部走後端連線池共用的那條 SFTP channel。
 * 「現在在做什麼」（busy）給 info 視覺說明用。錯誤碼 → `files.err.*`。
 * File-manager REST operations plus the upload queue (two at a time, per-file progress). `busy` feeds the
 * FileFlow diagram; error codes map to `files.err.*`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { fileErrorKey, joinPath, nextUploads, type Busy, type BusyKind, type UploadJob } from "@/lib/fileManager";
import { uploadWithProgress } from "@/lib/uploadXhr";

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

/** 把 blob 存成檔案（瀏覽器下載）。/ Save a blob through the browser. */
export function saveBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function filenameFrom(res: Response, fallback: string): string {
    const m = res.headers.get("Content-Disposition")?.match(/filename="?([^"]+)"?/);
    return m?.[1] || fallback;
}

let nextJobId = 1;

export function useFileOps(serverId: string, username: string, currentPath: string, reload: () => void) {
    const { t } = useI18n();
    const { showError, showSuccess } = useToast();
    const [busy, setBusy] = useState<Busy | null>(null);
    const [uploads, setUploads] = useState<UploadJob[]>([]);
    const started = useRef(new Set<number>());
    /** 排隊中的 File 物件（state 裡只放可序列化的欄位）。/ The queued File objects. */
    const filesRef = useRef(new Map<number, File>());
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

    /** 下載（完整路徑）：一個 = 檔案（資料夾後端會打包），多個 = 一個 zip。/ One path = the file, several = one zip. */
    const download = useCallback(
        async (paths: string[]) => {
            if (!paths.length) return;
            setBusy({ kind: "downloading", count: paths.length });
            try {
                const single = paths.length === 1;
                const res = single
                    ? await apiFetch(`${base("download")}?path=${encodeURIComponent(paths[0])}`)
                    : await apiFetch(base("zip"), { method: "POST", body: JSON.stringify({ paths }) });
                if (!res.ok) {
                    showError(t("files.downloadFailed", { error: errorText(res, await readJson(res)) }));
                    return;
                }
                saveBlob(await res.blob(), filenameFrom(res, single ? paths[0].split(/[/\\]/).pop() || "download" : "files.zip"));
            } catch (e) {
                showError(t("files.downloadFailed", { error: e instanceof Error ? e.message : String(e) }));
            } finally {
                setBusy(null);
            }
        },
        [base, errorText, showError, t],
    );

    // ------------------------------------------------------------ uploads

    const enqueue = useCallback(
        (files: File[]) => {
            if (!files.length) return;
            const jobs = files.map((f) => ({ id: nextJobId++, name: f.name, size: f.size, loaded: 0, state: "queued" as const, dir: currentPath, file: f }));
            filesRef.current = new Map([...filesRef.current, ...jobs.map((j) => [j.id, j.file] as const)]);
            setUploads((prev) => [...prev.filter((j) => j.state === "queued" || j.state === "uploading"), ...jobs.map((j) => ({ id: j.id, name: j.name, size: j.size, loaded: j.loaded, state: j.state, dir: j.dir }))]);
        },
        [currentPath],
    );
    const patchJob = useCallback((id: number, patch: Partial<UploadJob>) => setUploads((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j))), []);

    useEffect(() => {
        const ids = nextUploads(uploads).filter((id) => !started.current.has(id));
        if (!ids.length) {
            const finished = uploads.length > 0 && uploads.every((j) => j.state === "done" || j.state === "failed");
            if (finished && started.current.size > 0) {
                started.current.clear();
                const failed = uploads.filter((j) => j.state === "failed");
                if (failed.length) showError(t("files.uploadSomeFailed", { count: failed.length, name: failed[0].name, reason: failed[0].error ?? "" }));
                else showSuccess(t("files.uploadedCount", { count: uploads.length }));
                reloadRef.current();
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
            const url = `${base("upload")}?destination_path=${encodeURIComponent(job.dir)}`;
            uploadWithProgress(url, file, (loaded) => patchJob(id, { loaded }))
                .then((r) => {
                    filesRef.current.delete(id);
                    if (r.status >= 200 && r.status < 300) patchJob(id, { state: "done", loaded: job.size });
                    else {
                        const body = r.body as { code?: string; error?: string } | null;
                        const key = fileErrorKey(body?.code);
                        patchJob(id, { state: "failed", error: key ? t(key) : body?.error || `HTTP ${r.status}` });
                    }
                })
                .catch((e) => {
                    filesRef.current.delete(id);
                    patchJob(id, { state: "failed", error: e instanceof Error ? e.message : String(e) });
                });
        }
    }, [uploads, base, patchJob, showError, showSuccess, t]);

    const clearUploads = useCallback(() => setUploads((prev) => prev.filter((j) => j.state === "queued" || j.state === "uploading")), []);

    const uploading = uploads.filter((j) => j.state === "queued" || j.state === "uploading").length;
    const effectiveBusy: Busy | null = busy ?? (uploading ? { kind: "uploading", count: uploading } : null);

    return {
        busy: effectiveBusy,
        uploads,
        enqueue,
        clearUploads,
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
