"use client";

/**
 * 「群組」頁：分享用的「人」的群組 —— 自己建的個人群組（新增、編輯、刪除），以及自己所在的群組（別人的個人群組
 * 可以退出，開放分享的組織群組唯讀）。分享視窗的「群組」分頁仍然可以順手建。
 * The Groups page: people groups for sharing — the personal groups you made (new, edit, delete) and the groups you
 * are in (leave someone's personal group; organization groups open to sharing are read-only). The share dialog's
 * Groups tab can still make one on the spot.
 */
import React from "react";
import { GroupsPageView } from "@/components/groups/GroupsPageView";

export default function GroupsPage() {
    return <GroupsPageView />;
}
