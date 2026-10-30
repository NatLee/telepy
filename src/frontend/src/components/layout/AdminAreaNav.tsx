"use client";

/**
 * 管理區裡有好幾頁的區（使用者與權限、規則與通知、全站活動）在頁面標題下放同一排分頁，跟 SSH 金鑰區一樣：側欄
 * 展開的子項在收合時看不到，手機也要先打開選單，這排分頁讓同一區的頁一鍵可達。分頁由 `app/tunnels/admin/layout`
 * 透過 `PageHeaderNav` 交給 `PageHeader`，所以各頁（多半是跟個人頁共用的 view）不必改。
 * Admin areas with several pages (users & access, rules & alerts, site activity) put the same tabs under the page
 * title, like the SSH keys area: a collapsed sidebar hides the sub-items and phones need the menu first, so these
 * tabs keep an area's pages one click apart. `app/tunnels/admin/layout` hands them to `PageHeader` through
 * `PageHeaderNav`, so the pages — mostly views shared with the personal pages — need no change.
 */
import React, { createContext } from "react";
import { usePathname, useRouter } from "next/navigation";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { adminAreaOf } from "@/lib/adminAreas";
import { useI18n } from "@/lib/i18n";

/** `PageHeader` 在標題區下面畫出這裡給的東西。/ What `PageHeader` draws under the title block. */
export const PageHeaderNav = createContext<React.ReactNode>(null);

export function AdminAreaNav() {
    const pathname = usePathname();
    const router = useRouter();
    const { t } = useI18n();
    const found = adminAreaOf(pathname);
    if (!found || found.area.pages.length < 2) return null;
    const label = t(found.area.key);
    return (
        <>
            {/* 手機上是一行的下拉選單（五個分頁的橫列看不到後面幾個）；從 sm 起是分頁。
                A one-line select on phones (a row of five tabs hides the last ones); tabs from sm. */}
            <NativeSelect className="h-9 sm:hidden" aria-label={label} value={found.page.href} onChange={(e) => router.push(e.target.value)}>
                {found.area.pages.map((p) => <option key={p.href} value={p.href}>{t(p.key)}</option>)}
            </NativeSelect>
            <div className="-mx-1 overflow-x-auto px-1 pb-0.5 max-sm:hidden">
                <Segmented
                    kind="tabs"
                    aria-label={label}
                    options={found.area.pages.map((p) => ({ value: p.href, label: t(p.key) }))}
                    value={found.page.href}
                    onChange={(href) => router.push(href)}
                />
            </div>
        </>
    );
}
