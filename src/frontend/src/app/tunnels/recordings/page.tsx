"use client";

/**
 * 終端機錄影頁：自己的錄影，加上自己擁有或 ADMIN 的隧道上的（管理員也一樣；全站的在管理區）。
 * The Recordings page: your own recordings plus those on tunnels you own or ADMIN (admins too; the whole site's are
 * in the admin section).
 */
import React, { Suspense } from "react";
import { RecordingsView } from "@/components/recordings/RecordingsView";

export default function RecordingsPage() {
    // useSearchParams（`?tunnel=`）需要 Suspense 邊界。/ useSearchParams (`?tunnel=`) needs a Suspense boundary.
    return (
        <Suspense>
            <RecordingsView scope="mine" />
        </Suspense>
    );
}
