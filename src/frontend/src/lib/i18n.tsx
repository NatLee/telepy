"use client";

/**
 * i18n Context：語言偏好解析、翻譯函式 t()、cookie 與後端同步。
 * i18n context: language preference resolution, the t() function, cookie + backend sync.
 *
 * - 支援語言 / Supported locales: en, zh-TW, ja。偏好值多一個 "auto"(跟隨瀏覽器語言)。
 * - 偏好儲存 / Preference storage: cookie `telepy.language`(未登入也有效,且 server layout 可讀取
 *   來做 SSR 正確的初始語言,避免 hydration 閃爍)。登入後另存到後端 UserSettings 供跨裝置同步。
 *   Stored in the `telepy.language` cookie (works pre-login; the server root layout reads it for a
 *   flash-free SSR initial locale). After login it also syncs to the backend UserSettings.
 * - 同步規則 / Sync rules: 使用者改語言 → 寫 cookie + POST 後端;登入後若後端已有明確偏好則套用,
 *   後端還沒設定過(null)則把本機偏好推上去。
 *   On change → write cookie + POST backend. After login: apply the backend value if set;
 *   if the backend value is still null (never chosen), push the local preference up instead.
 * - 翻譯 / Translations: locales/en.ts 是 key 的唯一來源(TranslationKey 型別),zh-TW/ja 以
 *   Record<TranslationKey, string> 強制補齊 — 少 key 會編譯錯誤。t() 支援 {var} 插值。
 *   en.ts is the source of truth for keys; zh-TW/ja must cover every key (compile error otherwise).
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { TranslationKey } from "@/locales/en";
import { apiFetch } from "./api";
import { useAuth } from "./auth";
import {
    LANGUAGE_COOKIE,
    isLanguagePreference,
    type Locale,
    type LanguagePreference,
} from "./locale";
import { DICTIONARIES, readCookiePreference, resolveLocale, setActiveLocale } from "./translate";

// 讓既有匯入點不用改:純函式與常數實際住在 lib/locale.ts(server 也能用)。
// Re-export so callers keep one import point; the pure bits live in lib/locale.ts (server-safe).
export { LANGUAGE_COOKIE, SUPPORTED_LOCALES, LANGUAGE_PREFERENCES, isLanguagePreference, matchLocale, LOCALE_NATIVE_NAMES } from "./locale";
export type { Locale, LanguagePreference } from "./locale";
export { resolveLocale } from "./translate";

function writeCookiePreference(preference: LanguagePreference) {
    if (typeof document === "undefined") return;
    // 一年效期;SameSite=Lax 讓一般導覽都帶得到。/ One year; SameSite=Lax covers normal navigation.
    document.cookie = `${LANGUAGE_COOKIE}=${preference}; path=/; max-age=31536000; SameSite=Lax`;
}

export type TranslateVars = Record<string, string | number>;
export type Translate = (key: TranslationKey, vars?: TranslateVars) => string;
/** tn():插值可以是 ReactNode(例如 <code>路徑</code>),翻譯句不用被拆開。
 *  tn(): interpolations may be ReactNodes (e.g. <code>path</code>) so sentences stay whole. */
export type TranslateNode = (key: TranslationKey, vars: Record<string, React.ReactNode>) => React.ReactNode;

interface I18nContextType {
    /** 使用者偏好(可能是 "auto")。/ The stored preference (may be "auto"). */
    language: LanguagePreference;
    /** 實際生效的語言。/ The resolved, effective locale. */
    locale: Locale;
    t: Translate;
    tn: TranslateNode;
    /** 使用者主動切換:寫 cookie 並(已登入時)同步到後端。/ User action: persist cookie + backend. */
    setLanguage: (preference: LanguagePreference) => void;
    /** 套用後端設定(不回寫後端,避免循環)。/ Apply the backend value without writing it back. */
    applyServerLanguage: (preference: LanguagePreference) => void;
}

const I18nContext = createContext<I18nContextType>({
    language: "auto",
    locale: "en",
    t: (key) => key,
    tn: (key) => key,
    setLanguage: () => { },
    applyServerLanguage: () => { },
});

