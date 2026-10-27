"use client";

/**
 * API 頁的總覽圖：三條進 Telepy 的路，各用各的鑰匙——
 *   這個瀏覽器 ─登入 session─ Telepy ─SSH─ 裝置（網頁上能做的全部）
 *   腳本 / CLI / CI ─API token（scope、隧道、到期）─ Telepy ─ 裝置（只有白名單上的端點）
 *   MCP app ─OAuth 同意（每個 app 各自）─ Telepy ─ 裝置
 * 「如果我…」切換：撤銷 token / 中斷 app / 登出，只切掉自己那條，另外兩條照常。狀態來自 `lib/apiCalls.waysIn`（有測試）；只用直線。
 * The API page's overview: three ways into Telepy, each with its own key. The "What if I…" switch cuts only the lane
 * of the chosen revoke; the other two keep working. States come from `lib/apiCalls.waysIn` (tested); straight lines.
 */
import React, { useState } from "react";
import { Bot, Globe, HardDrive, Laptop, Scissors } from "lucide-react";
import { Segmented } from "@/components/ui/segmented";
import { Chip } from "@/components/ui/section";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { WHAT_IFS, waysIn, type WayId, type WhatIf } from "@/lib/apiCalls";
import type { TranslationKey } from "@/locales/en";

const WAY_TEXT: Record<WayId, { title: TranslationKey; from: TranslationKey; fromSub: TranslationKey; link: TranslationKey; reach: TranslationKey; revoke: TranslationKey; icon: typeof Laptop }> = {
    web: { title: "apiPage.way.web", from: "apiPage.way.webFrom", fromSub: "apiPage.way.webFromSub", link: "apiPage.way.webLink", reach: "apiPage.way.webReach", revoke: "apiPage.way.webRevoke", icon: Globe },
    token: { title: "apiPage.way.token", from: "apiPage.way.tokenFrom", fromSub: "apiPage.way.tokenFromSub", link: "apiPage.way.tokenLink", reach: "apiPage.way.tokenReach", revoke: "apiPage.way.tokenRevoke", icon: Laptop },
    app: { title: "apiPage.way.app", from: "apiPage.way.appFrom", fromSub: "apiPage.way.appFromSub", link: "apiPage.way.appLink", reach: "apiPage.way.appReach", revoke: "apiPage.way.appRevoke", icon: Bot },
};

const WHAT_IF_LABEL: Record<WhatIf, TranslationKey> = {
    none: "apiPage.whatIf.none",
    token: "apiPage.whatIf.token",
    app: "apiPage.whatIf.app",
    web: "apiPage.whatIf.web",
};

export function WaysInDiagram() {
    const { t } = useI18n();
    const [whatIf, setWhatIf] = useState<WhatIf>("none");
    const ways = waysIn(whatIf);
    return (
        <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("apiPage.whatIf.label")}</span>
                <div className="max-w-full overflow-x-auto">
                    <Segmented size="sm" aria-label={t("apiPage.whatIf.label")} value={whatIf} onChange={setWhatIf} options={WHAT_IFS.map((w) => ({ value: w, label: t(WHAT_IF_LABEL[w]) }))} />
                </div>
            </div>
            {ways.map((way) => {
                const text = WAY_TEXT[way.id];
                return (
                    <section key={way.id} aria-label={t(text.title)} className={cn("space-y-2 rounded-xl border p-3", way.id === "token" ? "border-primary/40" : "border-border")}>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm text-foreground">{t(text.title)}</span>
                            {whatIf !== "none" &&
                                (way.cut ? (
                                    <Chip tone="danger">
                                        <Scissors aria-hidden />
                                        {t("apiPage.way.cut")}
                                    </Chip>
                                ) : (
                                    <Chip tone="success">{t("apiPage.way.untouched")}</Chip>
                                ))}
                        </div>
                        <FlowPath>
                            <FlowNode icon={text.icon} title={t(text.from)} sub={t(text.fromSub)} state={way.from} />
                            <FlowLink label={t(text.link)} state={way.credential} />
                            <FlowNode brand title="Telepy" sub={t("apiPage.way.telepySub")} state={way.telepy} />
                            <FlowLink label="SSH" state={way.devices} />
                            <FlowNode icon={HardDrive} title={t("apiPage.way.devices")} sub={t("apiPage.way.devicesSub")} state={way.devices} />
                        </FlowPath>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                            <span className="text-foreground">{t("apiPage.way.reachLabel")}</span> {t(text.reach)}
                        </p>
                        <p className={cn("text-xs leading-relaxed", way.cut ? "text-destructive" : "text-muted-foreground")}>
                            <span className={way.cut ? undefined : "text-foreground"}>{t("apiPage.way.revokeLabel")}</span> {t(text.revoke)}
                        </p>
                    </section>
                );
            })}
        </div>
    );
}
