/**
 * API client configuration and shared fetch logic.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

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
