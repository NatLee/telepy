"use client";

/**
 * 有進度的上傳：fetch 拿不到上傳進度，所以用 XMLHttpRequest。和 apiFetch 一樣在送出當下讀 token（背景續期後也對），
 * 401 續期一次再送、403 `step_up_required` 確認是你之後再送一次。
 * Upload with progress (fetch has no upload progress, hence XHR). Like apiFetch it reads the token at send time,
 * renews once on 401 and retries once after a step-up on 403 `step_up_required`.
 */
import { refreshSession } from "@/lib/api";
import { requestStepUp, STEP_UP_HEADER, stepUpToken } from "@/lib/stepUp";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

export interface UploadResult {
    status: number;
    body: unknown;
}

function send(url: string, file: File, onProgress: (loaded: number) => void, signal?: AbortSignal): Promise<UploadResult> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${API_BASE}${url}`);
        const token = localStorage.getItem("accessToken");
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        const stepUp = stepUpToken();
        if (stepUp) xhr.setRequestHeader(STEP_UP_HEADER, stepUp);
        xhr.upload.onprogress = (e) => onProgress(e.loaded);
        xhr.onload = () => {
            let body: unknown = null;
            try {
                body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
            } catch {
                body = null;
            }
            resolve({ status: xhr.status, body });
        };
        xhr.onerror = () => reject(new Error("network"));
        xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
        signal?.addEventListener("abort", () => xhr.abort(), { once: true });
        const form = new FormData();
        form.append("file", file);
        xhr.send(form);
    });
}

export async function uploadWithProgress(url: string, file: File, onProgress: (loaded: number) => void, signal?: AbortSignal): Promise<UploadResult> {
    let res = await send(url, file, onProgress, signal);
    if (res.status === 401 && (await refreshSession({ force: true })) === "ok") {
        res = await send(url, file, onProgress, signal);
    }
    if (res.status === 403 && (res.body as { code?: string } | null)?.code === "step_up_required" && (await requestStepUp())) {
        res = await send(url, file, onProgress, signal);
    }
    return res;
}