export function I18nProvider({
    children,
    initialPreference = "auto",
    initialLocale = "en",
}: {
    children: React.ReactNode;
    /** Server layout 由 cookie / Accept-Language 算出的初始值,確保 SSR 與首次 render 一致。
     *  Initial values computed server-side (cookie / Accept-Language) so SSR matches hydration. */
    initialPreference?: LanguagePreference;
    initialLocale?: Locale;
}) {
    const [language, setLanguageState] = useState<LanguagePreference>(initialPreference);
    const [locale, setLocale] = useState<Locale>(initialLocale);

    // 掛載後以瀏覽器實際狀態校正一次(cookie 被清、或 server 對 auto 的推測與 navigator 不同)。
    // After mount, reconcile once with the real browser state (cleared cookie, or the server's
    // Accept-Language guess for "auto" differing from navigator.language).
    useEffect(() => {
        const stored = readCookiePreference() ?? language;
        setLanguageState(stored);
        setLocale(resolveLocale(stored));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 讓 <html lang> 與模組層級 translate()(lib/translate.ts)跟著生效語言走。
    // Keep <html lang> and the module-level translate() (lib/translate.ts) in sync.
    useEffect(() => {
        document.documentElement.lang = locale;
        setActiveLocale(locale);
    }, [locale]);

    const applyPreference = useCallback((preference: LanguagePreference) => {
        setLanguageState(preference);
        setLocale(resolveLocale(preference));
        writeCookiePreference(preference);
    }, []);

    const setLanguage = useCallback((preference: LanguagePreference) => {
        applyPreference(preference);
        // 已登入才同步後端;失敗不影響本機切換(下次登入會再同步)。
        // Sync to the backend only when logged in; a failure keeps the local switch intact.
        if (typeof localStorage !== "undefined" && localStorage.getItem("accessToken")) {
            apiFetch("/api/user/settings", {
                method: "POST",
                body: JSON.stringify({ language: preference }),
            }).catch(() => { });
        }
    }, [applyPreference]);

    const t = useCallback<Translate>((key, vars) => {
        let text: string = DICTIONARIES[locale][key] ?? DICTIONARIES.en[key] ?? key;
        if (vars) {
            for (const [name, value] of Object.entries(vars)) {
                text = text.split(`{${name}}`).join(String(value));
            }
        }
        return text;
    }, [locale]);

    const tn = useCallback<TranslateNode>((key, vars) => {
        const template: string = DICTIONARIES[locale][key] ?? DICTIONARIES.en[key] ?? key;
        // 依 {placeholder} 切開,把對應的 ReactNode 塞回去。/ Split on {placeholder}s, splice nodes in.
        const parts = template.split(/(\{\w+\})/g);
        return parts.map((part, index) => {
            const match = /^\{(\w+)\}$/.exec(part);
            if (match && match[1] in vars) {
                return <React.Fragment key={index}>{vars[match[1]]}</React.Fragment>;
            }
            return part;
        });
    }, [locale]);

    const value = useMemo(
        () => ({ language, locale, t, tn, setLanguage, applyServerLanguage: applyPreference }),
        [language, locale, t, tn, setLanguage, applyPreference],
    );

    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);

/**
 * 登入後的語言同步橋接(放在 AuthProvider 內、每頁一次):
 * - 後端已有明確偏好 → 套用到本機(跨裝置同步)。
 * - 後端還沒設定過(null)→ 把本機偏好推上去,不覆蓋使用者在這台裝置上的選擇。
 * Post-login language sync bridge (mounted once inside AuthProvider):
 * apply the backend preference if set; otherwise push the local preference up.
 */
export function UserLanguageSync() {
    const { user } = useAuth();
    const { language, applyServerLanguage } = useI18n();
    const syncedRef = useRef(false);

    useEffect(() => {
        if (!user) {
            // 登出後重置,讓下一個登入的帳號會再同步一次。/ Reset on logout for the next account.
            syncedRef.current = false;
            return;
        }
        if (syncedRef.current) return;
        syncedRef.current = true;

        const serverLanguage = (user as { language?: unknown }).language;
        if (isLanguagePreference(serverLanguage)) {
            if (serverLanguage !== language) applyServerLanguage(serverLanguage);
        } else if (serverLanguage === null) {
            apiFetch("/api/user/settings", {
                method: "POST",
                body: JSON.stringify({ language }),
            }).catch(() => { });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user]);

    return null;
}
