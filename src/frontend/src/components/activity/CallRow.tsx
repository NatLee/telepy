"use client";

/**
 * AI 活動紀錄的一列（AI 活動頁與「管理使用者」的活動分頁共用）：時間、工具、帳號@隧道、誰 · 哪個 app · IP、結果，
 * 下面是收合的指令 / 路徑與錯誤。
 * One row of the AI activity log (shared by the AI activity page and the Manage-user dialog's activity tab):
 * time, tool, account@tunnel, who · app · IP, result, then the collapsed command / path and error.
 */
import React from "react";
import { Image as ImageIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ClampedText } from "@/components/ui/clamped-text";
import { Highlighted } from "@/components/ui/timeline";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { describeDetail, toolLabel } from "@/lib/aiAccess";
import { formatBytes, formatDuration, isCodeDetail, isWriteTool } from "@/lib/aiActivity";
import type { AiActivityEntry } from "@/hooks/useAiActivityPage";

export const linkButton = "max-w-full truncate text-left underline decoration-dotted underline-offset-4 hover:text-primary hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded-sm";

export function CallRow({
    r,
    query,
    showTunnelChip,
    onTunnel,
    onApp,
}: {
    r: AiActivityEntry;
    query: string;
    /** 看全部隧道時，隧道是可點的標籤（點了只看那條）。/ In the all-tunnels view the tunnel is a chip that filters to it. */
    showTunnelChip: boolean;
    onTunnel: (id: number) => void;
    /** 可以打開這個 app 的詳細資料時才有。/ Present only when this app's details may be opened. */
    onApp: (() => void) | null;
}) {
    const { t } = useI18n();
    const detail = describeDetail(r.tool, r.detail, t);
    const target = r.tunnel ? `${r.target_username ? `${r.target_username}@` : ""}${r.tunnel.name ?? `#${r.tunnel.id}`}` : null;
    const exitBad = r.exit_code !== null && r.exit_code !== undefined && r.exit_code !== 0;
    return (
        <li className="px-4 py-3 lg:px-5">
            {/* 一行摘要：時間、工具、帳號@隧道、誰 · 哪個 app · IP，結果靠右；窄的時候自動換行。
                One summary line: time, tool, account@tunnel, who · app · IP, result on the right; wraps when narrow. */}
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs leading-5">
                <time dateTime={r.at} title={r.full} className="font-mono tabular-nums text-muted-foreground">
                    {r.time}
                </time>
                <Badge variant={isWriteTool(r.tool) ? "default" : "outline"} className="text-[0.6875rem] leading-none py-0.5">
                    {toolLabel(r.tool, t)}
                </Badge>
                {target &&
                    (showTunnelChip && r.tunnel ? (
                        <button
                            type="button"
                            onClick={() => onTunnel(r.tunnel!.id)}
                            title={t("activity.onlyTunnel", { name: r.tunnel.name ?? `#${r.tunnel.id}` })}
                            className="inline-flex max-w-full items-center rounded-sm border border-border bg-muted px-1.5 font-mono text-[0.6875rem] leading-4 text-foreground/80 transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        >
                            <span className="truncate">{target}</span>
                        </button>
                    ) : (
                        <span className="min-w-0 truncate font-mono text-[0.6875rem] text-foreground/80">{target}</span>
                    ))}
                <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
                    <span className="truncate">{r.user.username ?? "—"}</span>
                    {r.client_name && (
                        <>
                            <span aria-hidden>·</span>
                            {onApp ? (
                                <button type="button" onClick={onApp} className={cn(linkButton, "decoration-muted-foreground/50")} title={t("apps.openDetails", { name: r.client_name })}>
                                    {r.client_name}
                                </button>
                            ) : (
                                <span className="truncate">{r.client_name}</span>
                            )}
                        </>
                    )}
                    {r.ip && (
                        <>
                            <span aria-hidden>·</span>
                            <span className="font-mono" title={t("activity.ipTitle")}>
                                {r.ip}
                            </span>
                        </>
                    )}
                </span>
                <span className="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums text-muted-foreground">
                    <span className={cn("size-1.5 rounded-full", r.ok ? "bg-success" : "bg-destructive")} aria-hidden />
                    <span className={r.ok ? "text-foreground" : "text-destructive"}>{r.ok ? t("activity.resultOk") : t("activity.resultFailed")}</span>
                    {r.exit_code !== null && r.exit_code !== undefined && <span className={exitBad ? "text-destructive" : undefined}>· {t("activity.exitCode", { code: r.exit_code })}</span>}
                    {r.duration_ms !== null && r.duration_ms !== undefined && <span>· {formatDuration(r.duration_ms)}</span>}
                    {r.bytes_out ? <span>· {formatBytes(r.bytes_out)}</span> : null}
                </span>
            </div>
            {r.tool === "browser_screenshot" ? (
                // 截圖本身不存，只說拍了一張。/ The image itself is never stored; just say one was taken.
                <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ImageIcon size={14} aria-hidden />
                    {t("activity.screenshotNote")}
                </p>
            ) : detail &&
                (isCodeDetail(r.tool) ? (
                    <ClampedText className="mt-1.5" text={detail} query={query} copy />
                ) : (
                    <p className="mt-1 text-xs leading-5 text-muted-foreground wrap-anywhere">
                        <Highlighted text={detail} query={query} />
                    </p>
                ))}
            {r.error && <ClampedText className="mt-1.5" tone="error" lines={2} text={r.error} query={query} />}
        </li>
    );
}
