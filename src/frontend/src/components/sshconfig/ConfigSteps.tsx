"use client";

/**
 * SSH config 對話框（單台與多台）共用的步驟清單：左邊編號圓點 + 直線，右邊標題、狀態與內容；以及一列檢查項目。
 * The numbered steps shared by the SSH config dialogs (single and bulk): a number dot + rail on the left, title,
 * status and body on the right; plus one check row.
 */
import React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function Step({ n, done = false, title, status, hint, last = false, children }: {
    n: number;
    done?: boolean;
    title: React.ReactNode;
    status?: React.ReactNode;
    hint?: React.ReactNode;
    last?: boolean;
    children: React.ReactNode;
}) {
    return (
        <li className="relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
            <span
                className={cn(
                    "grid size-7 place-items-center rounded-full text-xs",
                    done ? "bg-success text-success-foreground" : "bg-muted text-foreground ring-1 ring-inset ring-border"
                )}
                aria-hidden
            >
                {done ? <Check size={15} strokeWidth={3} /> : n}
            </span>
            {!last && <span className="absolute bottom-1 left-[0.8125rem] top-9 w-px bg-border" aria-hidden />}
            <div className={cn("min-w-0", !last && "pb-7")}>
                <div className="flex min-h-7 flex-wrap items-center gap-x-2.5 gap-y-1">
                    <h3 className="text-base text-foreground">{title}</h3>
                    {status}
                </div>
                {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
                <div className="mt-3 space-y-3 text-sm">{children}</div>
            </div>
        </li>
    );
}

/** 一列檢查項目：圖示 + 說明 + 右側狀態 / 動作。/ One check row: icon + text + status or action on the right. */
export function CheckRow({ icon, children, right }: { icon: React.ReactNode; children: React.ReactNode; right: React.ReactNode }) {
    return (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
            <span className="shrink-0 text-muted-foreground [&>svg]:size-4" aria-hidden>{icon}</span>
            <span className="min-w-0 flex-1 text-foreground">{children}</span>
            <span className="shrink-0">{right}</span>
        </li>
    );
}

/**
 * 工具列上的一組「標籤 + 切換」：手機上標籤在上、切換佔滿一行（放大顯示時才不會撐出對話框），桌面並排。
 * One "label + toggle" pair in a dialog toolbar: stacked and full width on phones (so large display sizes never
 * push it out of the dialog), side by side from `sm`.
 */
export function ToolbarField({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
    return (
        <div className="flex w-full min-w-0 flex-col gap-1.5 sm:w-auto sm:flex-row sm:items-center sm:gap-3">
            <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
            {children}
        </div>
    );
}
