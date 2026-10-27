/**
 * 「金鑰去哪」的流程圖：你的金鑰 → 裝置的清單 → [允許的帳號 ∩ 選定的帳號] → 每個帳號的金鑰檔
 * （`~/.ssh/authorized_keys`；Windows 管理員是共用的 administrators_authorized_keys）。
 * 直線與直角（CSS hairline），桌面橫排、手機直排；由 `lib/keyPlacement` 的純函式驅動：金鑰頁說明用例子，
 * 裝置面板用真實狀態（選哪把金鑰、哪台裝置）。
 * The "where a key goes" flow: your key → the device's list → [allowed ∩ chosen] → each account's key file.
 * Straight lines and right angles only (CSS hairlines), a row from `sm`, a column on phones. Driven by the
 * pure helper: the keys page shows an example, the device panel the real state.
 */
import React from "react";
import { FileKey2, Filter, KeyRound, ListChecks, ShieldCheck } from "lucide-react";
import { Chip } from "@/components/ui/section";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { summarizePlacement, type Placement } from "@/lib/keyPlacement";

/** 節點：圖示 + 標題 + 內容。/ A node tile. */
function Node({ icon: Icon, title, children, className, active = true }: { icon: React.ComponentType<{ size?: number; className?: string }>; title: string; children?: React.ReactNode; className?: string; active?: boolean }) {
    return (
        <div className={cn("flex min-w-0 flex-col gap-1.5 rounded-xl bg-card p-2.5 ring-1 ring-border", !active && "opacity-60", className)}>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Icon size={13} className="shrink-0 text-primary" aria-hidden />
                <span className="truncate">{title}</span>
            </div>
            {children}
        </div>
    );
}

/** 節點之間的直線：桌面橫線、手機直線。/ The link between nodes: horizontal from `sm`, vertical on phones. */
function Link({ tone = "neutral" }: { tone?: "neutral" | "success" }) {
    return (
        <span
            className={cn("block h-4 w-px shrink-0 self-center sm:h-px sm:w-5", tone === "success" ? "bg-success" : "bg-border")}
            aria-hidden
        />
    );
}

const STATE_TONE: Record<Placement["state"], "success" | "warning" | "neutral"> = { placed: "success", unchosen: "warning", notAllowed: "neutral" };

/** 一個帳號的檔案列：帳號名 + 檔名 + 狀態。/ One account's file row. */
function FileRow({ p, keyLabel }: { p: Placement; keyLabel: string }) {
    const { t } = useI18n();
    const stateKey = p.state === "unchosen" ? "keys.place.unchosen" : "keys.place.notAllowed";
    return (
        <li className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-surface px-2 py-1.5 ring-1 ring-inset", p.state === "placed" ? "ring-success/40" : "ring-border")}>
            <span className={cn("font-mono text-xs", p.state === "placed" ? "text-foreground" : "text-muted-foreground")}>{p.account.username}</span>
            <span className="min-w-0 truncate font-mono text-[0.75rem] text-muted-foreground" title={p.account.file}>
                {p.account.file}
            </span>
            {p.account.windowsAdmin && (
                <TooltipProvider delayDuration={150}>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span tabIndex={0} className="inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
                                <Chip tone="neutral">
                                    <ShieldCheck aria-hidden /> {t("keys.place.adminFile")}
                                </Chip>
                            </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs text-xs">{t("keys.place.adminFileTip")}</TooltipContent>
                    </Tooltip>
                </TooltipProvider>
            )}
            <Chip tone={STATE_TONE[p.state]} className="ml-auto">
                {p.state === "placed" && <KeyRound aria-hidden />}
                {p.state === "placed" ? keyLabel : t(stateKey)}
            </Chip>
        </li>
    );
}

export function KeyPlacementFlow({
    keyLabel,
    listLabel,
    placements,
    note,
    className,
}: {
    /** 金鑰名。/ The key's name. */
    keyLabel: string;
    /** 裝置名（清單節點）。/ The device (list node). */
    listLabel: string;
    placements: Placement[];
    /** 圖下的一句話（例子說明 / 摘要）。/ One line under the diagram. */
    note?: React.ReactNode;
    className?: string;
}) {
    const { t } = useI18n();
    const s = summarizePlacement(placements);
    const allowed = placements.filter((p) => p.allowed);
    const chosen = allowed.filter((p) => p.chosen);
    return (
        <div className={className}>
            <div className="flex flex-col sm:flex-row sm:items-stretch" role="img" aria-label={t("keys.place.aria", { key: keyLabel, device: listLabel })}>
                <Node icon={KeyRound} title={t("keys.place.myKey")} className="sm:w-[9rem]">
                    <span className="truncate font-mono text-sm text-foreground" title={keyLabel}>{keyLabel}</span>
                </Node>
                <Link tone="success" />
                <Node icon={ListChecks} title={t("keys.place.list")} className="sm:w-[10rem]">
                    <span className="truncate font-mono text-sm text-foreground" title={listLabel}>{listLabel}</span>
                    <span className="text-[0.75rem] leading-snug text-muted-foreground">{t("keys.place.listNote")}</span>
                </Node>
                <Link tone="success" />
                <Node icon={Filter} title={t("keys.place.filter")} className="sm:w-[12rem]">
                    <span className="text-[0.75rem] leading-snug text-muted-foreground">{t("keys.place.filterNote", { allowed: allowed.length, chosen: chosen.length })}</span>
                    <span className="flex flex-wrap gap-1">
                        {chosen.length === 0 ? (
                            <Chip tone="warning">{t("keys.place.none")}</Chip>
                        ) : (
                            chosen.map((p) => (
                                <Chip key={p.account.username} tone="success" mono>
                                    {p.account.username}
                                </Chip>
                            ))
                        )}
                    </span>
                </Node>
                <Link tone={s.placed > 0 ? "success" : "neutral"} />
                <Node icon={FileKey2} title={t("keys.place.files")} className="min-w-0 flex-1" active>
                    {placements.length === 0 ? (
                        <span className="text-[0.75rem] text-muted-foreground">{t("keys.status.noAccounts")}</span>
                    ) : (
                        <ul className="flex flex-col gap-1">
                            {placements.map((p) => (
                                <FileRow key={p.account.username} p={p} keyLabel={keyLabel} />
                            ))}
                        </ul>
                    )}
                </Node>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {note ?? (s.placed === 0 ? t("keys.place.summaryNone") : t("keys.place.summary", { placed: s.placed, total: placements.length, files: s.files.length }))}
            </p>
        </div>
    );
}

/** 給其他流程圖（金鑰群組）共用的節點與直線。/ The node and link, shared with the key group flow. */
export { Node as FlowNode, Link as FlowLink };
