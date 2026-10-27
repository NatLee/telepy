"use client";

/**
 * SSH config 對話框（單台與多台）共用的步驟清單：左邊編號圓點 + 直線，右邊標題、狀態與內容；以及一列檢查項目。
 * The numbered steps shared by the SSH config dialogs (single and bulk): a number dot + rail on the left, title,
 * status and body on the right; plus one check row.
 */
import React from "react";
import { Info } from "lucide-react";

/**
 * 步驟分頁裡一頁的標題：名稱 + 狀態（右邊）+ 一行說明，下面是內容。/ One step tab's header: name, status on the right,
 * a hint line, then the content.
 */
export function StepPanel({ title, status, hint, hidden = false, children }: {
    title: React.ReactNode;
    status?: React.ReactNode;
    hint?: React.ReactNode;
    /** 不是目前這一步：留在畫面裡（狀態不重來），只是藏起來。/ Not the current step: kept mounted, just hidden. */
    hidden?: boolean;
    children: React.ReactNode;
}) {
    return (
        <section role="tabpanel" hidden={hidden} className="space-y-4">
            <div>
                <div className="flex min-h-7 flex-wrap items-center gap-x-2.5 gap-y-1">
                    <h3 className="text-lg text-foreground">{title}</h3>
                    {status}
                </div>
                {hint && <p className="mt-0.5 text-sm text-muted-foreground">{hint}</p>}
            </div>
            <div className="space-y-3 text-sm">{children}</div>
        </section>
    );
}

/** 一列檢查項目：圖示 + 說明 + 右側狀態 / 動作。/ One check row: icon + text + status or action on the right. */
export function CheckRow({ icon, children, right }: { icon: React.ReactNode; children: React.ReactNode; right: React.ReactNode }) {
    return (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
            <span className="shrink-0 text-muted-foreground [&>svg]:size-4" aria-hidden>{icon}</span>
            <span className="min-w-0 flex-1 text-foreground">{children}</span>
            <span className="max-w-full shrink-0">{right}</span>
        </li>
    );
}

/**
 * 工具列上的一組「標籤 + 切換」：手機上標籤在上、切換佔滿一行（放大顯示時才不會撐出對話框），桌面並排。
 * One "label + toggle" pair in a dialog toolbar: stacked and full width on phones (so large display sizes never
 * push it out of the dialog), side by side from `sm`.
 */
export function ToolbarField({ label, info, children }: {
    label: React.ReactNode;
    /** 標籤旁的 ⓘ：打開說明。/ An ⓘ next to the label that opens an explainer. */
    info?: { label: string; onClick: () => void };
    children: React.ReactNode;
}) {
    return (
        <div className="flex w-full min-w-0 flex-col gap-1.5 sm:w-auto sm:flex-row sm:items-center sm:gap-3">
            <span className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
                {label}
                {info && (
                    <button
                        type="button"
                        onClick={info.onClick}
                        aria-label={info.label}
                        title={info.label}
                        className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    >
                        <Info size={15} aria-hidden />
                    </button>
                )}
            </span>
            {children}
        </div>
    );
}
