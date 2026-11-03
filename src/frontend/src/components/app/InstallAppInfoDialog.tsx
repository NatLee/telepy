"use client";

/**
 * 「安裝成 app」的說明圖：Ctrl+W 從鍵盤出發，經過瀏覽器分頁 / app 視窗，能不能到終端機與裝置上的 shell。可以切換
 * 「在分頁裡 / 裝成 app」與「焦點在終端機 / 別處」，線與節點跟著亮或斷（`lib/installApp.keyPath`）。
 * The "Install as an app" diagram: Ctrl+W leaves the keyboard and, through a browser tab or an app window, reaches the
 * terminal and the device's shell — or not. Switch "in a tab / as an app" and "focus in the terminal / elsewhere"; the
 * links and nodes follow (`lib/installApp.keyPath`).
 */
import React, { useState } from "react";
import { AppWindow, Keyboard, PanelTop, Server, SquareTerminal } from "lucide-react";
import { FlowLink, FlowNode, FlowNow, FlowPath } from "@/components/flow/PathFlow";
import { Callout } from "@/components/ui/callout";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/segmented";
import { useInstallApp } from "@/hooks/useInstallApp";
import { useI18n } from "@/lib/i18n";
import { keyPath, type KeyFocus, type KeyWhere } from "@/lib/installApp";

export function InstallAppInfoDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const { t } = useI18n();
    const { standalone } = useInstallApp();
    // 從現在的樣子開始：已經是 app 就從 app 開始。/ Start from how it runs now.
    const [where, setWhere] = useState<KeyWhere>(standalone ? "app" : "tab");
    const [focus, setFocus] = useState<KeyFocus>("terminal");
    const path = keyPath(where, focus);
    const failed = path.outcome !== "deletesWord";

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t("app.flow.title")} description={t("app.flow.description")} icon={<AppWindow />} size="5xl">
            <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                        <p className="text-xs text-muted-foreground">{t("app.flow.where")}</p>
                        <Segmented
                            fullWidth
                            size="sm"
                            options={[
                                { value: "tab" as const, label: t("app.flow.tab") },
                                { value: "app" as const, label: t("app.flow.app") },
                            ]}
                            value={where}
                            onChange={setWhere}
                            aria-label={t("app.flow.where")}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <p className="text-xs text-muted-foreground">{t("app.flow.focus")}</p>
                        <Segmented
                            fullWidth
                            size="sm"
                            options={[
                                { value: "terminal" as const, label: t("app.flow.focusTerminal") },
                                { value: "elsewhere" as const, label: t("app.flow.focusElsewhere") },
                            ]}
                            value={focus}
                            onChange={setFocus}
                            aria-label={t("app.flow.focus")}
                        />
                    </div>
                </div>

                <FlowPath>
                    <FlowNode icon={Keyboard} title={t("app.flow.keyboard")} sub="Ctrl+W" state="ok" stateText={t("app.flow.pressed")} />
                    <FlowLink compact label="Ctrl+W" state="ok" />
                    <FlowNode
                        icon={where === "tab" ? PanelTop : AppWindow}
                        title={t(where === "tab" ? "app.flow.tabNode" : "app.flow.appNode")}
                        state={path.window}
                        stateText={t(path.window === "ok" ? "app.flow.passes" : where === "tab" ? "app.flow.closesTab" : "app.flow.closesWindow")}
                    />
                    <FlowLink compact label={t("app.flow.toPage")} state={path.terminal} />
                    <FlowNode brand icon={SquareTerminal} title={t("app.flow.terminal")} state={path.terminal} stateText={path.terminal === "ok" ? t("app.flow.sends") : t("app.flow.neverSees")} />
                    <FlowLink compact label={t("app.flow.tunnel")} state={path.shell} />
                    <FlowNode icon={Server} title={t("app.flow.shell")} state={path.shell} stateText={path.shell === "ok" ? t("app.flow.deletesWord") : t("app.flow.neverSees")} />
                </FlowPath>

                <FlowNow failed={failed}>{t(`app.flow.out.${path.outcome}`)}</FlowNow>

                <Callout tone="info">{t("app.flow.mac")}</Callout>
            </div>
        </Modal>
    );
}
