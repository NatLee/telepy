"use client";

/**
 * Webhooks 頁：自己的 webhook（管理員也一樣；全站的在管理區）。舊的 `?scope=site` 連結轉到管理區。
 * The Webhooks page: your own webhooks (admins too; site-wide ones are in the admin section). Old `?scope=site` links
 * go to the admin section.
 */
import React, { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { WebhooksView } from "@/components/webhooks/WebhooksView";

function Webhooks() {
    const router = useRouter();
    const legacySite = useSearchParams().get("scope") === "site";
    useEffect(() => {
        if (legacySite) router.replace("/tunnels/admin/webhooks");
    }, [legacySite, router]);
    if (legacySite) return null;
    return <WebhooksView scope="user" />;
}

export default function WebhooksPage() {
    // useSearchParams 需要 Suspense 邊界。/ useSearchParams needs a Suspense boundary.
    return (
        <Suspense fallback={null}>
            <Webhooks />
        </Suspense>
    );
}
