"use client";

/**
 * 分段上傳（`PUT /api/sftp/upload-part/…`，見 `uploadParts.ts`）：一段一個請求，進度 = 裝置收到的 + 這一段送出的。
 * fetch 拿不到上傳進度，所以用 XMLHttpRequest。和 apiFetch 一樣在送出當下讀 token（背景續期後也對），
 * 401 續期一次再送、403 `step_up_required` 確認是你之後再送一次；連線斷了 / 代理放棄（502 / 504 / 52x）就等一下
 * 重送同一段；裝置上的暫存檔比較短就從那裡接（續傳）。
 * Uploads in parts: one request per part, progress = what the device has plus this part's bytes sent. XHR because
 * fetch has no upload progress. The token is read at send time; 401 renews once, 403 `step_up_required` asks once;
 * dropped connections and proxies giving up resend the same part after a wait; a shorter part file resumes there.
 */
import { apiFetch, readJson, refreshSession } from "@/lib/api";
import { requestStepUp, STEP_UP_HEADER, stepUpToken } from "@/lib/stepUp";
import { localIdentity, partOutcome, partQuery, partRange, resumable, retryDelay } from "@/lib/uploadParts";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

interface XhrResult {
    status: number;
    body: unknown;
}

function put(url: string, body: ArrayBuffer, onProgress: (sent: number) => void, signal?: AbortSignal): Promise<XhrResult> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", `${API_BASE}${url}`);
        const token = localStorage.getItem("accessToken");
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        const stepUp = stepUpToken();
        if (stepUp) xhr.setRequestHeader(STEP_UP_HEADER, stepUp);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.upload.onprogress = (e) => onProgress(e.loaded);
        xhr.onload = () => {
            let parsed: unknown = null;
            try {
                parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null;
            } catch {
                parsed = null;
            }
            resolve({ status: xhr.status, body: parsed });
        };
        // 連線斷了：當成 status 0，讓重送規則決定。/ A dropped connection is status 0 for the retry rule.
        xhr.onerror = () => resolve({ status: 0, body: null });
        xhr.ontimeout = () => resolve({ status: 0, body: null });
        xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
        signal?.addEventListener("abort", () => xhr.abort(), { once: true });
        xhr.send(body);
    });
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

export interface PartUploadOptions {
    /** 這次上傳的 id（`newUploadId()`；比一段大的檔案由伺服器給，可能是續傳的那個）。
     * This upload's id (for files above one part the server picks it, possibly the one being resumed). */
    upload: string;
    /** 上次拿到的 lease（「取代」時同一個視窗接著寫）。/ The lease from before (replacing continues in this window). */
    lease?: string | null;
    /** 完整的目標路徑。/ The full target path. */
    target: string;
    overwrite: boolean;
    /** 目標的上層資料夾不存在就建（資料夾上傳）。/ Create missing folders above the target. */
    parents: boolean;
    /** 裝置已收到的 + 這一段送出的位元組。/ Bytes on the device plus this part's bytes sent. */
    onProgress: (loaded: number) => void;
    /** 正在重送第幾次（0 = 沒有）。/ Which resend is under way (0 = none). */
    onRetry?: (attempt: number) => void;
    /** 另一個視窗剛剛還在傳（可能是剛關掉的分頁）：等它。/ Waiting for another window (maybe a tab just closed). */
    onWaitingOther?: (waiting: boolean) => void;
    /** 伺服器給了 id / lease；`resumedFrom` = 從裝置上已有的這裡接著傳。/ The server's id / lease; where it resumed. */
    onStarted?: (s: { upload: string; lease: string | null; resumedFrom: number | null }) => void;
    signal?: AbortSignal;
}

export type PartUploadResult =
    | { ok: true; path: string | null; upload: string; lease: string | null }
    | { ok: false; status: number; code: string | null; error: string | null; upload: string; lease: string | null; kept?: boolean };

export interface UploadUrls {
    /** `/api/sftp/upload-start/<id>/<account>` */
    start: string;
    /** `/api/sftp/upload-part/<id>/<account>` */
    part: string;
}

/** 本機檔案讀不到（上傳途中被刪掉或改過）。/ The local file can't be read (removed or changed meanwhile). */
class LocalChanged extends Error {}

