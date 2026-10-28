"use client";

/**
 * 偏好設定 → 終端機 → 「Shell 歷史」：個人預設要不要把 Telepy 的 shell（網頁終端機、工具箱、自己的 MCP app）打的
 * 指令留在裝置的歷史檔裡；每條隧道可以在詳細資訊裡個別覆寫。info 按鈕開說明圖。
 * Preferences → Terminal → "Shell history": the personal default for keeping commands typed in Telepy's shells out of
 * the device's history file; each tunnel can override it in its details. The info button opens the diagram.
 */
import React, { useState } from "react";
import { FileClock, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/ui/section";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/Toast";
import { useShellHistory } from "@/hooks/useShellHistory";
import { useI18n } from "@/lib/i18n";
import { ShellHistoryInfoDialog } from "./ShellHistoryInfoDialog";

export function ShellHistoryPref() {
    const { t } = useI18n();
    const { showError } = useToast();
    const pref = useShellHistory();
    const [info, setInfo] = useState(false);
    return (
        <Section
            icon={<FileClock />}
            title={t("shellHistory.title")}
            description={t("shellHistory.description")}
            action={
                <Button variant="ghost" size="icon" onClick={() => setInfo(true)} aria-label={t("shellHistory.info")} title={t("shellHistory.info")}>
                    <Info />
                </Button>
            }
        >
            <Switch
                checked={pref.mode === "skip"}
                onCheckedChange={async (on) => {
                    if (!(await pref.setMode(on ? "skip" : "keep"))) showError(t("shellHistory.saveFailed"));
                }}
            >
                {t("shellHistory.switch")}
            </Switch>
            <p className="text-xs text-muted-foreground">{t("shellHistory.switchHint")}</p>
            <ShellHistoryInfoDialog isOpen={info} onClose={() => setInfo(false)} mode={pref.mode} />
        </Section>
    );
}
