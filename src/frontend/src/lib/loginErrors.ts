/**
 * 登入錯誤的在地化：後端（Google 登入等）回 `{detail, code, …}`，有對應 code 就用字典，否則退回後端的英文 detail。
 * Localised login errors: known backend codes map to dictionary keys; otherwise the caller falls back to `detail`.
 */
import type { Translate } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";

const CODE_KEYS: Record<string, TranslationKey> = {
    google_not_configured: "login.googleNotConfigured",
    google_unreachable: "login.googleUnreachable",
    google_expired: "login.googleExpired",
    google_client_mismatch: "login.googleClientMismatch",
    google_invalid: "login.googleInvalid",
    google_no_email: "login.googleNoEmail",
    google_domain_not_allowed: "login.googleDomainNotAllowed",
    registration_closed: "login.registrationClosed",
    google_account_conflict: "login.googleAccountConflict",
    account_disabled: "login.accountDisabled",
};

export function loginErrorMessage(t: Translate, body: unknown): string | null {
    const b = (body ?? {}) as { code?: string; domain?: string; username?: string };
    const key = b.code ? CODE_KEYS[b.code] : undefined;
    return key ? t(key, { domain: b.domain ?? "", username: b.username ?? "" }) : null;
}
