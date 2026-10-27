"use client";

/**
 * 偏好設定 → 一般 → 「斷線後保留 shell」：選多久（超過站台上限的選項關掉），旁邊的 info 按鈕打開時間軸圖。
 * Preferences → General → "Keep shells after a disconnect": pick the time (choices above the site's ceiling are
 * disabled); the info button opens the timeline diagram.
 */
import React, { useState } from "react";
import { Info, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Section } from "@/components/ui/section";
import { useTerminalDetach } from "@/hooks/useTerminalDetach";
import { useI18n } from "@/lib/i18n";
import { DETACH_CHOICES, detachChoiceAllowed, detachLayers, isDetachChoice } from "@/lib/terminalDetach";
import { DetachInfoDialog, graceLabel } from "./DetachTimeline";

export function TerminalDetachPref() {
    const { t } = useI18n();
    const detach = useTerminalDetach();
    const [info, setInfo] = useState(false);
    return (
        <Section
            icon={<Unplug />}
            title={t("detach.title")}
            description={t("detach.description")}
            action={
                <Button variant="ghost" size="icon" onClick={() => setInfo(true)} aria-label={t("detach.info")} title={t("detach.info")}>
                    <Info />
                </Button>
            }
        >
            <NativeSelect
                className="h-9 w-full sm:w-64"
                value={String(detach.choice)}
                onChange={(e) => {
                    const v = Number(e.target.value);
                    if (isDetachChoice(v)) void detach.setChoice(v);
                }}
                aria-label={t("detach.title")}
                disabled={detach.limit <= 0}
            >
                {DETACH_CHOICES.map((secs) => (
                    <option key={secs} value={secs} disabled={!detachChoiceAllowed(secs, detach.limit)}>
                        {graceLabel(t, secs)}
                    </option>
                ))}
            </NativeSelect>
            {detach.limit <= 0 ? (
                <p className="text-xs text-muted-foreground">{t("detach.siteOff")}</p>
            ) : detach.choice > detach.limit ? (
                <p className="text-xs text-muted-foreground">{t("detach.limited", { limit: graceLabel(t, detach.limit) })}</p>
            ) : null}
            <DetachInfoDialog
                isOpen={info}
                onClose={() => setInfo(false)}
                phase="preview"
                grace={detach.effective}
                layers={detachLayers(detach.choice, detach.limit, null)}
            />
        </Section>
    );
}
