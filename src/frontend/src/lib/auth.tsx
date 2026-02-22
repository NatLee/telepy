"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { apiFetch } from "./api";
import { useRouter, usePathname } from "next/navigation";

interface UserProfile {
    id?: number;
    username?: string;
    email?: string;
    is_superuser?: boolean;
}

interface AuthContextType {
    accessToken: string | null;
    isAuthenticated: boolean;
    isLoading: boolean;
    user: UserProfile | null;
    login: (access: string, refresh: string) => void;
    logout: () => void;
    fetchUserProfile: () => Promise<void>;
}

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
    const pathname = usePathname();

    useEffect(() => {
        const handleUnauthorized = () => {
            logout();
        };
        window.addEventListener("api:unauthorized", handleUnauthorized);
        return () => window.removeEventListener("api:unauthorized", handleUnauthorized);
    }, []);

    useEffect(() => {
        const initAuth = async () => {
            const storedToken = localStorage.getItem("accessToken");
            if (!storedToken) {
                setIsLoading(false);
                return;
            }

            setAccessToken(storedToken);

            try {
                const res = await apiFetch("/api/auth/token/verify", {
                    method: "POST",
                    body: JSON.stringify({ token: storedToken }),
                });

                if (res.ok) {
                    await fetchUserProfileState(storedToken);
                } else {
                    // try refresh
                    const refreshRes = await attemptRefresh();
                    if (!refreshRes) {
                        handleFailedAuth();
                    }
                }
            } catch (err) {
                handleFailedAuth();
            }

            setIsLoading(false);
        };

        initAuth();
    }, [pathname]); // Re-verify occasionally or on mount

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
