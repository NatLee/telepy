"use client";

/**
 * SSH 金鑰 › 我的金鑰：到期提醒、搜尋 / 分類 / 排序與分頁的金鑰清單或卡片（點了看詳細資訊）。卡片 / 列表跟著帳號走
 * （`view_modes.keys`，偏好設定 → 外觀也能改）。外框、資料與視窗在 `layout.tsx` / `KeysArea`。
 * SSH keys › Your keys: the expiry notice and the keys as a list or cards with search / buckets / sort and pages (a
 * click opens the details). Card / list follows the account (`view_modes.keys`, also in Preferences → Appearance).
 * The frame, data and dialogs live in `layout.tsx` / `KeysArea`.
 */
import React, { useCallback, useMemo, useRef } from "react";
import { Key as KeyIcon, Plus } from "lucide-react";
import { useFeatures } from "@/hooks/useFeatures";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { KeyCards, KeyList } from "@/components/keys/KeyList";
import { KeyListFilterBar, KeyListFilterFooter, useKeyListFilter } from "@/components/keys/KeyListFilter";
import { useKeysArea } from "@/components/keys/KeysArea";
import { ViewToggle } from "@/components/ui/ViewToggle";
import { useViewMode } from "@/hooks/useViewMode";
import { useI18n } from "@/lib/i18n";
import { expiryState } from "@/lib/keyExpiry";

export default function YourKeysPage() {
    const { t } = useI18n();
    const { page, groupNameOf, setAddOpen, setDetailsId, setDeleting } = useKeysArea();
    const top = useRef<HTMLElement>(null);
    const keysOn = useFeatures().has("keys.personal");
    // 金鑰多時：搜尋 / 分類 / 排序（對全部金鑰），結果再分頁。/ Many keys: search, buckets and sort over every key, then pages.
    const devicesOf = useCallback((id: number) => (page.placements.get(id) ?? []).length, [page.placements]);
    // 卡片 / 列表跟著帳號（偏好設定也能改）。/ Card / list follows the account (also in Preferences).
    const [view, setView] = useViewMode("keys");
    const keyFilter = useKeyListFilter(page.keys, devicesOf, view === "card");
    const expiry = useMemo(() => {
        const states = page.keys.map((k) => expiryState(k.expires_at));
        return { expired: states.filter((s) => s === "expired").length, soon: states.filter((s) => s === "soon").length };
    }, [page.keys]);

    return (
        <section aria-label={t("keys.mine")} ref={top} className="scroll-mt-20 space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="max-w-3xl text-sm text-muted-foreground">{t("keys.mineDescription")}</p>
                {page.keys.length > 0 && <ViewToggle value={view} onChange={setView} />}
            </div>

            {/* 到期提醒：已到期的被拒絕、也從裝置移除；7 天內到期的先提醒。/ Expired keys are refused and removed; warn a week ahead. */}
            {(expiry.expired > 0 || expiry.soon > 0) && (
                <Callout tone={expiry.expired > 0 ? "danger" : "warning"}>
                    {expiry.expired > 0 && t("keys.expiry.bannerExpired", { count: expiry.expired })}
                    {expiry.expired > 0 && expiry.soon > 0 && " "}
                    {expiry.soon > 0 && t("keys.expiry.bannerSoon", { count: expiry.soon })} {t("keys.expiry.bannerHow")}
                </Callout>
            )}

            {page.loading && page.keys.length === 0 ? (
                <div className="flex justify-center py-12 text-muted-foreground">
                    <div className="mr-3 h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                    {t("keys.loading")}
                </div>
            ) : page.keys.length === 0 ? (
                <div className="flex flex-col items-center rounded-xl border-2 border-dashed border-border bg-card px-6 py-14 text-center">
                    <KeyIcon size={44} className="mb-4 text-muted-foreground/50" />
                    <h3 className="text-lg text-foreground">{t("keys.emptyTitle")}</h3>
                    <p className="mt-1 max-w-sm text-sm text-muted-foreground">{t("keys.emptyBody")}</p>
                    {keysOn && (
                        <Button className="mt-6" onClick={() => setAddOpen(true)}>
                            <Plus size={16} /> {t("keys.addKey")}
                        </Button>
                    )}
                </div>
            ) : (
                <div>
                    <KeyListFilterBar filter={keyFilter} />
                    {keyFilter.visible.length > 0 &&
                        (view === "card" ? (
                            <KeyCards
                                keys={keyFilter.visible}
                                placements={page.placements}
                                groupNameOf={groupNameOf}
                                onDetails={(k) => setDetailsId(k.id)}
                                onDelete={setDeleting}
                                onDevice={page.openDevice}
                            />
                        ) : (
                            <KeyList keys={keyFilter.visible} placements={page.placements} groupNameOf={groupNameOf} onDetails={(k) => setDetailsId(k.id)} onDelete={setDeleting} />
                        ))}
                    <KeyListFilterFooter filter={keyFilter} anchor={top} />
                </div>
            )}
        </section>
    );
}
