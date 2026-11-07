"use client";

/**
 * 從身分提供者回來的結果頁（已登入的人）：連結好了、連結失敗、或管理員試登入拿到的 claim。
 * Where a signed-in person lands back from the provider: linked, a failed link, or an admin's test sign-in.
 */
import React, { Suspense } from "react";
import { SsoResultView } from "@/components/sso/SsoResultView";

export default function SsoResultPage() {
    // useSearchParams 需要 Suspense 邊界。/ useSearchParams needs a Suspense boundary.
    return (
        <Suspense>
            <SsoResultView />
        </Suspense>
    );
}
