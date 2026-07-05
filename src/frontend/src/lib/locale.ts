/**
 * 語言偏好的純函式與常數 — 不含 "use client",server component(root layout)與
 * client(lib/i18n.tsx)都能使用。
 * Pure locale helpers/constants — no "use client", usable from both the server root layout
 * and the client i18n provider.
 */

export type Locale = "en" | "zh-TW" | "ja";
/** 使用者偏好:明確語言或 "auto"(跟隨瀏覽器)。/ Explicit locale or "auto" (follow the browser). */
export type LanguagePreference = "auto" | Locale;

export const LANGUAGE_COOKIE = "telepy.language";
export const SUPPORTED_LOCALES: Locale[] = ["en", "zh-TW", "ja"];
export const LANGUAGE_PREFERENCES: LanguagePreference[] = ["auto", ...SUPPORTED_LOCALES];

export function isLanguagePreference(value: unknown): value is LanguagePreference {
    return typeof value === "string" && (LANGUAGE_PREFERENCES as string[]).includes(value);
}

/** 把任意語言標籤(如 zh-Hant-TW、ja-JP)對應到支援的 locale。/ Map a BCP-47 tag to a supported locale. */
export function matchLocale(tag: string): Locale | null {
    const lower = tag.toLowerCase();
    if (lower.startsWith("zh")) return "zh-TW";
    if (lower.startsWith("ja")) return "ja";
    if (lower.startsWith("en")) return "en";
    return null;
}

/**
 * 解析 Accept-Language header,取第一個支援的語言(SSR 初始語言用,與瀏覽器端
 * navigator.languages 的解析結果一致)。
 * Parse the Accept-Language header into the first supported locale (for the SSR initial
 * locale; mirrors the client-side navigator.languages resolution).
 */
export function parseAcceptLanguage(header: string | null | undefined): Locale {
    if (!header) return "en";
    const tags = header
        .split(",")
        .map((part) => {
            const [tag, ...params] = part.trim().split(";");
            const qParam = params.find((p) => p.trim().startsWith("q="));
            const q = qParam ? parseFloat(qParam.trim().slice(2)) : 1;
            return { tag: tag.trim(), q: Number.isNaN(q) ? 0 : q };
        })
        .sort((a, b) => b.q - a.q);
    for (const { tag } of tags) {
        const match = matchLocale(tag);
        if (match) return match;
    }
    return "en";
}

/** 語言選項的「原生名稱」— 語言選單固定用原文顯示,不隨介面語言翻譯。
 *  Native display names for the language picker — always shown in their own language. */
export const LOCALE_NATIVE_NAMES: Record<Locale, string> = {
    en: "English",
    "zh-TW": "繁體中文",
    ja: "日本語",
};
