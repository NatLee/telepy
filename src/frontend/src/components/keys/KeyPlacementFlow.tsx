/**
 * 「金鑰去哪」的流程圖：你的金鑰 → 裝置的清單 → [允許的帳號 ∩ 選定的帳號] → 每個帳號的金鑰檔
 * （`~/.ssh/authorized_keys`；Windows 管理員是共用的 administrators_authorized_keys）。
 * 直線與直角（帶箭頭的細線），容器夠寬（@3xl）時橫排、頂端對齊，連線接在節點標題那一行；窄的時候直排。
 * 文字一律換行、不截斷（路徑在任何字元都能斷）。由 `lib/keyPlacement` 的純函式驅動：金鑰頁說明用例子，
 * 裝置面板用真實狀態（選哪把金鑰、哪台裝置）。
 * The "where a key goes" flow: your key → the device's list → [allowed ∩ chosen] → each account's key file.
 * Straight arrowed hairlines; a top-aligned row in a wide container (@3xl, links level with the node titles),
 * a column otherwise. Text wraps instead of truncating (paths break anywhere). Driven by the pure helper: the
 * keys page shows an example, the device panel the real state.
 */
import React from "react";
import { FileKey2, Filter, KeyRound, ListChecks, ShieldCheck } from "lucide-react";
import { Chip } from "@/components/ui/section";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { summarizePlacement, type Placement } from "@/lib/keyPlacement";

/** 一排節點：寬容器橫排（頂端對齊），窄容器直排。/ The row of nodes: a top-aligned row from @3xl, a column below. */
function Row({ label, stretch = false, children }: { label: string; stretch?: boolean; children: React.ReactNode }) {
    return (
        <div className="@container">
            <div className={cn("flex flex-col @3xl:flex-row", stretch ? "@3xl:items-stretch" : "@3xl:items-start")} role="img" aria-label={label}>
                {children}
            </div>
        </div>
    );
}

/** 節點：圖示 + 標題 + 內容。標題換行不截斷。/ A node tile; the title wraps instead of truncating. */
function Node({ icon: Icon, title, children, className, active = true }: { icon: React.ComponentType<{ size?: number; className?: string }>; title: string; children?: React.ReactNode; className?: string; active?: boolean }) {
    return (
        <div className={cn("flex min-w-0 flex-col gap-1.5 rounded-xl bg-card p-2.5 ring-1 ring-border", !active && "opacity-60", className)}>
            <div className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
                <span className="grid h-[1.125rem] shrink-0 place-items-center" aria-hidden>
                    <Icon size={13} className="text-primary" />
                </span>
                <span className="min-w-0 [overflow-wrap:anywhere]">{title}</span>
            </div>
            {children}
        </div>
    );
}

/**
 * 節點之間帶箭頭的直線：窄容器是往下的短線，寬容器是往右的短線，高度對齊節點標題那一行
 * （預設對齊 `Node`；別的節點用 `className` 調 `@3xl:mt-*`）。
 * The arrowed link between nodes: down in a column, right in a row, level with the node titles (defaults to
 * `Node`; other tiles pass their own `@3xl:mt-*`).
 */
function Link({ tone = "neutral", className }: { tone?: "neutral" | "success"; className?: string }) {
    const color = tone === "success" ? "text-success" : "text-muted-foreground/50";
    return (
        <span className={cn("flex shrink-0 justify-center self-center @3xl:mt-[0.9375rem] @3xl:self-start", color, className)} aria-hidden>
            <svg className="h-5 w-2 @3xl:hidden" viewBox="0 0 8 20" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 1v17M1.5 15.5 4 18l2.5-2.5" vectorEffect="non-scaling-stroke" />
            </svg>
            <svg className="hidden h-2 w-6 @3xl:block" viewBox="0 0 24 8" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 4h21M19.5 1.5 22 4l-2.5 2.5" vectorEffect="non-scaling-stroke" />
            </svg>
        </span>
    );
}

const STATE_TONE: Record<Placement["state"], "success" | "warning" | "neutral"> = { placed: "success", unchosen: "warning", notAllowed: "neutral" };

/** 一個帳號的檔案：第一行帳號 + 狀態，第二行檔案路徑（任何字元都能斷行）。/ One account's file: name + state, then the path. */
function FileRow({ p, keyLabel }: { p: Placement; keyLabel: string }) {
    const { t } = useI18n();
    const stateKey = p.state === "unchosen" ? "keys.place.unchosen" : "keys.place.notAllowed";
    return (
        <li className={cn("flex min-w-0 flex-col gap-1 rounded-lg bg-surface px-2 py-1.5 ring-1 ring-inset", p.state === "placed" ? "ring-success/40" : "ring-border")}>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className={cn("min-w-0 font-mono text-xs [overflow-wrap:anywhere]", p.state === "placed" ? "text-foreground" : "text-muted-foreground")}>{p.account.username}</span>
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
                            <TooltipContent className="max-w-xs text-xs [overflow-wrap:anywhere]">{t("keys.place.adminFileTip")}</TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                )}
                <Chip tone={STATE_TONE[p.state]} className="ml-auto max-w-full whitespace-normal">
                    {p.state === "placed" && <KeyRound aria-hidden />}
                    <span className="min-w-0 [overflow-wrap:anywhere]">{p.state === "placed" ? keyLabel : t(stateKey)}</span>
                </Chip>
            </div>
            <span className="font-mono text-[0.75rem] leading-snug text-muted-foreground [overflow-wrap:anywhere]">{p.account.file}</span>
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
            <Row label={t("keys.place.aria", { key: keyLabel, device: listLabel })}>
                <Node icon={KeyRound} title={t("keys.place.myKey")} className="@3xl:w-[8rem] @3xl:shrink-0">
                    <span className="font-mono text-sm text-foreground [overflow-wrap:anywhere]">{keyLabel}</span>
                </Node>
                <Link tone="success" />
                <Node icon={ListChecks} title={t("keys.place.list")} className="@3xl:w-[11rem] @3xl:shrink-0">
                    <span className="font-mono text-sm text-foreground [overflow-wrap:anywhere]">{listLabel}</span>
                    <span className="text-[0.75rem] leading-snug text-muted-foreground">{t("keys.place.listNote")}</span>
                </Node>
                <Link tone="success" />
                <Node icon={Filter} title={t("keys.place.filter")} className="@3xl:w-[12rem] @3xl:shrink-0">
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
                <Node icon={FileKey2} title={t("keys.place.files")} className="@3xl:flex-1">
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
            </Row>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {note ?? (s.placed === 0 ? t("keys.place.summaryNone") : t("keys.place.summary", { placed: s.placed, total: placements.length, files: s.files.length }))}
            </p>
        </div>
    );
}

/** 給其他流程圖（金鑰群組、說明的總覽）共用的排、節點與直線。/ Row, node and link, shared with the key group flow and the explainer. */
export { Row as FlowRow, Node as FlowNode, Link as FlowLink };
