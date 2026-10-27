"use client";

/**
 * 登入頁：網站設定選的樣子——一般（左側產品介紹 + 右側表單）或低調（只寫 Telepy 的動態畫面）。還不知道樣子時只畫
 * 空的外框（components/auth/DiscreetShell SignInPending），所以靜態 HTML 兩種樣子都一樣。MCP 應用程式要求連接時用的是 /oauth/login。
 * Sign-in page in the look chosen in Site settings: standard (product highlights + form) or discreet (a plain
 * animated "Telepy" page). Until the look is known it paints an empty frame, so the static HTML is the same for both.
 * App connections (OAuth) sign in on /oauth/login instead.
 */
import React from "react";
import { SignInPending } from "@/components/auth/DiscreetShell";
import { LoginForm } from "@/components/auth/LoginForm";
import { SignInScreen } from "@/components/auth/SignInScreens";
import { useSignInLook } from "@/hooks/useSignInLook";

export default function LoginPage() {
    const look = useSignInLook();
    if (!look) return <SignInPending />;
    return <SignInScreen style={look.style} message={look.message} Form={LoginForm} />;
}
