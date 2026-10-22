/**
 * 裝置金鑰端點的錯誤碼 → 在地化訊息（`{error, code}`）；沒有對應的碼就用後端原文 / 通用錯誤。
 * Maps the device-key endpoints' `{error, code}` bodies to localized text; unknown codes fall back to the
 * server text or a generic message.
 */
import { responseError } from "@/lib/api";
import { translate } from "@/lib/translate";
import type { TranslationKey } from "@/locales/en";

const CODES: Record<string, TranslationKey> = {
    device_offline: "keys.err.deviceOffline",
    not_manager: "keys.err.notManager",
    in_key_list: "keys.err.inKeyList",
    service_key: "keys.err.serviceKey",
    not_your_key: "keys.err.notYourKey",
    timeout: "keys.err.timeout",
};

export function deviceKeyError(res: Response, body: unknown, fallback: string): string {
    const b = body as { code?: string; error?: string } | null;
    if (b?.code && CODES[b.code]) return translate(CODES[b.code]);
    if (b?.code === "device_error" && b.error) return translate("keys.err.deviceError", { detail: b.error });
    return responseError(res, body, fallback);
}

/** 只要錯誤碼（用來決定畫面狀態）。/ Just the code, for UI state. */
export function errorCode(body: unknown): string | null {
    const b = body as { code?: string } | null;
    return b?.code ?? null;
}
