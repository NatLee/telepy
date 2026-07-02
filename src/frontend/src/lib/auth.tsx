"use client";

/**
 * 認證 Context：Token 儲存、401 處理、Profile 取得與登入/登出。
 * Auth context: token storage, 401 handling, profile fetch and login/logout.
 * - Token 儲存：login 時寫入 localStorage accessToken/refreshToken；logout 與驗證失敗時清除。
 *   Token storage: write accessToken/refreshToken on login; clear on logout or verify failure.
 * - 401 處理：lib/api 收到 401 時派送 api:unauthorized，此處監聽並執行 logout 導向登入頁。
 *   401 handling: lib/api dispatches api:unauthorized on 401; here we listen and logout to login page.
 * - Profile 取得時機：initAuth 驗證 token 後、refresh 成功後、login 時。
 *   Profile fetch: after token verify in initAuth, after refresh success, and on login.
 */
import React, { createContext, useContext, useEffect, useState } from "react";
import { apiFetch } from "./api";
import { useRouter } from "next/navigation";

import { UserProfile, AuthContextType } from "../types/auth";
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

    useEffect(() => {
        const handleUnauthorized = () => {
            logout();
        };
        window.addEventListener("api:unauthorized", handleUnauthorized);
        return () => window.removeEventListener("api:unauthorized", handleUnauthorized);
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

            // 背景驗證與 profile 取得（並行，不阻塞 UI）。/ Background verify + profile (parallel).
            void fetchUserProfileState(storedToken);
            try {
                const res = await apiFetch("/api/auth/token/verify", {
                    method: "POST",
                    body: JSON.stringify({ token: storedToken }),
                });

                if (!res.ok) {
                    const refreshRes = await attemptRefresh();
                    if (!refreshRes) {
                        handleFailedAuth();
                    }
                }
            } catch {
                // 網路錯誤時不清除登入狀態：可能只是暫時斷線，交給後續 API 的 401 處理。
                // Don't clear auth on network errors; a later API 401 will handle true invalidity.
            }
        };

        initAuth();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const attemptRefresh = async () => {
        const refresh = localStorage.getItem("refreshToken");
        if (!refresh) return false;
        try {
            const res = await fetch(
                (process.env.NEXT_PUBLIC_API_BASE || "") + "/api/auth/token/refresh",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ refresh }),
                }
            );
            if (res.ok) {
                const data = await res.json();
                const access = data.access || data.access_token;
                if (access) {
                    localStorage.setItem("accessToken", access);
                    setAccessToken(access);
                    await fetchUserProfileState(access);
                    return true;
                }
            }
        } catch (e) {
            console.error("Refresh failed", e);
        }
        return false;
    };

    const handleFailedAuth = () => {
        setAccessToken(null);
        setUser(null);
        localStorage.removeItem("accessToken");
        localStorage.removeItem("refreshToken");
    };

    const fetchUserProfileState = async (token?: string) => {
        try {
            const activeToken = token || accessToken;
            if (!activeToken) return;
            const res = await fetch((process.env.NEXT_PUBLIC_API_BASE || "") + "/api/auth/user/profile", {
                headers: {
                    Authorization: `Bearer ${activeToken}`,
                },
            });
            if (res.ok) {
                const data = await res.json();
                setUser(data);
            }
        } catch (e) {
            console.error("Failed to fetch user profile", e);
        }
    };

    const login = (access: string, refresh: string) => {
        localStorage.setItem("accessToken", access);
        localStorage.setItem("refreshToken", refresh);
        setAccessToken(access);
        fetchUserProfileState(access);
    };

    const logout = () => {
        localStorage.removeItem("accessToken");
        localStorage.removeItem("refreshToken");
        setAccessToken(null);
        setUser(null);
        router.push("/login");
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
                fetchUserProfile: () => fetchUserProfileState(),
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export const useAuth = () => useContext(AuthContext);
