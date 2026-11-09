"use client";

/**
 * 管理區「使用者與權限 → 角色」：一群人共用的功能規則（以前叫組織群組）。角色只決定功能，從不出現在分享。
 * `?role=<id>` 先選那個角色，`?new=1` 直接打開新增。
 * The admin section's Users & access → Roles: feature rules a set of people share (formerly organization groups).
 * Roles only decide features and never appear in sharing. `?role=<id>` picks one, `?new=1` opens "new".
 */
import React, { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AdminGate } from "@/components/layout/AdminViews";
import { RolesView } from "@/components/groups/RolesView";

export default function AdminRolesPage() {
    return (
        <AdminGate>
            {/* useSearchParams 需要 Suspense 邊界。/ useSearchParams needs a Suspense boundary. */}
            <Suspense fallback={null}>
                <RolesPage />
            </Suspense>
        </AdminGate>
    );
}

function RolesPage() {
    const params = useSearchParams();
    const role = Number(params.get("role")) || null;
    return (
        <div className="animate-fade-in-up">
            <RolesView initialRole={role} startNew={params.get("new") === "1"} />
        </div>
    );
}
