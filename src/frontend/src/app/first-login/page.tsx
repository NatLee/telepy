"use client";

import React, { useState, useEffect } from "react";
import Script from "next/script";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/ui/Toast";
import { UserPlus, User, Lock, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function FirstLoginPage() {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    const { login, isAuthenticated } = useAuth();
    const { showSuccess, showError, showToast } = useToast();
    const router = useRouter();

    const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

    useEffect(() => {
        if (isAuthenticated) {
            router.replace("/tunnels");
        }
    }, [isAuthenticated, router]);

    useEffect(() => {
        (window as any).getTokenUsingGoogleCredential = async (response: any) => {
            try {
                const res = await apiFetch("/api/auth/google/token", {
                    method: "POST",
                    body: JSON.stringify({ credential: response.credential }),
                });
                const data = await res.json();
                if (res.ok) {
                    login(data.access_token, data.refresh_token);
                    showSuccess("Google Login successful");
                    router.push("/tunnels");
                } else {
                    showError(data.error || data.detail || "Google Login failed");
                }
            } catch (err: any) {
                showError(err.message || "Google Login failed");
            }
        };
    }, [login, router, showError, showSuccess]);

    const getPasswordStrength = () => {
        if (!password) return { text: "", color: "bg-slate-200" };
        if (password.length < 6) return { text: "Weak", color: "bg-red-500" };
        if (password.length < 10) return { text: "Moderate", color: "bg-yellow-500" };
        return { text: "Strong", color: "bg-green-500" };
    };
    const strength = getPasswordStrength();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (username === password) {
            showError("Username and password cannot be the same.");
            return;
        }
        if (password !== confirmPassword) {
            showError("Passwords do not match.");
            return;
        }

        setIsSubmitting(true);
        try {
            // 1. Register User
            const regRes = await apiFetch("/api/auth/register", {
                method: "POST",
                body: JSON.stringify({ username, password }),
            });
            const regData = await regRes.json();

            if (!regRes.ok || regData.status !== "success") {
                showError(regData.error || regData.detail || "Registration failed");
                setIsSubmitting(false);
                return;
            }

            showSuccess("Admin account created successfully.");

            // 2. Login newly created user
            const loginRes = await apiFetch("/api/auth/token", {
                method: "POST",
                body: JSON.stringify({ username, password }),
            });
            const loginData = await loginRes.json();

            if (loginRes.ok && loginData.access_token) {
                login(loginData.access_token, loginData.refresh_token);
                router.push("/tunnels");
            } else {
                showError("Automatic login failed. Please sign in.");
                router.push("/login");
            }
        } catch (err: any) {
            showError(err.message || "Operation failed");
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <>
            <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" />
            <div className="min-h-screen flex items-center justify-center bg-background p-4">
                <div className="w-full max-w-md bg-card text-card-foreground rounded-2xl shadow-2xl p-8 border border-border animate-in fade-in slide-in-from-bottom-8 duration-700">
                    <div className="text-center mb-6">
                        <div className="inline-flex items-center justify-center w-16 h-16 bg-primary rounded-xl mb-4 shadow-lg shadow-primary/30">
                            <UserPlus size={32} className="text-primary-foreground" />
                        </div>
                        <h1 className="text-3xl font-bold tracking-tight">Welcome to Telepy</h1>
                        <p className="text-muted-foreground mt-2">Create your administrator account to get started</p>
                    </div>

                    <div className="bg-primary/10 border border-primary/20 rounded-lg p-4 mb-6 flex items-start">
                        <ShieldAlert className="text-primary mt-0.5 mr-3 shrink-0" size={18} />
                        <div className="text-sm text-foreground">
                            <span className="font-semibold block mb-1">First Time Setup</span>
                            It seems you are setting up Telepy for the first time. Please create an administrator account to continue.
                        </div>
                    </div>

                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="space-y-2">
                            <label className="text-sm font-semibold leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">Username</label>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <User size={18} className="text-muted-foreground" />
                                </div>
                                <Input
                                    type="text"
                                    required
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                    className="pl-10"
                                    placeholder="Choose a username"
                                />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <label className="text-sm font-semibold leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">Password</label>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <Lock size={18} className="text-muted-foreground" />
                                </div>
                                <Input
                                    type="password"
                                    required
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="pl-10"
                                    placeholder="Create a strong password"
                                />
                            </div>
                            {password && (
                                <div className="mt-2 flex items-center gap-2">
                                    <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                                        <div className={`h-full ${strength.color} transition-all duration-300 w-full`} />
                                    </div>
                                    <span className="text-xs font-medium text-muted-foreground w-16">{strength.text}</span>
                                </div>
                            )}
                        </div>

                        <div className="space-y-2">
                            <label className="text-sm font-semibold leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">Confirm Password</label>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <Lock size={18} className="text-muted-foreground" />
                                </div>
                                <Input
                                    type="password"
                                    required
                                    value={confirmPassword}
                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                    className={`pl-10 ${confirmPassword && password !== confirmPassword ? "border-destructive focus-visible:ring-destructive" : ""}`}
                                    placeholder="Confirm your password"
                                />
                            </div>
                            {confirmPassword && password !== confirmPassword && (
                                <div className="text-xs text-destructive mt-1 font-medium">Passwords do not match</div>
                            )}
                            {confirmPassword && password === confirmPassword && (
                                <div className="text-xs text-success mt-1 font-medium">Passwords match</div>
                            )}
                        </div>

                        <Button
                            type="submit"
                            disabled={isSubmitting || (password !== confirmPassword) || !username || !password}
                            className="w-full font-bold mt-2"
                            size="lg"
                        >
                            {isSubmitting ? (
                                <div className="w-5 h-5 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin"></div>
                            ) : (
                                "Create Account & Sign In"
                            )}
                        </Button>
                    </form>

                    {googleClientId && (
                        <div className="mt-6">
                            <div className="relative">
                                <div className="absolute inset-0 flex items-center">
                                    <div className="w-full border-t border-border" />
                                </div>
                                <div className="relative flex justify-center text-sm">
                                    <span className="px-2 bg-card text-muted-foreground">Or continue with</span>
                                </div>
                            </div>
                            <div className="mt-6 flex justify-center">
                                <div
                                    id="g_id_onload"
                                    data-client_id={googleClientId}
                                    data-context="signin"
                                    data-ux_mode="popup"
                                    data-callback="getTokenUsingGoogleCredential"
                                    data-auto_prompt="false"
                                ></div>
                                <div
                                    className="g_id_signin"
                                    data-type="standard"
                                    data-size="large"
                                    data-theme="outline"
                                    data-text="sign_in_with"
                                    data-shape="rectangular"
                                    data-logo_alignment="left"
                                ></div>
                            </div>
                        </div>
                    )}

                    <div className="mt-6 text-center">
                        <Link
                            href="/login"
                            className="text-sm font-medium text-muted-foreground hover:text-primary inline-flex items-center transition-colors"
                        >
                            Already have an account? Sign in
                        </Link>
                    </div>
                </div>
            </div>
        </>
    );
}
