/**
 * 模組層級的翻譯函式 — 給「不在 React 樹裡」的程式碼用(lib/api.ts 的錯誤訊息等)。
 * React 元件/hook 請一律用 useI18n().t;這裡的 translate() 只是給純函式的逃生口。
 * Module-level translate() for code outside the React tree (e.g. error builders in lib/api.ts).
 * Components/hooks must use useI18n().t; this is only the escape hatch for plain functions.
 *
 * I18nProvider 會在語言變更時呼叫 setActiveLocale() 同步;provider 還沒掛載時退回
 * cookie / 瀏覽器語言解析,行為與 provider 一致。
 * The I18nProvider keeps the locale in sync via setActiveLocale(); before it mounts we fall
 * back to the cookie / browser language, matching the provider's own resolution.
 */
import { en, TranslationKey } from "@/locales/en";
import { zhTW } from "@/locales/zh-TW";
import { ja } from "@/locales/ja";
import { LANGUAGE_COOKIE, isLanguagePreference, matchLocale, type Locale, type LanguagePreference } from "./locale";

export const DICTIONARIES: Record<Locale, Record<TranslationKey, string>> = {
    en,
    "zh-TW": zhTW,
    ja,
};

let activeLocale: Locale | null = null;

export function setActiveLocale(locale: Locale) {
    activeLocale = locale;
}

export function readCookiePreference(): LanguagePreference | null {
    if (typeof document === "undefined") return null;
    const raw = document.cookie
        .split("; ")
        .find((part) => part.startsWith(`${LANGUAGE_COOKIE}=`))
        ?.split("=")[1];
    return isLanguagePreference(raw) ? raw : null;
}

export function browserLocale(): Locale {
    if (typeof navigator === "undefined") return "en";
    const candidates = navigator.languages?.length ? navigator.languages : [navigator.language || "en"];
    for (const tag of candidates) {
        const match = matchLocale(tag);
        if (match) return match;
    }
    return "en";
}

export function resolveLocale(preference: LanguagePreference): Locale {
    return preference === "auto" ? browserLocale() : preference;
}

function currentLocale(): Locale {
    return activeLocale ?? resolveLocale(readCookiePreference() ?? "auto");
}

export function translate(key: TranslationKey, vars?: Record<string, string | number>): string {
    let text: string = DICTIONARIES[currentLocale()][key] ?? DICTIONARIES.en[key] ?? key;
    if (vars) {
        for (const [name, value] of Object.entries(vars)) {
            text = text.split(`{${name}}`).join(String(value));
        }
    }
    return text;
}
