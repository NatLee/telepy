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
import { apiFetch, refreshSession } from "@/lib/api";
import { requestStepUp, STEP_UP_HEADER, stepUpToken } from "@/lib/stepUp";
import { partOutcome, partQuery, partRange, retryDelay } from "@/lib/uploadParts";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

interface XhrResult {
    status: number;
    body: unknown;
}

function put(url: string, body: Blob, onProgress: (sent: number) => void, signal?: AbortSignal): Promise<XhrResult> {
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
    /** 這次上傳的 id（`newUploadId()`；取消時用它刪暫存檔）。/ This upload's id (cancelling removes its part file). */
    upload: string;
    /** 完整的目標路徑。/ The full target path. */
    target: string;
    overwrite: boolean;
    /** 目標的上層資料夾不存在就建（資料夾上傳）。/ Create missing folders above the target. */
    parents: boolean;
    /** 裝置已收到的 + 這一段送出的位元組。/ Bytes on the device plus this part's bytes sent. */
    onProgress: (loaded: number) => void;
    /** 正在重送第幾次（0 = 沒有）。/ Which resend is under way (0 = none). */
    onRetry?: (attempt: number) => void;
    signal?: AbortSignal;
}

export type PartUploadResult = { ok: true; path: string | null; upload: string } | { ok: false; status: number; code: string | null; error: string | null; upload: string };

/** `base` = `/api/sftp/upload-part/<id>/<account>`。/ Upload `file` to `opts.target` in parts. */
export async function uploadInParts(base: string, file: File, opts: PartUploadOptions): Promise<PartUploadResult> {
    const upload = opts.upload;
    const size = file.size;
    let offset = 0;
    let attempt = 0;
    // 沒有前進的回答（例如檔案在電腦上被改短了）：幾次就停。/ Answers that make no progress stop after a few.
    let stalled = 0;
    let renewed = false;
    let steppedUp = false;
    let restarted = false;
    for (;;) {
        const [start, end] = partRange(offset, size);
        const url = `${base}?${partQuery({ path: opts.target, upload, offset: start, total: size, overwrite: opts.overwrite, parents: opts.parents && start === 0, retry: attempt > 0 })}`;
        const res = await put(url, file.slice(start, end), (sent) => opts.onProgress(Math.min(size, start + sent)), opts.signal);
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
            return { ok: true, path: outcome.path, upload };
        }
        if (outcome.kind === "next") {
            stalled = outcome.offset > start ? 0 : stalled + 1;
            if (stalled > 3) return { ok: false, status: res.status, code: "interrupted", error: null, upload };
            offset = outcome.offset;
            if (attempt) opts.onRetry?.(0);
            attempt = 0;
            opts.onProgress(offset);
            continue;
        }
        if (outcome.kind === "restart" && !restarted) {
            restarted = true;
            offset = 0;
            opts.onProgress(0);
            continue;
        }
        const fail = outcome.kind === "fail" ? outcome : { code: null, error: null };
        return { ok: false, status: res.status, code: fail.code, error: fail.error, upload };
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
