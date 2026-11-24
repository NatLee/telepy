"use client";

/**
 * 伺服器分頁「位址」那一組上面的圖：這台伺服器有三個讓人連進來的位址，各給不同的東西用——網頁位址（瀏覽器、API、MCP、
 * CLI）、SSH 位址（裝置的通道、筆電的 ssh）、代理位址（把通道當代理的程式）。三條畫在一起，才看得出它們的差別：哪一個
 * 可以放在 CDN 後面、哪一個沒設時會退回哪裡。每一條顯示現在實際生效的值（.env > 這頁 > 預設）。
 * The diagram above the Server tab's "Addresses" group: this server has three addresses people connect to, each for
 * something else — the web address (browsers, the API, MCP, the CLI), the SSH address (devices' tunnels, laptops'
 * ssh) and the proxy address (programs using a tunnel as a proxy). Drawn together so the differences show: which may
 * sit behind a CDN, and what each falls back to when unset. Each lane shows the value in force (.env > this page > default).
 */
import React from "react";
import { ArrowLeftRight, Globe, TerminalSquare, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { addressLanes, type AddressLane } from "@/lib/serverAddresses";
import type { EnvMap } from "@/lib/settingSource";
import { cn } from "@/lib/utils";

const ICON: Record<AddressLane["id"], LucideIcon> = { web: Globe, ssh: TerminalSquare, proxy: ArrowLeftRight };

export function ServerAddresses({ values, env }: { values: Record<string, unknown>; env: EnvMap }) {
    const { t } = useI18n();
    const lanes = addressLanes(values, env, typeof window === "undefined" ? "" : window.location.origin);
    return (
        // 三欄與否看這一塊自己的寬度：旁邊有分頁欄時內容區比視窗窄很多。/ Three columns or not by this block's own width: beside the tab rail it is far narrower than the viewport.
        <div className="@container">
        <ol className="grid gap-3 @3xl:grid-cols-3" aria-label={t("settingsEnv.addr.aria")}>
            {lanes.map((lane) => {
                const Icon = ICON[lane.id];
                return (
                    <li key={lane.id} className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-card p-3">
                        <div className="flex items-center gap-2">
                            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-foreground" aria-hidden>
                                <Icon size={16} />
                            </span>
                            <span className="min-w-0 text-sm text-foreground">{t(`settingsEnv.addr.${lane.id}`)}</span>
                        </div>
                        <p className="text-xs leading-relaxed text-muted-foreground">{t(`settingsEnv.addr.${lane.id}Who`)}</p>
                        {/* 現在生效的值；沒設時說它退回哪裡。/ The value in force; when unset, what it falls back to. */}
                        <div className={cn("rounded-md px-2 py-1.5", lane.set ? "bg-muted/70" : "border border-dashed border-border")}>
                            <code className={cn("block font-mono text-xs [overflow-wrap:anywhere]", lane.set ? "text-foreground" : "text-muted-foreground")}>{lane.value || t(`settingsEnv.addr.${lane.id}Unset`)}</code>
                            {!lane.set && lane.value && <span className="mt-0.5 block text-xs text-muted-foreground">{t(`settingsEnv.addr.${lane.id}Unset`)}</span>}
                        </div>
                        <p className="mt-auto flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
                            <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", lane.cdn ? "bg-success" : "bg-warning")} aria-hidden />
                            {t(lane.id === "proxy" && !lane.set ? "settingsEnv.addr.proxyCdnUnset" : `settingsEnv.addr.${lane.id}Cdn`)}
                        </p>
                    </li>
                );
            })}
        </ol>
        </div>
    );
}
