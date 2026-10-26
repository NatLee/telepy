/**
 * 金鑰在每個 OS 帳號上的狀態小籤：已裝上（綠）/ 等待中（琥珀；裝置離線時寫明）/ 失敗（紅，滑過看原因）。
 * Per-account status chips for a key: installed (green), pending (amber; says so when the device is
 * offline) and failed (red, hover for the reason).
 */
import React from "react";
import { CircleAlert, CircleCheck, Clock3 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { KeyTarget } from "@/types/keys";

const STYLE = {
    installed: "bg-success/10 text-success ring-success/25",
    pending: "bg-warning/10 text-warning ring-warning/30",
    error: "bg-destructive/8 text-destructive ring-destructive/25",
} as const;

const ICON = { installed: CircleCheck, pending: Clock3, error: CircleAlert } as const;

export function TargetChip({ target, online = true }: { target: KeyTarget; online?: boolean }) {
    const { t } = useI18n();
    const Icon = ICON[target.status];
    const tip =
        target.status === "installed"
            ? t("keys.status.installedTip", { account: target.username })
            : target.status === "error"
              ? t("keys.status.errorTip", { account: target.username, error: target.error ?? "" })
              : online
                ? t("keys.status.pendingTip", { account: target.username })
                : t("keys.status.offlineTip", { account: target.username });
    return (
        <TooltipProvider delayDuration={150}>
            <Tooltip>
                <TooltipTrigger asChild>
                    <span
                        tabIndex={0}
                        className={cn(
                            "inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[0.75rem] ring-1 ring-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                            STYLE[target.status]
                        )}
                    >
                        <Icon size={12} className={cn("shrink-0", target.status === "pending" && online && "animate-pulse")} aria-hidden />
                        <span className="truncate">{target.username}</span>
                        <span className="sr-only">{t(`keys.status.${target.status}`)}</span>
                    </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-xs">{tip}</TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}

/** 金鑰沒選的帳號：灰籤。/ An account the key was not chosen for: a muted chip. */
function UnchosenChip({ username }: { username: string }) {
    const { t } = useI18n();
    return (
        <TooltipProvider delayDuration={150}>
            <Tooltip>
                <TooltipTrigger asChild>
                    <span
                        tabIndex={0}
                        className="inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[0.75rem] text-muted-foreground ring-1 ring-inset ring-border line-through decoration-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    >
                        <span className="truncate">{username}</span>
                        <span className="sr-only">{t("keys.matrix.notChosen")}</span>
                    </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-xs">{t("keys.matrix.notChosenTip", { account: username })}</TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}

/** 一把金鑰在一台裝置上的所有帳號；沒有帳號時說明原因。`unchosen` = 金鑰刻意沒選的帳號。
 *  All accounts of a key on a device; `unchosen` = accounts the key was deliberately not chosen for. */
export function TargetChips({ targets, online, className, unchosen = [] }: { targets: KeyTarget[]; online: boolean; className?: string; unchosen?: string[] }) {
    const { t } = useI18n();
    if (targets.length === 0 && unchosen.length === 0) {
        return <span className={cn("text-[0.75rem] text-muted-foreground", className)}>{t("keys.status.noAccounts")}</span>;
    }
    return (
        <div className={cn("flex flex-wrap gap-1", className)}>
            {targets.map((tg) => (
                <TargetChip key={tg.username} target={tg} online={online} />
            ))}
            {unchosen.map((u) => (
                <UnchosenChip key={`u:${u}`} username={u} />
            ))}
        </div>
    );
}
