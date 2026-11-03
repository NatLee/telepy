"use client";

/**
 * 偏好設定的「安裝成 app」分頁：這台瀏覽器能不能裝、怎麼裝（Chrome / Edge 直接一個按鈕，其他照平台說明選單在哪），
 * 裝起來叫什麼（網站設定的 App 名稱），以及裝了之後有什麼不同。資訊按鈕打開 Ctrl+W 會到哪裡的說明圖。
 * The Preferences "Install as an app" tab: whether and how this browser installs Telepy (a button in Chrome / Edge,
 * otherwise where the menu item is on each platform), what it will be called (the App name site setting) and what
 * changes once installed. The info button opens the "where Ctrl+W goes" diagram.
 */
import React, { useState } from "react";
import { AppWindow, CheckCircle2, Download, Info, Keyboard, ListChecks, Smartphone, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Section } from "@/components/ui/section";
import { useAppName } from "@/hooks/useAppName";
import { useInstallApp } from "@/hooks/useInstallApp";
import { useI18n } from "@/lib/i18n";
import { homeLabel, type InstallGuide } from "@/lib/installApp";
import type { TranslationKey } from "@/locales/en";
import { InstallAppInfoDialog } from "./InstallAppInfoDialog";

const GUIDE_TEXT: Record<Exclude<InstallGuide, "installed" | "prompt" | "insecure">, TranslationKey> = {
    ios: "app.guide.ios",
    android: "app.guide.android",
    macSafari: "app.guide.macSafari",
    chromium: "app.guide.chromium",
    firefox: "app.guide.firefox",
    other: "app.guide.other",
};

export function InstallAppPanel() {
    const { t } = useI18n();
    const name = useAppName();
    const { guide, install } = useInstallApp();
    const [outcome, setOutcome] = useState<"accepted" | "dismissed" | null>(null);
    const [infoOpen, setInfoOpen] = useState(false);

    const onInstall = async () => setOutcome(await install());

    return (
        <div className="space-y-6">
            <Section
                icon={<AppWindow />}
                title={t("app.title")}
                description={t("app.description")}
                action={
                    <Button type="button" size="sm" variant="outline" onClick={() => setInfoOpen(true)}>
                        <Info size={14} /> {t("app.howItWorks")}
                    </Button>
                }
            >
                {/* 裝起來的樣子：圖示 + 主畫面上的名字。/ What it will look like: the icon and the home-screen label. */}
                <div className="flex items-center gap-3 rounded-xl bg-surface p-3 ring-1 ring-inset ring-border/80">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/icons/icon-192.png" alt="" width={44} height={44} className="size-11 shrink-0 rounded-[0.7rem]" />
                    <div className="min-w-0">
                        <p className="truncate text-sm text-foreground">{homeLabel(name)}</p>
                        <p className="text-xs leading-snug text-muted-foreground">{t("app.nameFrom")}</p>
                    </div>
                </div>

                {guide === "installed" && (
                    <Callout tone="tip" icon={<CheckCircle2 size={17} className="mt-0.5 shrink-0" aria-hidden />}>
                        {t("app.installed")}
                    </Callout>
                )}
                {guide === "insecure" && <Callout tone="warning">{t("app.guide.insecure")}</Callout>}
                {guide === "prompt" && (
                    <div className="flex flex-wrap items-center gap-3">
                        <Button type="button" onClick={() => void onInstall()}>
                            <Download /> {t("app.install", { name })}
                        </Button>
                        {outcome === "dismissed" && <span className="text-sm text-muted-foreground">{t("app.installDismissed")}</span>}
                    </div>
                )}
                {guide !== "installed" && guide !== "insecure" && guide !== "prompt" && (
                    <Callout tone={guide === "firefox" ? "warning" : "info"} icon={<Smartphone size={17} className="mt-0.5 shrink-0" aria-hidden />}>
                        {t(GUIDE_TEXT[guide])}
                    </Callout>
                )}
                {outcome === "accepted" && <Callout tone="tip">{t("app.installAccepted")}</Callout>}
            </Section>

            <Section icon={<ListChecks />} title={t("app.changesTitle")}>
                <ul className="space-y-3 text-sm leading-relaxed">
                    <Change icon={<Keyboard size={16} />}>{t("app.changeKeys")}</Change>
                    <Change icon={<XCircle size={16} />}>{t("app.changeClose")}</Change>
                    <Change icon={<Smartphone size={16} />}>{t("app.changeIos")}</Change>
                </ul>
            </Section>

            <InstallAppInfoDialog isOpen={infoOpen} onClose={() => setInfoOpen(false)} />
        </div>
    );
}

function Change({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
    return (
        <li className="flex gap-2.5">
            <span className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden>
                {icon}
            </span>
            <span className="min-w-0 text-foreground">{children}</span>
        </li>
    );
}
