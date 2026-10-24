"use client";

/**
 * 登入頁：左側產品介紹，右側登入表單（components/auth/LoginForm）。MCP 應用程式要求連接時用的是 /oauth/login。
 * Sign-in page: product highlights on the left, the shared sign-in form on the right. App connections
 * (OAuth) sign in on /oauth/login instead.
 */
import React from "react";
import { AuthShell } from "@/components/auth/AuthShell";
import { AuthHighlights } from "@/components/auth/AuthPanels";
import { LoginForm } from "@/components/auth/LoginForm";
import { useI18n } from "@/lib/i18n";

export default function LoginPage() {
    const { t } = useI18n();
    return (
        <AuthShell aside={<AuthHighlights />}>
            <LoginForm title={t("login.title")} description={t("login.subtitle")} />
        </AuthShell>
    );
}
