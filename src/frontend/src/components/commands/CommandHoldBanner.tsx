"use client";

/**
 * 終端機上方的指令規則提示列（終端機頁與區網終端機共用）：被擋下、等核准（倒數 + 撤回；owner / ADMIN 可以自己按「執行」）、
 * 核准 / 拒絕 / 逾時 / 撤回的結果。疊在終端機上，不改變終端機大小（不會觸發 PTY resize）。
 * The command-rule banner above a terminal (terminal page and LAN terminals): blocked, waiting for approval (countdown
 * + withdraw; owners / ADMINs can run it themselves), and the outcome. It overlays the terminal so the terminal never
 * changes size (no PTY resize).
 */
import React, { useEffect, useState } from "react";
import { Ban, Bell, BellOff, Check, CircleCheck, Hourglass, Info, OctagonX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { bannerLifetime, countdown, ruleSource, type HoldBanner } from "@/lib/commandRules";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useCountdown } from "./CommandApprovals";
import { RuleSource } from "./RuleList";

const TONE: Record<HoldBanner["state"], string> = {
    pending: "border-warning/40",
    blocked: "border-destructive/40",
    error: "border-warning/40",
    warned: "border-foreground/30",
    approved: "border-success/40",
    denied: "border-destructive/40",
    cancelled: "border-border",
    expired: "border-border",
};

const ICON: Record<HoldBanner["state"], React.ReactNode> = {
    pending: <Hourglass size={16} className="text-warning" aria-hidden />,
    blocked: <Ban size={16} className="text-destructive" aria-hidden />,
    error: <Info size={16} className="text-warning" aria-hidden />,
    warned: <Bell size={16} className="text-foreground" aria-hidden />,
    approved: <CircleCheck size={16} className="text-success" aria-hidden />,
    denied: <OctagonX size={16} className="text-destructive" aria-hidden />,
    cancelled: <Info size={16} className="text-muted-foreground" aria-hidden />,
    expired: <Info size={16} className="text-muted-foreground" aria-hidden />,
};

export function CommandHoldBanner({ banner, onWithdraw, onDismiss }: { banner: HoldBanner; onWithdraw: () => void; onDismiss: () => void }) {
    const { t } = useI18n();
    const { user } = useAuth();
    const left = useCountdown(banner.state === "pending" ? banner.expiresAt : null);
    const [busy, setBusy] = useState(false);

    // 結果類的提示自己會消失。/ Outcome notices fade on their own.
    useEffect(() => {
        const ms = bannerLifetime(banner.state);
        if (ms === null) return;
        const id = setTimeout(onDismiss, ms);
        return () => clearTimeout(id);
    }, [banner, onDismiss]);

    // 提醒：不再提醒我（強制的不能）。/ A reminder: mute it for me (not an enforced one).
    const canMute = banner.state === "warned" && banner.rule?.id != null && banner.rule.mode !== "enforced";
    const muteIt = async () => {
        if (!banner.rule?.id) return;
        setBusy(true);
        const res = await apiFetch(`/api/command-rules/${banner.rule.id}/mute`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
        setBusy(false);
        if (res.ok) onDismiss();
    };

    const approveSelf = async () => {
        if (banner.requestId === null) return;
        setBusy(true);
        await apiFetch(`/api/command-requests/${banner.requestId}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        setBusy(false);
    };

    const rule = banner.rule;
    const ruleLine = rule ? (
        <span className="block text-xs text-muted-foreground">
            <RuleSource rule={rule} /> <code className="font-mono text-foreground">{rule.pattern}</code>
            {rule.note && <span className="text-foreground/80"> · “{rule.note}”</span>}
        </span>
    ) : null;

    let title: string;
    let detail: React.ReactNode = null;
    switch (banner.state) {
        case "pending":
            title = banner.canDecide ? t("commands.banner.pendingSelf") : t("commands.banner.pending");
            detail = banner.canDecide ? t("commands.banner.pendingSelfHint") : t("commands.banner.pendingHint");
            break;
        case "blocked":
            title = t("commands.banner.blocked");
            // 自己的規則擋下的：去改自己的規則，不用問 owner。/ Blocked by your own rule: change it rather than ask the owner.
            detail = rule && ruleSource(rule, user?.id).key === "commands.matchedOwnRule" ? t("commands.banner.blockedOwnHint") : t("commands.banner.blockedHint");
            break;
        case "error":
            title = t("commands.banner.error");
            break;
        case "warned":
            title = t("commands.banner.warned");
            detail = t("commands.banner.warnedHint");
            break;
        case "approved":
            title = t("commands.banner.approved", { by: banner.by ?? "?" });
            break;
        case "denied":
            title = t("commands.banner.denied", { by: banner.by ?? "?" });
            detail = banner.reason ? `“${banner.reason}”` : null;
            break;
        case "expired":
            title = t("commands.banner.expired");
            break;
        default:
            title = t("commands.banner.cancelled");
    }

    return (
        <div role="status" aria-live="polite" className={cn("rounded-lg border bg-card/95 p-2.5 text-sm shadow-pop", TONE[banner.state])}>
            <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0">{ICON[banner.state]}</span>
                <div className="min-w-0 flex-1 space-y-1">
                    <p className="flex flex-wrap items-baseline gap-x-2 text-foreground">
                        <span>{title}</span>
                        {left !== null && <span className={cn("font-mono text-xs tabular-nums", left < 60 ? "text-destructive" : "text-muted-foreground")}>{t("commands.banner.left", { time: countdown(left) })}</span>}
                    </p>
                    {banner.command && <code className="block truncate font-mono text-xs text-foreground" title={banner.command}>{banner.command.replace(/\n/g, " ⏎ ")}</code>}
                    {ruleLine}
                    {/* 等核准的說明在手機上收起來，提示列才不會蓋住剛打的那一行。/ The waiting hint is hidden on phones so the banner stays short. */}
                    {detail && <span className={cn("text-xs text-muted-foreground", banner.state === "pending" ? "hidden sm:block" : "block")}>{detail}</span>}
                </div>
                {banner.state !== "pending" && (
                    <Button size="icon-xs" variant="ghost" onClick={onDismiss} aria-label={t("common.close")} title={t("common.close")}>
                        <X />
                    </Button>
                )}
            </div>
            {canMute && (
                <div className="mt-2 flex justify-end">
                    <Button size="xs" variant="outline" onClick={() => void muteIt()} disabled={busy}>
                        <BellOff /> {t("commands.banner.mute")}
                    </Button>
                </div>
            )}
            {banner.state === "pending" && (
                <div className="mt-2 flex justify-end gap-2">
                    <Button size="xs" variant="outline" onClick={onWithdraw} disabled={busy}>
                        <X /> {banner.canDecide ? t("common.cancel") : t("commands.withdraw")}
                    </Button>
                    {banner.canDecide && (
                        <Button size="xs" onClick={() => void approveSelf()} disabled={busy}>
                            <Check /> {t("commands.runIt")}
                        </Button>
                    )}
                </div>
            )}
        </div>
    );
}
