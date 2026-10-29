"use client";

/**
 * SSH 金鑰區的外框：標題列（運作方式 → 說明視窗 / 重新整理 / 新增金鑰）、子頁分頁（我的金鑰 / 金鑰群組 / 裝置，側欄
 * 也列出來），以及共用的資料與視窗（`KeysAreaProvider`）。以前三塊擠在同一頁，金鑰或裝置一多就很長。
 * The SSH keys area's frame: the header (how it works → explainer dialog / refresh / add key), the sub-page tabs
 * (your keys / key groups / devices, also listed in the sidebar), and the shared data and dialogs
 * (`KeysAreaProvider`). The three parts used to share one page, which got long with many keys or devices.
 */
import React, { Suspense, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { HardDrive, Info, Key as KeyIcon, KeyRound, Layers, Plus } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Segmented } from "@/components/ui/segmented";
import { KeyListExplainerDialog } from "@/components/keys/KeyListExplainer";
import { KeysAreaProvider, useKeysArea } from "@/components/keys/KeysArea";
import { useI18n } from "@/lib/i18n";
import { useFeatures } from "@/hooks/useFeatures";
import { Callout } from "@/components/ui/callout";
import { expiryState } from "@/lib/keyExpiry";

const KEYS_TABS = [
    { value: "mine", href: "/tunnels/keys" },
    { value: "groups", href: "/tunnels/keys/groups" },
    { value: "devices", href: "/tunnels/keys/devices" },
] as const;
type KeysTab = (typeof KEYS_TABS)[number]["value"];

function tabOf(pathname: string): KeysTab {
    return KEYS_TABS.find((tab) => tab.value !== "mine" && pathname.startsWith(tab.href))?.value ?? "mine";
}

function Count({ n }: { n: number | null }) {
    if (n === null) return null;
    return <span className="ml-1.5 rounded-sm bg-muted px-1.5 font-mono text-xs leading-5 text-muted-foreground tabular-nums">{n}</span>;
}

function KeysShell({ children }: { children: React.ReactNode }) {
    const { t } = useI18n();
    const router = useRouter();
    const pathname = usePathname();
    const { page, keyGroups, setAddOpen } = useKeysArea();
    // 「運作方式」跟其他頁面的 info 一樣打開對話框。/ "How it works" opens a dialog like every other page's info.
    const [howOpen, setHowOpen] = useState(false);
    const firstLoad = page.loading && page.keys.length === 0;
    // 「我的金鑰」分頁上的小點：有已到期或 7 天內到期的金鑰。/ A dot on "Your keys" when a key expired or expires within a week.
    const expiring = page.keys.some((k) => ["soon", "expired"].includes(expiryState(k.expires_at)));
    const tab = tabOf(pathname);
    // 「個人 SSH 金鑰」被管理員關掉：看得到、刪得掉現有的，不能新增（筆電經 gateway 也連不上）。
    // Personal keys turned off: existing keys can be seen and deleted, not added (laptop SSH is refused too).
    const keysOn = useFeatures().has("keys.personal");
    // 重新整理後畫面上的金鑰 / 群組 / 裝置依序淡入。/ After Refresh, the keys / groups / devices on screen fade back in.
    const pageRef = useRef<HTMLDivElement>(null);
    // 三個分頁共用一顆鈕：金鑰、裝置矩陣，連金鑰群組也重抓（以前「金鑰群組」頁按了不會更新群組）。
    // One button for all three sub-pages: keys, the matrix and the key groups too (the groups page used to skip them).
    const refreshAll = async () => {
        const [ok] = await Promise.all([page.refresh(), keyGroups.load()]);
        return ok;
    };

    return (
        <div ref={pageRef} className="animate-fade-in-up space-y-6">
            <PageHeader
                icon={<KeyIcon />}
                title={t("keys.title")}
                description={t("keys.subtitle")}
                actions={
                    <>
                        <Button variant="outline" onClick={() => setHowOpen(true)}>
                            <Info size={16} /> {t("keys.how.show")}
                        </Button>
                        <RefreshButton onRefresh={refreshAll} busy={page.loading} ripple={pageRef} label={t("common.refresh")} aria-label={t("keys.refreshAria")} />
                        {keysOn && (
                            <Button onClick={() => setAddOpen(true)}>
                                <Plus size={16} />
                                {t("keys.addKey")}
                            </Button>
                        )}
                    </>
                }
            />

            {!keysOn && <Callout tone="warning">{t("access.keysOff")}</Callout>}

            <KeyListExplainerDialog isOpen={howOpen} onClose={() => setHowOpen(false)} />

            <div className="-mx-1 overflow-x-auto px-1 pb-0.5">
                <Segmented
                    kind="tabs"
                    aria-label={t("keys.title")}
                    value={tab}
                    onChange={(v) => router.push(KEYS_TABS.find((x) => x.value === v)!.href)}
                    options={[
                        {
                            value: "mine",
                            icon: <KeyRound size={15} />,
                            title: t("keys.mine"),
                            label: (
                                <>
                                    {t("keys.mine")}
                                    <Count n={firstLoad ? null : page.keys.length} />
                                    {expiring && <span className="ml-1.5 inline-block size-1.5 rounded-full bg-warning align-middle" aria-label={t("keys.expiry.label")} />}
                                </>
                            ),
                        },
                        {
                            value: "groups",
                            icon: <Layers size={15} />,
                            title: t("groups.key.title"),
                            label: (
                                <>
                                    {t("groups.key.title")}
                                    <Count n={keyGroups.loaded ? keyGroups.groups.length : null} />
                                </>
                            ),
                        },
                        {
                            value: "devices",
                            icon: <HardDrive size={15} />,
                            title: t("keys.devices"),
                            label: (
                                <>
                                    {t("keys.devices")}
                                    <Count n={firstLoad ? null : page.devices.length} />
                                </>
                            ),
                        },
                    ]}
                />
            </div>

            {children}
        </div>
    );
}

export default function KeysLayout({ children }: { children: React.ReactNode }) {
    // useSearchParams（?device=）需要 Suspense 邊界，否則靜態產生會整頁退回 client render。
    // useSearchParams (?device=) needs a Suspense boundary or static generation bails out for the whole page.
    return (
        <Suspense fallback={null}>
            <KeysAreaProvider>
                <KeysShell>{children}</KeysShell>
            </KeysAreaProvider>
        </Suspense>
    );
}
