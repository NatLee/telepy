"use client";

/**
 * 「API token 怎麼運作」說明圖：三條進 Telepy 的路，各用各的鑰匙——
 *   你的筆電 / 腳本 / CI ─token（scope、隧道、到期）─ Telepy ─SSH─ 裝置
 *   這個瀏覽器 ─登入 session─ Telepy ─ 裝置
 *   MCP app ─OAuth 授權（每個 app 各自同意）─ Telepy ─ 裝置
 * 「撤銷之後」切換：只有 token 那條被剪斷（它開的 session 一起關），另外兩條照常。開著某一把 token 時，
 * token 那條顯示它自己的 scope 與隧道。狀態來自 `lib/apiTokens.tokenLanes`（有測試）；只用直線。
 * "How API tokens work": three ways into Telepy, each with its own key. The "After a revoke" switch cuts only the
 * token lane (its sessions close too); the web sign-in and MCP apps keep working. With a token picked, its lane shows
 * that token's scopes and tunnels. States come from `lib/apiTokens.tokenLanes` (tested); straight lines only.
 */
import React, { useState } from "react";
import { Bot, Globe, HardDrive, Laptop, Scissors } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Chip } from "@/components/ui/section";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { SCOPE_META } from "@/components/oauth/ConnectFlow";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { scopeAbilities, tokenLanes, type ApiToken, type Lane } from "@/lib/apiTokens";
import type { TranslationKey } from "@/locales/en";

const LANE_TEXT: Record<Lane["id"], { title: TranslationKey; from: TranslationKey; fromSub: TranslationKey; link: TranslationKey; icon: typeof Laptop }> = {
    token: { title: "tokens.lane.token", from: "tokens.lane.tokenFrom", fromSub: "tokens.lane.tokenFromSub", link: "tokens.lane.tokenLink", icon: Laptop },
    web: { title: "tokens.lane.web", from: "tokens.lane.webFrom", fromSub: "tokens.lane.webFromSub", link: "tokens.lane.webLink", icon: Globe },
    apps: { title: "tokens.lane.apps", from: "tokens.lane.appsFrom", fromSub: "tokens.lane.appsFromSub", link: "tokens.lane.appsLink", icon: Bot },
};

export function ApiTokenFlow({ token }: { token?: ApiToken | null }) {
    const { t } = useI18n();
    const [view, setView] = useState<"now" | "revoked">("now");
    const lanes = tokenLanes(view === "revoked");
    const abilities = token ? scopeAbilities(token.scopes) : [];
    const tunnels = token ? (token.tunnels === null ? t("tokens.allTunnels") : t("tokens.tunnelCount", { count: token.tunnels.length })) : null;
    return (
        <div className="min-w-0 space-y-4">
            <Segmented
                size="sm"
                aria-label={t("tokens.infoTitle")}
                value={view}
                onChange={setView}
                options={[
                    { value: "now", label: t("tokens.infoBefore") },
                    { value: "revoked", label: t("tokens.infoAfter") },
                ]}
            />
            {lanes.map((lane) => {
                const text = LANE_TEXT[lane.id];
                const mine = lane.id === "token";
                return (
                    <section key={lane.id} className={cn("space-y-2 rounded-xl border p-3", mine ? "border-primary/40" : "border-border")} aria-label={t(text.title)}>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm text-foreground">{t(text.title)}</span>
                            {view === "revoked" &&
                                (lane.cut ? (
                                    <Chip tone="danger">
                                        <Scissors aria-hidden />
                                        {t("tokens.cut")}
                                    </Chip>
                                ) : (
                                    <Chip tone="success">{t("tokens.untouched")}</Chip>
                                ))}
                            {mine && token && <Chip tone="primary">{t("tokens.infoForToken", { name: token.name })}</Chip>}
                        </div>
                        <FlowPath>
                            <FlowNode icon={text.icon} title={t(text.from)} sub={t(text.fromSub)} state={lane.from} />
                            <FlowLink label={mine && token ? `${token.prefix}… · ${tunnels}` : t(text.link)} state={lane.credential} />
                            <FlowNode brand title="Telepy" sub={t("tokens.telepySub")} state={lane.telepy} />
                            <FlowLink label={t("tokens.devicesLink")} state={lane.devices} />
                            <FlowNode icon={HardDrive} title={t("tokens.devices")} sub={t("tokens.devicesSub")} state={lane.devices} />
                        </FlowPath>
                        {/* 這把 token 能做的事（scope）。/ What this token may do (its scopes). */}
                        {mine && token && abilities.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5 pt-1">
                                <span className="text-xs text-muted-foreground">{t("tokens.infoScopes")}</span>
                                {abilities.map((sc) => (
                                    <Chip key={sc} tone={lane.cut ? "neutral" : "primary"}>
                                        {SCOPE_META[sc] ? t(SCOPE_META[sc].label) : sc}
                                    </Chip>
                                ))}
                            </div>
                        )}
                    </section>
                );
            })}
            <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
                <li>{t("tokens.infoPoint1")}</li>
                <li>{t("tokens.infoPoint2")}</li>
                <li>{t("tokens.infoPoint3")}</li>
                <li>{t("tokens.infoPoint4")}</li>
            </ul>
        </div>
    );
}

export function ApiTokenInfoDialog({ isOpen, onClose, token }: { isOpen: boolean; onClose: () => void; token?: ApiToken | null }) {
    const { t } = useI18n();
    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("tokens.infoTitle")}
            description={t("tokens.infoDescription")}
            size="4xl"
            footer={
                <Button type="button" variant="outline" onClick={onClose}>
                    {t("common.close")}
                </Button>
            }
        >
            <ApiTokenFlow token={token} />
        </Modal>
    );
}
