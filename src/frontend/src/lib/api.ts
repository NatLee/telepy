/**
 * API client configuration and shared fetch logic.
 */

import { formatApiError } from "./formatApiError";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

/**
 * 安全地將 Response body 解析為 JSON。
 * Safely parse a Response body as JSON.
 *
 * 反向代理（Traefik/Nginx）在後端無法連線時，會回傳「純文字」body（例如 502 的
 * "Bad Gateway"）或 HTML 錯誤頁，而非 JSON。直接呼叫 res.json() 會丟出難懂的
 * `Unexpected token 'B', "Bad Gateway" is not valid JSON`，並外洩給使用者。
 * 此函式先讀成文字、僅在確實是合法 JSON 時才解析，否則回傳 null，讓呼叫端能改用
 * 以 HTTP 狀態碼為基礎的友善訊息（見 responseError）。
 *
 * A reverse proxy returns 5xx with a plain-text/HTML body (not JSON); res.json() on that
 * throws the cryptic "Unexpected token 'B'..." SyntaxError. Read text first, parse only
 * valid JSON, else return null so callers can fall back to a status-based message.
 */
export async function readJson<T = unknown>(res: Response): Promise<T | null> {
    let text: string;
    try {
        text = await res.text();
    } catch {
        return null;
    }
    if (!text) return null;
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

/**
 * 依據失敗的 Response 產生「人類可讀」的錯誤訊息。
 * Build a human-readable error message for a failed Response.
 *
 * 優先使用結構化 API 錯誤 body（{detail}/{error}/{field:[...]}）；當 body 非 JSON
 * 或為空（通常是後端啟動中/掛掉造成的代理錯誤）時，改用 HTTP 狀態碼訊息。
 * Prefer a structured API error body; fall back to a status-based message (e.g. proxy 5xx).
 */
export function responseError(
    res: Response,
    body: unknown,
    fallback = "Request failed."
): string {
    const fromBody = formatApiError(body, "");
    if (fromBody) return fromBody;

    if (res.status === 502 || res.status === 503 || res.status === 504) {
        return `Server unavailable (${res.status}). The backend may be starting up — please try again in a moment.`;
    }
    if (res.status >= 500) {
        return `Server error (${res.status}). Please try again shortly.`;
    }
    if (res.status === 0) {
        return "Cannot reach the server. Please check your network connection.";
    }
    return `${fallback} (${res.status})`;
}

export async function apiFetch(
    endpoint: string,
    options: RequestInit = {}
): Promise<Response> {
    // Prefix appropriate url
    const url = endpoint.startsWith("http") ? endpoint : `${API_BASE}${endpoint}`;

    // Read token from localStorage directly
    const accessToken =
        typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;

    const headers = new Headers(options.headers || {});
    // Do not set Content-Type for FormData — browser must set multipart/form-data with boundary
    const isFormData = options.body instanceof FormData;
    if (!isFormData) {
        headers.set("Content-Type", "application/json");
    }

    if (accessToken) {
        headers.set("Authorization", `Bearer ${accessToken}`);
    }

    let response = await fetch(url, { ...options, headers });

    // Handle 401 Unauthorized globally
    if (response.status === 401 && typeof window !== "undefined") {
        // Attempt to refresh (we could do it automatically or redirect)
        // For now we will just emit a custom event to trigger logout 
        // or handle refresh if needed. Let's redirect to login.
        window.dispatchEvent(new CustomEvent("api:unauthorized"));
    }

    return response;
}
