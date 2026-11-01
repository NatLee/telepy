/**
 * 登入表單發生了什麼（送出結果）：失敗、成功、進到兩步驟。用一個視窗事件廣播，登入頁的外框（Tapi 版）聽了做反應，
 * 不必把狀態一路傳進 LoginForm。只在同一個分頁裡，不帶任何帳號資料。
 * What happened on the sign-in form: a failure, success, or the second step. Broadcast as a window event so the page
 * frame (the Tapi look) can react without threading state through LoginForm. Same tab only, no account data.
 */
export type SignInSignal = "error" | "success" | "mfa";

const EVENT = "telepy:sign-in";

export function announceSignIn(kind: SignInSignal): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent<SignInSignal>(EVENT, { detail: kind }));
}

/** 聽某個視窗的登入訊號（預覽框裡的頁面聽自己的視窗）；回傳取消函式。/ Listen on a window; returns the unsubscribe. */
export function onSignIn(win: Window, listener: (kind: SignInSignal) => void): () => void {
    const handler = (e: Event) => listener((e as CustomEvent<SignInSignal>).detail);
    win.addEventListener(EVENT, handler);
    return () => win.removeEventListener(EVENT, handler);
}
