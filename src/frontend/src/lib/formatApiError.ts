/**
 * Parse various API/DRF error response shapes into a single human-readable string.
 *
 * Handles:
 * - Plain strings
 * - `{ error: "..." }` or `{ detail: "..." }` or `{ message: "..." }`
 * - Field-level validation arrays: `{ field1: ["err"], field2: ["err"] }`
 * - Nested non_field_errors
 *
 * @param data - The parsed JSON body (or string) from a failed API response.
 * @param fallback - Fallback message if nothing useful can be extracted.
 */
export function formatApiError(data: unknown, fallback = "An unexpected error occurred."): string {
    if (data === null || data === undefined) return fallback;

    // Already a string
    if (typeof data === "string") return data || fallback;

    // Not an object — stringify as last resort
    if (typeof data !== "object") return String(data);

    const obj = data as Record<string, unknown>;

    // Common single-value keys
    for (const key of ["error", "detail", "message"]) {
        if (typeof obj[key] === "string" && obj[key]) return obj[key] as string;
    }

    // non_field_errors (DRF)
    if (Array.isArray(obj.non_field_errors) && obj.non_field_errors.length > 0) {
        return obj.non_field_errors.join("; ");
    }

    // Field-level validation: { field: ["msg", ...], ... }
    const parts: string[] = [];
    for (const [field, value] of Object.entries(obj)) {
        if (Array.isArray(value) && value.length > 0) {
            parts.push(`${field}: ${value.join(", ")}`);
        } else if (typeof value === "string" && value) {
            parts.push(`${field}: ${value}`);
        }
    }

    if (parts.length > 0) return parts.join("; ");

    return fallback;
}
