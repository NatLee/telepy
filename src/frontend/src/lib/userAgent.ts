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

export function describeUserAgent(ua: string | null | undefined): string | null {
    if (!ua) return null;
    const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
    const os = SYSTEMS.find(([re]) => re.test(ua))?.[1];
    const parts = [browser, os].filter(Boolean);
    return parts.length ? parts.join(" · ") : null;
}
