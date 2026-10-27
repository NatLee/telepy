"use client";

/**
 * SSH 金鑰區的外框：標題列（怎麼運作 / 重新整理 / 新增金鑰）、子頁分頁（我的金鑰 / 金鑰群組 / 裝置，側欄也列出來）、
 * 「裝置金鑰清單怎麼運作」說明，以及共用的資料與視窗（`KeysAreaProvider`）。以前三塊擠在同一頁，金鑰或裝置一多就很長。
 * The SSH keys area's frame: the header (how it works / refresh / add key), the sub-page tabs (your keys / key
 * groups / devices, also listed in the sidebar), the "how device key lists work" explainer, and the shared data and
 * dialogs (`KeysAreaProvider`). The three parts used to share one page, which got long with many keys or devices.
 */
import React, { Suspense, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CircleHelp, HardDrive, Key as KeyIcon, KeyRound, Layers, Plus, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { KeyListExplainer } from "@/components/keys/KeyListExplainer";
import { KeysAreaProvider, useKeysArea } from "@/components/keys/KeysArea";
import { useI18n } from "@/lib/i18n";
import { expiryState } from "@/lib/keyExpiry";

const EXPLAINER_KEY = "telepy.keysExplainer";

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
    // 頁面只在瀏覽器端算繪（Suspense 內），直接讀 localStorage。沒選過時，只有還沒有金鑰的人看到說明（已有金鑰的人
    // 用標題列的「怎麼運作」打開），免得它把清單推到第二個畫面。
    // Client-only (inside Suspense), so localStorage is read up front. Without a stored choice only people with no
    // keys yet see the explainer (others open it from the header), so it never pushes the lists below the fold.
    const [explainerChoice, setExplainerChoice] = useState<"shown" | "hidden" | null>(() => {
        try {
            const v = localStorage.getItem(EXPLAINER_KEY);
            return v === "shown" || v === "hidden" ? v : null;
        } catch {
            return null;
        }
    });
    const firstLoad = page.loading && page.keys.length === 0;
    const explainer = explainerChoice === "shown" || (explainerChoice === null && !page.loading && page.keys.length === 0);
    const showExplainer = (show: boolean) => {
        setExplainerChoice(show ? "shown" : "hidden");
        try {
            localStorage.setItem(EXPLAINER_KEY, show ? "shown" : "hidden");
        } catch {
            /* ignore */
        }
    };
    // 「我的金鑰」分頁上的小點：有已到期或 7 天內到期的金鑰。/ A dot on "Your keys" when a key expired or expires within a week.
    const expiring = page.keys.some((k) => ["soon", "expired"].includes(expiryState(k.expires_at)));
    const tab = tabOf(pathname);

    return (
        <div className="animate-fade-in-up space-y-6">
            <PageHeader
                icon={<KeyIcon />}
                title={t("keys.title")}
                description={t("keys.subtitle")}
                actions={
                    <>
                        {!explainer && !firstLoad && (
                            <Button variant="ghost" onClick={() => showExplainer(true)}>
                                <CircleHelp size={16} /> {t("keys.how.show")}
                            </Button>
                        )}
                        <Button variant="outline" onClick={page.refresh} disabled={page.loading} aria-label={t("keys.refreshAria")}>
                            <RefreshCw size={16} className={page.loading ? "animate-spin" : ""} />
                            {t("common.refresh")}
                        </Button>
                        <Button onClick={() => setAddOpen(true)}>
                            <Plus size={16} />
                            {t("keys.addKey")}
                        </Button>
                    </>
                }
            />

            {explainer && <KeyListExplainer onHide={() => showExplainer(false)} />}

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
