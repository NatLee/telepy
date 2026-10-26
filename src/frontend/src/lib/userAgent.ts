/**
 * 把 User-Agent 縮成「瀏覽器 · 作業系統」（產品名不翻譯）；認不出來回 null。只為了讓登入紀錄好讀，不做精確判斷。
 * Shorten a User-Agent to "browser · OS" (product names, untranslated); null when unrecognised.
 */
const BROWSERS: [RegExp, string][] = [
    [/\bEdg(?:e|A|iOS)?\//, "Edge"],
    [/\bOPR\/|\bOpera\b/, "Opera"],
    [/\bSamsungBrowser\//, "Samsung Internet"],
    [/\bFirefox\/|\bFxiOS\//, "Firefox"],
    [/\bChrome\/|\bCriOS\/|\bChromium\//, "Chrome"],
    [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
    [/^curl\//, "curl"],
];

const SYSTEMS: [RegExp, string][] = [
    [/\b(?:iPhone|iPad|iPod)\b/, "iOS"],
    [/\bAndroid\b/, "Android"],
    [/\bCrOS\b/, "ChromeOS"],
    [/\bWindows\b/, "Windows"],
    [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
    [/\bLinux\b/, "Linux"],
];

/** 瀏覽器與作業系統（各自認不出來為 null）。後端 `auth::devices::ua_family` 用同一張表。
 *  Browser and OS, each null when unrecognised; the backend's `auth::devices::ua_family` uses the same table. */
export function parseUserAgent(ua: string | null | undefined): { browser: string | null; os: string | null } {
    if (!ua) return { browser: null, os: null };
    return {
        browser: BROWSERS.find(([re]) => re.test(ua))?.[1] ?? null,
        os: SYSTEMS.find(([re]) => re.test(ua))?.[1] ?? null,
    };
}

export function describeUserAgent(ua: string | null | undefined): string | null {
    const { browser, os } = parseUserAgent(ua);
    const parts = [browser, os].filter(Boolean);
    return parts.length ? parts.join(" · ") : null;
}
