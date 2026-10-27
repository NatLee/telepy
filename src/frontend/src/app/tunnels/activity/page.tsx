"use client";

/**
 * AI 活動頁：自己的 AI session 與工具呼叫，加上別人的 agent 在自己隧道上做的事，以及管理自己已連接的 app（管理員也一樣；
 * 全站的在管理區）。
 * The AI activity page: your own AI sessions and tool calls, plus what other people's agents did on your tunnels, and
 * your connected apps to manage (admins too; the whole site's are in the admin section).
 */
import React, { Suspense } from "react";
import { AiActivityView } from "@/components/activity/AiActivityView";

export default function AiActivityPage() {
    // useSearchParams（`?app=`）需要 Suspense 邊界。/ useSearchParams (`?app=`) needs a Suspense boundary.
    return (
        <Suspense fallback={null}>
            <AiActivityView scope="mine" />
        </Suspense>
    );
}
