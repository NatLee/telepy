"use client";

/**
 * 即時連線頁：自己的 session，加上自己擁有或 ADMIN 的隧道上每個人的（管理員也一樣；全站的在管理區）。
 * The Live sessions page: your own sessions plus everyone's on tunnels you own or ADMIN (admins too; the whole
 * site's are in the admin section).
 */
import React, { Suspense } from "react";
import { LiveSessionsView } from "@/components/sessions/LiveSessionsView";

export default function LiveSessionsPage() {
    // useSearchParams（`?tunnel=`）需要 Suspense 邊界。/ useSearchParams (`?tunnel=`) needs a Suspense boundary.
    return (
        <Suspense>
            <LiveSessionsView scope="mine" />
        </Suspense>
    );
}
