"use client";

/**
 * 管理區「使用者與權限 → 組織群組」：管理員（與單一登入 / SCIM）管的群組；成員、能不能分享、分享給它的通道、功能規則。
 * `?group=<id>` 先選那個群組，`?new=1` 直接打開新增。
 * The admin section's Users & access → Organization groups: groups admins (and SSO / SCIM) manage — members, whether
 * they can be shared, the tunnels shared with them, feature rules. `?group=<id>` picks one, `?new=1` opens "new".
 */
import React, { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AdminGate } from "@/components/layout/AdminViews";
import { OrgGroupsView } from "@/components/groups/OrgGroupsView";

export default function AdminGroupsPage() {
    return (
        <AdminGate>
            {/* useSearchParams 需要 Suspense 邊界。/ useSearchParams needs a Suspense boundary. */}
            <Suspense fallback={null}>
                <GroupsPage />
            </Suspense>
        </AdminGate>
    );
}

function GroupsPage() {
    const params = useSearchParams();
    const group = Number(params.get("group")) || null;
    return (
        <div className="animate-fade-in-up">
            <OrgGroupsView initialGroup={group} startNew={params.get("new") === "1"} />
        </div>
    );
}