async function readSlice(file: File, from: number, to: number): Promise<ArrayBuffer> {
    try {
        return await file.slice(from, to).arrayBuffer();
    } catch {
        throw new LocalChanged();
    }
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 另一個視窗在傳時，多久再問一次、最多問幾次（伺服器 30 秒沒動靜就讓人接手）。/ Polling another window's upload. */
const BUSY_EVERY = 10_000;
const BUSY_WAITS = 6;

interface Started {
    upload: string;
    lease: string;
    offset: number;
    check_from: number | null;
    resumed: boolean;
}

/** 問伺服器：新的上傳，或接著傳裝置上同一個檔案沒傳完的那個。/ Ask for a fresh upload or the unfinished one to continue. */
async function startUpload(url: string, file: File, opts: PartUploadOptions, resume: boolean): Promise<{ ok: true; started: Started } | { ok: false; status: number; code: string | null; error: string | null }> {
    const res = await apiFetch(url, {
        method: "POST",
        body: JSON.stringify({ path: opts.target, total: file.size, overwrite: opts.overwrite, local: localIdentity(file), resume, lease: opts.lease ?? undefined }),
    });
    const body = await readJson<Started & { code?: string; error?: string }>(res);
    if (res.ok && body?.upload) return { ok: true, started: body };
    return { ok: false, status: res.status, code: body?.code ?? null, error: body?.error ?? null };
}

/**
 * 分段上傳 `file` 到 `opts.target`。比一段大的檔案先問伺服器（`upload-start`）：同一個本機檔案沒傳完的就接著傳，
 * 接之前把本機最後那一段的 SHA-256 一起送去比對（對不上 = 裝置上的被動過或本機其實不同 → 從頭開新的）。
 * 瀏覽器沒有 WebCrypto（http 的網址）就不續傳。每一段先讀進記憶體，讀不到 = 本機檔案被刪 / 改了（`local_changed`）。
 * Upload `file` in parts. Files above one part ask `upload-start` first and continue an unfinished upload of the
 * same local file after the server compares the end of the device copy with the local bytes (a mismatch starts a
 * fresh upload). Without WebCrypto (plain http) nothing is resumed. Unreadable local bytes = `local_changed`.
 */
export async function uploadInParts(urls: UploadUrls, file: File, opts: PartUploadOptions): Promise<PartUploadResult> {
    const size = file.size;
    let upload = opts.upload;
    let lease: string | null = null;
    let offset = 0;
    let check: string | null = null;
    let attempt = 0;
    // 沒有前進的回答（例如檔案在電腦上被改短了）：幾次就停。/ Answers that make no progress stop after a few.
    let stalled = 0;
    let renewed = false;
    let steppedUp = false;
    let restarted = false;
    let fresh = false;
    const begin = async (resume: boolean): Promise<PartUploadResult | null> => {
        let st = await startUpload(urls.start, file, opts, resume && typeof crypto !== "undefined" && !!crypto.subtle);
        // 另一個視窗剛剛還在寫：伺服器分不出那是還開著的分頁、還是剛關掉的。等一下再問（最多 BUSY_WAITS 次）。
        // Another window wrote just now — an open tab or one just closed. Ask again after a while.
        for (let i = 0; !st.ok && st.code === "upload_busy" && i < BUSY_WAITS; i++) {
            opts.onWaitingOther?.(true);
            await wait(BUSY_EVERY, opts.signal);
            st = await startUpload(urls.start, file, opts, true);
        }
        opts.onWaitingOther?.(false);
        if (!st.ok) return { ok: false, status: st.status, code: st.code, error: st.error, upload, lease };
        upload = st.started.upload;
        lease = st.started.lease;
        offset = st.started.offset;
        check = null;
        if (st.started.resumed && offset > 0) {
            try {
                check = await sha256Hex(await readSlice(file, st.started.check_from ?? 0, offset));
            } catch {
                return { ok: false, status: 0, code: "local_changed", error: null, upload, lease };
            }
        }
        opts.onStarted?.({ upload, lease, resumedFrom: st.started.resumed ? offset : null });
        opts.onProgress(offset);
        return null;
    };
    if (resumable(size)) {
        const failed = await begin(true);
        if (failed) return failed;
    }
    for (;;) {
        const [start, end] = partRange(offset, size);
        const q = new URLSearchParams(partQuery({ path: opts.target, upload, offset: start, total: size, overwrite: opts.overwrite, parents: opts.parents && start === 0, retry: attempt > 0 }));
        if (lease) q.set("lease", lease);
        if (check) q.set("check", check);
        let body: ArrayBuffer;
        try {
            body = await readSlice(file, start, end);
        } catch {
            return { ok: false, status: 0, code: "local_changed", error: null, upload, lease };
        }
        const res = await put(`${urls.part}?${q.toString()}`, body, (sent) => opts.onProgress(Math.min(size, start + sent)), opts.signal);
        if (res.status === 401 && !renewed && (await refreshSession({ force: true })) === "ok") {
            renewed = true;
            continue;
        }
        if (res.status === 403 && !steppedUp && (res.body as { code?: string } | null)?.code === "step_up_required" && (await requestStepUp())) {
            steppedUp = true;
            continue;
        }
        const delay = res.status >= 200 && res.status < 300 ? null : retryDelay(res.status, attempt);
        if (delay !== null) {
            attempt += 1;
            opts.onRetry?.(attempt);
            opts.onProgress(start);
            await wait(delay, opts.signal);
            continue;
        }
        const outcome = partOutcome(res.status, res.body);
        if (outcome.kind === "done") {
            opts.onProgress(size);
            return { ok: true, path: outcome.path, upload, lease };
        }
        if (outcome.kind === "next") {
            stalled = outcome.offset > start ? 0 : stalled + 1;
            if (stalled > 3) return { ok: false, status: res.status, code: "interrupted", error: null, upload, lease };
            offset = outcome.offset;
            check = null;
            if (attempt) opts.onRetry?.(0);
            attempt = 0;
            opts.onProgress(offset);
            continue;
        }
        if (outcome.kind === "restart" && !restarted) {
            restarted = true;
            offset = 0;
            check = null;
            opts.onProgress(0);
            continue;
        }
        // 裝置上那份跟本機對不上：伺服器已經刪掉它，開一個新的從頭傳（只試一次）。
        // The device copy doesn't match the local file: the server removed it; start a fresh upload once.
        if (outcome.kind === "fresh" && !fresh) {
            fresh = true;
            const failed = await begin(false);
            if (failed) return failed;
            continue;
        }
        const fail = outcome.kind === "fail" ? outcome : { code: null, error: null, kept: false };
        return { ok: false, status: res.status, code: fail.code, error: fail.error, upload, lease, kept: fail.kept };
    }
}

/** 取消：把裝置上沒傳完的暫存檔刪掉（盡力而為）。/ Remove the unfinished part file on the device (best effort). */
export async function cancelUpload(base: string, target: string, upload: string): Promise<void> {
    try {
        await apiFetch(`${base}?${new URLSearchParams({ path: target, upload }).toString()}`, { method: "DELETE" });
    } catch {
        // 下一次同名上傳會從頭建一個新的。/ A later upload starts a fresh part file anyway.
    }
}
