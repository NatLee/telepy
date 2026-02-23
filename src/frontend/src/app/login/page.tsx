"use client";

/**
 * 登入頁：帳密與 Google 登入表單。
 * Login page: credentials and Google sign-in form.
 */
import React from "react";
import Script from "next/script";
import { User, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLoginPage } from "@/hooks/useLoginPage";

export default function LoginPage() {
    const { state, actions } = useLoginPage();
    const { username, setUsername, password, setPassword, isSubmitting, googleClientId } = state;
    const { handleSubmit } = actions;

    return (
        <>
            <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" />
            <div className="min-h-screen flex items-center justify-center bg-background p-4">
                <div className="w-full max-w-md bg-card text-card-foreground rounded-2xl shadow-2xl p-8 border border-border animate-in fade-in slide-in-from-bottom-8 duration-700">
                    <div className="text-center mb-8">
                        <div className="inline-flex items-center justify-center w-16 h-16 bg-primary rounded-xl mb-4 shadow-lg shadow-primary/30">
                            <User size={32} className="text-primary-foreground" />
                        </div>
                        <h1 className="text-3xl font-bold tracking-tight">Telepy</h1>
                        <p className="text-muted-foreground mt-2">Sign in to your dashboard</p>
                    </div>

                    <form onSubmit={handleSubmit} className="space-y-5">
                        <div className="space-y-2">
                            <label className="text-sm font-semibold leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                                Username
                            </label>
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
                                    placeholder="Enter your username"
                                />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <label className="text-sm font-semibold leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                                Password
                            </label>
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
                                    placeholder="••••••••"
                                />
                            </div>
                        </div>

                        <Button
                            type="submit"
                            disabled={isSubmitting}
                            className="w-full font-bold"
                            size="lg"
                        >
                            {isSubmitting ? (
                                <div className="w-5 h-5 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin"></div>
                            ) : (
                                "Sign In"
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
                </div>
            </div>
        </>
    );
}
