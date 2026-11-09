"use client";

/**
 * 管理區「使用者與權限 → 群組」：管理員維護成員的群組（也可以由 SCIM / 單一登入規則放人），只用來分享通道。
 * 決定功能的是「角色」頁。`?group=<id>` 先選那個群組，`?new=1` 直接打開新增。
 * The admin section's Users & access → Groups: groups whose members admins keep (or SCIM / SSO rules fill), used only
 * for sharing tunnels. Features are the Roles page's job. `?group=<id>` picks one, `?new=1` opens "new".
 */
import React, { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AdminGate } from "@/components/layout/AdminViews";
import { AdminGroupsView } from "@/components/groups/AdminGroupsView";

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
            <AdminGroupsView initialGroup={group} startNew={params.get("new") === "1"} />
        </div>
    );
}
