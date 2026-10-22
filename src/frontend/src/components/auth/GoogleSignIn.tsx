"use client";

/**
 * Google 登入按鈕：GSI 載入後用 renderButton 畫進容器——每次掛載都重畫（從 /login 換頁到 /first-login 也會出現），
 * 寬度對齊表單、語言跟介面、深色主題用深色按鈕。登入結果交給頁面 hook 掛在 window 上的 getTokenUsingGoogleCredential。
 * Google sign-in button drawn with renderButton once GSI is ready — on every mount, so it survives client-side
 * navigation — matching the form width, UI language and theme. The credential goes to the page hook's
 * window.getTokenUsingGoogleCredential, as before.
 */
import React, { useEffect, useRef, useState } from "react";
import Script from "next/script";
import { useI18n } from "@/lib/i18n";
import { useThemePreference } from "@/hooks/useThemePreference";

type CredentialResponse = { credential: string };

interface GoogleIdentity {
    accounts: {
        id: {
            initialize(options: { client_id: string; callback: (response: CredentialResponse) => void; ux_mode?: "popup"; auto_select?: boolean }): void;
            renderButton(parent: HTMLElement, options: Record<string, string | number>): void;
        };
    };
}

type GsiWindow = Window & {
    google?: GoogleIdentity;
    getTokenUsingGoogleCredential?: (response: CredentialResponse) => Promise<void>;
};

export function GoogleSignIn({ clientId, text = "signin_with" }: { clientId: string; text?: "signin_with" | "continue_with" }) {
    const container = useRef<HTMLDivElement>(null);
    const [ready, setReady] = useState(false);
    const { locale } = useI18n();
    // 主題切換時重畫按鈕。/ Re-render the button when the theme changes.
    const [theme] = useThemePreference();

    // 每次掛載 initialize 一次（onReady 在腳本已載入時也會觸發）；按鈕則在語言 / 主題變動時重畫。
    // Initialize once per mount (onReady also fires when the script is already loaded); the button
    // itself redraws on language / theme changes.
    const initialize = () => {
        (window as GsiWindow).google?.accounts.id.initialize({
            client_id: clientId,
            callback: (response) => void (window as GsiWindow).getTokenUsingGoogleCredential?.(response),
            ux_mode: "popup",
            auto_select: false,
        });
        setReady(true);
    };

    useEffect(() => {
        const google = (window as GsiWindow).google;
        const el = container.current;
        if (!ready || !google || !el) return;
        el.replaceChildren();
        google.accounts.id.renderButton(el, {
            type: "standard",
            theme: document.documentElement.classList.contains("dark") ? "filled_black" : "outline",
            size: "large",
            text,
            shape: "rectangular",
            logo_alignment: "center",
            // GSI 只收 200–400 px。/ GSI accepts 200–400 px.
            width: Math.round(Math.min(400, Math.max(200, el.clientWidth))),
            locale,
        });
    }, [ready, text, locale, theme]);

    return (
        <>
            <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onReady={initialize} />
            <div ref={container} className="flex min-h-10 w-full justify-center [color-scheme:normal]" />
        </>
    );
}
