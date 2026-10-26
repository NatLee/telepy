"use client";

/**
 * 認證 Context：Token 儲存、401 處理、Profile 取得與登入/登出，以及登入 session 的背景續期。
 * Auth context: token storage, 401 handling, profile fetch, login/logout and background session renewal.
 * - Token 儲存：login 時寫入 localStorage accessToken/refreshToken；logout 與驗證失敗時清除。
 *   Token storage: write accessToken/refreshToken on login; clear on logout or verify failure.
 * - 401 處理：lib/api 先用 refresh token 續期再重送；續期被拒才派送 api:unauthorized，此處監聽並登出導向登入頁。
 *   401 handling: lib/api renews and retries first; only a refused renewal dispatches api:unauthorized, which logs out here.
 * - 背景續期：access token 到期前兩分鐘換一顆（lib/session 算時間、lib/api 的 refreshSession 單飛 + 跨分頁鎖）；
 *   分頁回到前景時（電腦睡醒、分頁被節流）若快到期就馬上換。後端每次續期都把登入效期往後推（網站設定
 *   signin_lifetime），所以常用的人不會被登出。
 *   Background renewal: two minutes before the access token expires (timing in lib/session, single flight +
 *   cross-tab lock in lib/api); when a tab returns to the foreground it renews at once if due. The backend
 *   slides the sign-in's expiry on every renewal (site setting signin_lifetime), so active users stay signed in.
 * - context 的 accessToken 在背景續期時**不更新**：終端機 / 檔案管理 / 遠端瀏覽器的 effect 以它為相依，更新會把
 *   session 全部砍掉重連；要送出的地方一律從 localStorage 取最新值（apiFetch、socket 的 auth 訊息都是）。
 *   The context's accessToken is **not** updated on background renewals: the terminal / file manager / remote
 *   browser effects depend on it and would tear their sessions down; senders read the live token from localStorage.
 * - Profile 取得時機：initAuth 驗證 token 後、refresh 成功後、login 時。
 *   Profile fetch: after token verify in initAuth, after refresh success, and on login.
 */
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { UserProfile, AuthContextType } from "../types/auth";
import { ACCESS_TOKEN_EVENT, refreshSession, revokeSession } from "./api";
import { isAuthorizePath, loginPathFor } from "./oauthFlow";
import { accessTokenExpiring, refreshDelayMs, RETRY_DELAY_MS } from "./session";
const AuthContext = createContext<AuthContextType>({
    accessToken: null,
    isAuthenticated: false,
    isLoading: true,
    user: null,
    login: () => { },
    logout: () => { },
    fetchUserProfile: async () => { },
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [accessToken, setAccessToken] = useState<string | null>(null);
    const [user, setUser] = useState<UserProfile | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const router = useRouter();
    const userRef = useRef<UserProfile | null>(null);
    userRef.current = user;
    const accessTokenRef = useRef<string | null>(null);
    accessTokenRef.current = accessToken;

    useEffect(() => {
        // 在 MCP 應用程式的同意頁上登入過期：登出後回到同一個授權請求，不要把使用者丟到一般登入頁。
        // Session expired on the consent page: come back to the same authorization request after signing in.
        const handleUnauthorized = () => {
            const here = window.location.pathname + window.location.search;
            logout(isAuthorizePath(here) ? here : undefined);
        };
        // 403 mfa_enrollment_required（lib/api.ts）→ 重抓 profile，mfa_missing 會帶出設定畫面。
        // 403 mfa_enrollment_required → refetch the profile; its mfa_missing brings up the enrollment gate.
        const handleEnrollmentRequired = () => {
            const token = localStorage.getItem("accessToken");
            if (token) fetchUserProfileState(token);
        };
        window.addEventListener("api:unauthorized", handleUnauthorized);
        window.addEventListener("api:mfa-enrollment-required", handleEnrollmentRequired);
        return () => {
            window.removeEventListener("api:unauthorized", handleUnauthorized);
            window.removeEventListener("api:mfa-enrollment-required", handleEnrollmentRequired);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        // 樂觀初始化：有 token 就「立刻」結束 loading 讓頁面前進（根頁 redirect、各頁資料抓取
        // 不再被 verify+profile 兩個串行 round-trip 擋住）。驗證改到背景進行：
        //   - verify 失敗 → 嘗試 refresh → 再失敗才清除登入狀態（由 api:unauthorized / logout 收尾）。
        //   - token 其實無效時，各頁 API 會收到 401，apiFetch 已統一派送 api:unauthorized 導回登入頁。
        // 並改為「只在掛載時跑一次」：舊版依賴 pathname，每次換頁都重打 verify+profile 兩個請求。
        // Optimistic init: unblock the UI immediately when a token exists; verify/refresh in the
        // background (failures funnel into the existing 401 handling). Run once on mount — the old
        // [pathname] dependency re-fired verify+profile on every navigation.
        const initAuth = async () => {
            const storedToken = localStorage.getItem("accessToken");
            if (!storedToken) {
                setIsLoading(false);
                return;
            }

            setAccessToken(storedToken);
            setIsLoading(false);

            // 背景認證（不阻塞 UI）：直接抓 profile —— 成功(200)即代表 token 有效，省掉先前額外多打的一支
            // /token/verify（profile 本來就會驗證同一顆 token，兩支重複）。只有 401 才嘗試 refresh，
            // refresh 被拒才清除登入狀態。網路錯誤（根本拿不到回應）不動登入狀態：可能只是暫時斷線，
            // 交給後續 API 的 401 處理。
            // Fetch the profile directly — a 200 proves the token is valid, so the separate
            // /token/verify round-trip is redundant. Refresh only on 401; keep auth on network errors.
            const status = await fetchUserProfileState(storedToken);
            if (status === "unauthorized") {
                const outcome = await refreshSession({ force: true });
                if (outcome === "ok") {
                    // 掛載時還沒有任何 session，這裡更新 context 的 token 沒關係。/ Nothing is connected yet at mount: safe to update.
                    const renewed = localStorage.getItem("accessToken");
                    if (renewed) {
                        setAccessToken(renewed);
                        await fetchUserProfileState(renewed);
                    }
                } else if (outcome === "rejected") {
                    handleFailedAuth();
                }
            }
        };

        initAuth();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 背景續期：到期前換一顆；分頁回到前景時若快到期就馬上換；別的分頁（或本分頁的 socket / apiFetch）換好了
    // 就從新 token 的到期時間重排。續期被拒 = 登入結束 → 登出；沒連上 → 一分鐘後再試。
    // Background renewal: before expiry; at once when a tab comes back to the foreground and is due; re-armed
    // from the new expiry whenever any tab (or this tab's sockets / apiFetch) renewed. Refused = signed out; unreachable = retry in a minute.
    useEffect(() => {
        if (!accessToken) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const arm = (delay: number) => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { void tick(); }, delay);
        };
        const armFromStored = () => arm(refreshDelayMs(localStorage.getItem("accessToken")));
        const tick = async () => {
            if (cancelled) return;
            const outcome = await refreshSession();
            if (cancelled) return;
            if (outcome === "rejected") {
                handleUnauthorizedRef.current();
                return;
            }
            if (outcome === "error") arm(RETRY_DELAY_MS);
            else armFromStored();
        };
        const onVisible = () => {
            if (document.visibilityState === "visible" && accessTokenExpiring(localStorage.getItem("accessToken"))) void tick();
        };
        armFromStored();
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener(ACCESS_TOKEN_EVENT, armFromStored);
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
            document.removeEventListener("visibilitychange", onVisible);
            window.removeEventListener(ACCESS_TOKEN_EVENT, armFromStored);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [accessToken]);

    // 別的分頁登入 / 登出（storage 事件只在其他分頁觸發）：登出就跟著離開；這裡還沒登入而那邊登入了就接過來。
    // 別的分頁背景續期不動這裡的 context（見檔頭），重排由上面的 ACCESS_TOKEN_EVENT / storage 處理。
    // Another tab signed in / out (storage events fire in other tabs only): follow a sign-out; adopt a sign-in
    // when this tab had none. Another tab's background renewal leaves this context alone (see the header).
    useEffect(() => {
        const onStorage = (e: StorageEvent) => {
            if (e.key !== null && e.key !== "accessToken" && e.key !== "refreshToken") return;
            const access = localStorage.getItem("accessToken");
            const refresh = localStorage.getItem("refreshToken");
            if (!access && !refresh) {
                // 兩顆都沒了 = 那邊登出了（續期只會覆寫，不會移除）。/ Both gone = signed out there (renewals only overwrite).
                if (!accessTokenRef.current) return;
                setAccessToken(null);
                setUser(null);
                router.push(loginPathFor());
                return;
            }
            if (!access) return;
            setAccessToken((current) => current ?? access);
            if (!userRef.current) fetchUserProfileState(access);
            window.dispatchEvent(new CustomEvent(ACCESS_TOKEN_EVENT));
        };
        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
    }, []);

    const handleFailedAuth = () => {
        setAccessToken(null);
        setUser(null);
        localStorage.removeItem("accessToken");
        localStorage.removeItem("refreshToken");
    };

    // 回傳認證結果讓 initAuth 決定是否 refresh：/ Returns a status so initAuth can decide whether to refresh.
    //   "ok"           — profile 取得成功（token 有效）
    //   "unauthorized" — 401（token 失效，應嘗試 refresh）
    //   "error"        — 網路錯誤或其他狀態（暫時性，不清除登入狀態）
    const fetchUserProfileState = async (token?: string): Promise<"ok" | "unauthorized" | "error"> => {
        try {
            const activeToken = token || localStorage.getItem("accessToken") || accessToken;
            if (!activeToken) return "error";
            const res = await fetch((process.env.NEXT_PUBLIC_API_BASE || "") + "/api/auth/user/profile", {
                headers: {
                    Authorization: `Bearer ${activeToken}`,
                },
            });
            if (res.ok) {
                const data = await res.json();
                setUser(data);
                return "ok";
            }
            if (res.status === 401) return "unauthorized";
            return "error";
        } catch (e) {
            console.error("Failed to fetch user profile", e);
            return "error";
        }
    };

    const login = (access: string, refresh: string) => {
        localStorage.setItem("accessToken", access);
        localStorage.setItem("refreshToken", refresh);
        setAccessToken(access);
        fetchUserProfileState(access);
    };

    /** next = 登入後要回去的站內路徑（同意頁會走 OAuth 登入頁）。/ next = where to return after signing in. */
    const logout = (next?: string) => {
        // 先請伺服器撤銷這個登入（refresh token 從此不能續期），再清本機。/ Revoke the sign-in server-side, then clear locally.
        const refresh = localStorage.getItem("refreshToken");
        if (refresh) revokeSession(refresh);
        localStorage.removeItem("accessToken");
        localStorage.removeItem("refreshToken");
        setAccessToken(null);
        setUser(null);
        router.push(loginPathFor(next));
    };

    // 背景續期被拒時走跟 401 一樣的路（同意頁回到同一個請求）。/ A refused renewal takes the 401 path (consent page included).
    const handleUnauthorizedRef = useRef<() => void>(() => { });
    handleUnauthorizedRef.current = () => {
        const here = window.location.pathname + window.location.search;
        logout(isAuthorizePath(here) ? here : undefined);
    };

    return (
        <AuthContext.Provider
            value={{
                accessToken,
                isAuthenticated: !!accessToken,
                isLoading,
                user,
                login,
                logout,
                fetchUserProfile: async () => { await fetchUserProfileState(); },
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export const useAuth = () => useContext(AuthContext);
