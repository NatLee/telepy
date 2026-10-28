/**
 * 登入頁要畫成哪個樣子：每次載入頁面向公開的 `/api/auth/sign-in-page` 問一次，答案記在 localStorage
 * （`telepy.signinLook`），下次一打開就是對的樣子、不用等。知道之前回 null，頁面只畫空的外框——
 * 所以靜態 HTML 與第一個畫面在兩種樣子下都一樣，不會先閃過產品介紹。
 * Which look the sign-in pages use: asked once per page load from the public endpoint and remembered in localStorage
 * (`telepy.signinLook`) so the next visit paints the right look at once. Null until known; the pages then paint an
 * empty frame, so the static HTML and the first frame are the same for both looks and never flash the product copy.
 */
import { useSyncExternalStore } from "react";
import { DEFAULT_LOOK, parseSignInLook, type SignInLook } from "@/lib/signinLook";

const STORAGE_KEY = "telepy.signinLook";
const listeners = new Set<() => void>();
/** undefined = 還沒讀快取。/ undefined = the cache has not been read yet. */
let current: SignInLook | null | undefined;
let asked = false;

function readCache(): SignInLook | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? parseSignInLook(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
}

function publish(next: SignInLook) {
    const same =
        current &&
        current.style === next.style &&
        current.oauthStyle === next.oauthStyle &&
        current.cliStyle === next.cliStyle &&
        current.consentStyle === next.consentStyle &&
        current.message === next.message;
    current = next;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
        // 寫不進去就只記在這次。/ Storage blocked: keep it for this page only.
    }
    if (!same) listeners.forEach((l) => l());
}

/**
 * 問後端。舊後端沒有這支（404）或回了看不懂的東西 = 一般樣子；連不上時有快取就用快取，沒有才用一般樣子。
 * Ask the backend. An older backend (404) or an odd answer = standard; when unreachable, the cache wins if any.
 */
async function ask() {
    const base = process.env.NEXT_PUBLIC_API_BASE || "";
    try {
        const res = await fetch(`${base}/api/auth/sign-in-page`, { cache: "no-store" });
        const look = res.ok ? parseSignInLook(await res.json().catch(() => null)) : null;
        publish(look ?? DEFAULT_LOOK);
    } catch {
        publish(current ?? DEFAULT_LOOK);
    }
}

/** 每次有登入頁掛上來就重問一次（管理員剛改過、登出後回到登入頁）。/ Re-asked whenever a sign-in page mounts again. */
function subscribe(listener: () => void) {
    listeners.add(listener);
    if (!asked) {
        asked = true;
        void ask();
    }
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) asked = false;
    };
}

/** 網站設定存好後更新這個瀏覽器的快取（登出時馬上是新的樣子）。/ Refresh this browser's cache after a save. */
export function rememberSignInLook(look: SignInLook) {
    publish(look);
}

function snapshot(): SignInLook | null {
    if (current === undefined) current = readCache();
    return current;
}

export function useSignInLook(): SignInLook | null {
    return useSyncExternalStore(subscribe, snapshot, () => null);
}
