"use client";

/**
 * 一鍵加入指令在裝置上做什麼：七步的流程圖，照票的階段即時亮起（Telepy 看得到的是註冊、隧道連上與驗證；前幾步在裝置上
 * 進行）。大致正確即可：腳本細節（候選 host key 從哪來、wget 或 curl）不畫，步驟的一句話說清楚就好。
 * What the join command does on the device: seven steps lit live from the ticket's phase (Telepy sees registration,
 * the tunnel coming up and the verification; the earlier steps happen on the device). Roughly right on purpose: the
 * script's details are not drawn, each step is one sentence.
 */
import React from "react";
import { Cpu, Fingerprint, KeyRound, Network, PlugZap, ShieldCheck, UserCheck, type LucideIcon } from "lucide-react";
import { FlowNow, FlowSteps } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { SCRIPT_STEPS, scriptProgress, type JoinPhase } from "@/lib/joinScript";

const ICONS: LucideIcon[] = [Cpu, Fingerprint, Network, PlugZap, KeyRound, ShieldCheck, UserCheck];

export function JoinScriptFlow({ phase, hasTunnel, expired = false, account, deviceName, className }: { phase: JoinPhase; hasTunnel: boolean; expired?: boolean; account?: string | null; deviceName?: string | null; className?: string }) {
    const { t } = useI18n();
    const p = scriptProgress(phase, hasTunnel, expired);
    const vars = { account: account || "…", device: deviceName || t("join.thisDevice") };
    const steps = SCRIPT_STEPS.map((key, i) => {
        const Icon = ICONS[i];
        return (
            <span key={key} className="flex items-start gap-2">
                <Icon size={14} className="mt-0.5 shrink-0 opacity-70" aria-hidden />
                <span>{t(key, vars)}</span>
            </span>
        );
    });
    return (
        <div className={cn("space-y-3", className)}>
            <FlowNow failed={p.failed}>{t(p.now)}</FlowNow>
            <FlowSteps steps={steps} current={p.current} done={p.done} failed={p.failed} />
            {phase === "waiting" && !expired && <p className="text-xs leading-relaxed text-muted-foreground">{t("join.flow.unseen")}</p>}
        </div>
    );
}
