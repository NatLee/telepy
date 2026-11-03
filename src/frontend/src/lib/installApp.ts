/**
 * 裝成 app（PWA）的純函式：app 名稱（跟後端 `app_manifest.rs` 同一套規則，網站設定的預覽用）與「這台瀏覽器怎麼安裝」。
 * Pure helpers for installing Telepy as an app (PWA): the app name (the same rule as the backend's `app_manifest.rs`,
 * for the site settings preview) and "how this browser installs it".
 */

export const APP_NAME_MODES = ["telepy", "domain", "custom"] as const;
export type AppNameMode = (typeof APP_NAME_MODES)[number];
export const DEFAULT_APP_NAME = "Telepy";
/** 自訂名稱的上限（= 後端 `NAME_MAX`）。/ The custom name's limit (= the backend's `NAME_MAX`). */
export const APP_NAME_MAX = 30;
/** 主畫面上的名稱大約只看得到這麼多字。/ About how much of the name a home screen shows. */
export const HOME_LABEL_CHARS = 12;

export function isAppNameMode(v: unknown): v is AppNameMode {
    return typeof v === "string" && (APP_NAME_MODES as readonly string[]).includes(v);
}

/** 中間連續空白（含換行、tab）縮成一個、去頭尾。/ Inner whitespace (newlines, tabs) collapsed, trimmed. */
export function tidyAppName(raw: string): string {
    return raw.split(/\s+/).filter(Boolean).join(" ");
}

/** 自訂名稱哪裡不行；null = 可以。/ What is wrong with a custom name; null = fine. */
export function appNameProblem(raw: string): "control" | "tooLong" | null {
    // 控制字元（空白類除外：換行、tab 會變成空格）。/ Control characters (whitespace ones become spaces).
    if (/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/.test(raw)) return "control";
    if ([...tidyAppName(raw)].length > APP_NAME_MAX) return "tooLong";
    return null;
}

/** 實際的名稱：網域沒有 / 自訂空白 = Telepy。/ The name in use: no domain / a blank custom name = Telepy. */
export function appNameFor(mode: AppNameMode, custom: string, host: string | null): string {
    if (mode === "domain") return host?.trim() || DEFAULT_APP_NAME;
    if (mode === "custom") return tidyAppName(custom) || DEFAULT_APP_NAME;
    return DEFAULT_APP_NAME;
}

/**
 * 「網域」選項用的主機：公開網址（PUBLIC_URL / 網站設定）的主機，沒有就是現在開著的網址的主機，小寫、不含埠。
 * The host for the domain choice: the public address's host, else the one in the address bar; lower-cased, no port.
 */
export function appHost(publicUrl: string | null | undefined, here: string): string | null {
    if (publicUrl) {
        try {
            return new URL(publicUrl).hostname.toLowerCase() || null;
        } catch {
            /* 壞掉的網址就用現在的 / a broken URL falls back to the current host */
        }
    }
    return here ? here.toLowerCase() : null;
}

/** 主畫面上看起來的樣子（太長就截掉加「…」）。/ How a home screen shows it (cut with an ellipsis when long). */
export function homeLabel(name: string): string {
    const chars = [...name];
    return chars.length > HOME_LABEL_CHARS ? `${chars.slice(0, HOME_LABEL_CHARS - 1).join("")}…` : name;
}

/**
 * 這台瀏覽器怎麼安裝：已經是 app / 不是 HTTPS（裝不了）/ 瀏覽器給了安裝鈕 / 各平台自己的選單。
 * How this browser installs it: already an app / not HTTPS (can't) / the browser offers a prompt / each platform's menu.
 */
export type InstallGuide = "installed" | "insecure" | "prompt" | "ios" | "android" | "macSafari" | "chromium" | "firefox" | "other";

export interface InstallEnv {
    ua: string;
    /** 現在就是自己的視窗（display-mode standalone / iOS 的 navigator.standalone）。/ Running in its own window already. */
    standalone: boolean;
    /** 安全環境（HTTPS 或 localhost）。/ A secure context (HTTPS or localhost). */
    secure: boolean;
    /** 收到 `beforeinstallprompt`（Chrome / Edge）。/ A `beforeinstallprompt` arrived (Chrome / Edge). */
    canPrompt: boolean;
    /** `navigator.maxTouchPoints`：iPad 的 Safari 自稱是 Mac。/ iPad Safari calls itself a Mac. */
    touchPoints: number;
}

export function installGuide(env: InstallEnv): InstallGuide {
    if (env.standalone) return "installed";
    if (!env.secure) return "insecure";
    if (env.canPrompt) return "prompt";
    const ua = env.ua;
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && env.touchPoints > 1)) return "ios";
    if (/Android/.test(ua)) return "android";
    if (/Firefox\//.test(ua)) return "firefox";
    if (/Edg\/|Chrome\/|Chromium\//.test(ua)) return "chromium";
    if (/Macintosh/.test(ua) && /Version\/[\d.]+.*Safari\//.test(ua)) return "macSafari";
    return "other";
}

/**
 * 說明圖：按下 Ctrl+W 會到哪裡（Windows / Linux）。分頁裡瀏覽器先吃掉、關掉分頁；app 視窗裡交給頁面——焦點在終端機就是
 * shell 的「刪前一個字」，不在終端機就關掉整個視窗。
 * The diagram: where Ctrl+W goes (Windows / Linux). In a tab the browser takes it and closes the tab; in an app window
 * the page gets it — the shell's "delete a word" with the focus in the terminal, the whole window closes otherwise.
 */
export type KeyWhere = "tab" | "app";
export type KeyFocus = "terminal" | "elsewhere";
export interface KeyPath {
    window: "ok" | "failed";
    terminal: "ok" | "waiting";
    shell: "ok" | "waiting";
    outcome: "tabCloses" | "windowCloses" | "deletesWord";
}

export function keyPath(where: KeyWhere, focus: KeyFocus): KeyPath {
    if (where === "tab") return { window: "failed", terminal: "waiting", shell: "waiting", outcome: "tabCloses" };
    if (focus === "elsewhere") return { window: "failed", terminal: "waiting", shell: "waiting", outcome: "windowCloses" };
    return { window: "ok", terminal: "ok", shell: "ok", outcome: "deletesWord" };
}
