/**
 * 兩步驟驗證的共用型別與錯誤訊息：後端錯誤是 `{error, code}`，依 code 對應字典（與 remote-browser 的 code 對應相同做法）。
 * 驗證失敗是 400（不是 401），所以 apiFetch 不會把人登出。
 * Shared two-factor types and error messages: backend errors are `{error, code}`; codes map to dictionary keys.
 */
import type { TranslationKey } from "@/locales/en";

export type MfaMethod = "passkey" | "totp" | "recovery_code";

/** 再驗證 / 登入第二步的證明。/ A second-factor proof (login step or re-authentication). */
export type MfaProof =
    | { method: "totp" | "recovery_code"; code: string }
    | { method: "passkey"; challenge_id: string; credential: unknown };

export interface MfaErrorBody {
    error?: string;
    code?: string;
    methods?: MfaMethod[];
}

const CODE_KEYS: Record<string, TranslationKey> = {
    mfa_invalid: "security.errInvalid",
    mfa_expired: "security.errExpired",
    mfa_locked: "security.errLocked",
    passkey_failed: "security.errPasskeyFailed",
    passkey_unavailable: "security.errPasskeyUnavailable",
};

/** 有對應 code 就用字典，否則用後端訊息或 fallback。/ Dictionary text for known codes, else the server text. */
export function mfaErrorMessage(t: (key: TranslationKey) => string, body: unknown, fallback: string): string {
    const b = (body ?? {}) as MfaErrorBody;
    if (b.code && CODE_KEYS[b.code]) return t(CODE_KEYS[b.code]);
    return b.error || fallback;
}

/** 403 + code=reauth_required：這個操作要再驗證。/ The action needs re-authentication. */
export function needsReauth(status: number, body: unknown): MfaMethod[] | null {
    const b = (body ?? {}) as MfaErrorBody;
    return status === 403 && b.code === "reauth_required" ? b.methods ?? [] : null;
}
