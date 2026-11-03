"use client";

/**
 * 每條通道的頁面：`/tunnels/<id>?tab=…`。內容在 `components/tunnels/page/TunnelPageView.tsx`。
 * A tunnel's own page: `/tunnels/<id>?tab=…`. The content lives in `components/tunnels/page/TunnelPageView.tsx`.
 */
import React, { Suspense } from "react";
import { TunnelPageView } from "@/components/tunnels/page/TunnelPageView";

export default function TunnelPage() {
    // useSearchParams（?tab=）需要 Suspense 邊界。/ useSearchParams (?tab=) needs a Suspense boundary.
    return (
        <Suspense fallback={null}>
            <TunnelPageView />
        </Suspense>
    );
}
