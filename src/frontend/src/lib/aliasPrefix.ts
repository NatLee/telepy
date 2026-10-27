/**
 * 存裝置別名前綴（個人設定 `ssh_alias_prefix`）；回錯誤訊息（後端的欄位錯誤）或 null。
 * Save the device alias prefix (personal setting `ssh_alias_prefix`); returns the error (the backend's field error) or null.
 */
import { apiFetch } from "./api";

export async function saveAliasPrefix(prefix: string, fallbackError: string): Promise<string | null> {
    try {
        const res = await apiFetch("/api/user/settings", { method: "POST", body: JSON.stringify({ ssh_alias_prefix: prefix }) });
        if (res.ok) return null;
        const body = await res.json().catch(() => null);
        const field = body?.ssh_alias_prefix;
        return (Array.isArray(field) ? field[0] : null) ?? fallbackError;
    } catch {
        return fallbackError;
    }
}

/** 別名去掉前綴（給預覽用的裝置名稱）。/ An alias without the prefix (the preview's device name). */
export function withoutPrefix(alias: string | undefined, prefix: string): string {
    if (!alias) return "pi";
    return prefix && alias.startsWith(prefix) ? alias.slice(prefix.length) : alias;
}
