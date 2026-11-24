"use client";

/**
 * 遠端瀏覽器面板的「這台裝置上」：裝置現在在聽的 port，網頁的一格一個、點了就開（還沒開瀏覽器 = 用它開始，
 * 開著 = 新分頁）；不是網頁的收在下面一行。上面一條小路徑說明為什麼網址是 localhost：瀏覽器 ─SSH─ 裝置的 localhost。
 * The remote browser panel's "On this device": the ports the device listens on right now. Web ones are tiles that open
 * on a click (a stopped browser starts on it, a running one opens a new tab); the rest fold into one line below. A
 * small path on top shows why the address is localhost: this browser ─SSH─ localhost on the device.
 */
import React, { useState } from "react";
import Link from "next/link";
import { ChevronDown, Cpu, Lock, MonitorPlay } from "lucide-react";
import { RefreshButton } from "@/components/ui/refresh-button";
import { useFeatures } from "@/hooks/useFeatures";
import { emptyKey, portHint, portName, splitPorts, type DevicePortsData } from "@/lib/devicePorts";
import { serviceName } from "@/lib/lanConnect";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface DevicePortsProps {
    serverId: number | string;
    username: string;
    data: DevicePortsData | null;
    loading: boolean;
    error: string | null;
    onRefresh: () => Promise<boolean>;
    onOpen: (url: string) => void;
    /** 瀏覽器已經開著：點了是開新分頁。/ The browser is running: a click opens a new tab. */
    running?: boolean;
    className?: string;
}

export function DevicePorts({ serverId, username, data, loading, error, onRefresh, onOpen, running = false, className }: DevicePortsProps) {
    const { t } = useI18n();
    const { has } = useFeatures();
    const [showOther, setShowOther] = useState(false);
    const { web, other } = splitPorts(data?.ports ?? []);
    const unnamed = !!data && !data.scanned && web.some((p) => p.web === "maybe");

    return (
        <section className={cn("@container rounded-lg border border-border bg-background/60", className)} aria-label={t("browser.ports.title")}>
            <header className="flex items-center gap-2 border-b border-border px-3 py-2">
                <h4 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{t("browser.ports.title")}</h4>
                <RefreshButton onRefresh={onRefresh} busy={loading} failed={!!error} variant="ghost" size="icon" className="h-7 w-7" iconSize={14} aria-label={t("browser.ports.refresh")} title={t("browser.ports.refresh")} />
            </header>

            {/* 為什麼是 localhost：瀏覽器 ─SSH─ 裝置。/ Why localhost: this browser ─SSH─ the device. */}
            <div className="flex items-center gap-2 px-3 pt-3 text-xs text-muted-foreground" aria-hidden="true">
                <span className="flex shrink-0 items-center gap-1.5 text-foreground">
                    <MonitorPlay size={14} className="text-muted-foreground" />
                    {t("browser.ports.pathBrowser")}
                </span>
                <span className="flex min-w-6 flex-1 items-center gap-2">
                    <span className="h-px flex-1 bg-border" />
                    <span className="hidden shrink-0 @sm:inline">{t("browser.ports.pathVia", { username })}</span>
                    <span className="hidden h-px flex-1 bg-border @sm:block" />
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-foreground">
                    <Cpu size={14} className="text-muted-foreground" />
                    {t("browser.ports.pathDevice")}
                </span>
            </div>
            <p className="px-3 pt-2 text-xs text-muted-foreground">{t(running ? "browser.ports.introTab" : "browser.ports.intro")}</p>

            <div className="p-3">
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                {!error && !data && <p role="status" className="text-sm text-muted-foreground">{t("browser.ports.loading")}</p>}
                {!error && data && data.ports.length === 0 && <p className="text-sm text-muted-foreground">{t(emptyKey(data))}</p>}

                {!error && web.length > 0 && (
                    <ul data-refresh-list className="grid grid-cols-1 gap-2 @sm:grid-cols-2 @2xl:grid-cols-3">
                        {web.map((p) => {
                            const name = portName(p, serviceName);
                            const hint = portHint(p);
                            return (
                                <li key={p.port}>
                                    <button
                                        type="button"
                                        onClick={() => p.url && onOpen(p.url)}
                                        title={t("browser.ports.open", { url: p.url ?? "" })}
                                        className="flex h-full w-full flex-col items-start gap-0.5 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:border-primary/60 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                        <span className="flex w-full items-center gap-1.5">
                                            <span className="font-mono text-sm text-foreground">:{p.port}</span>
                                            {p.scheme === "https" && <Lock size={12} className="shrink-0 text-muted-foreground" aria-label="HTTPS" />}
                                            {name && <span className="min-w-0 flex-1 truncate text-sm text-foreground">{name}</span>}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {hint && <span className={p.web === "seen" ? "text-success" : undefined}>{t(hint)}</span>}
                                            {p.loopback_only && <span>{hint ? " · " : ""}{t("browser.ports.loopback")}</span>}
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}

                {!error && unnamed && (
                    <p className="mt-2 text-xs text-muted-foreground">
                        {t("browser.ports.scanHint")}{" "}
                        {has("network") && (
                            <Link href={`/tunnels/network?tunnel=${serverId}`} className="underline underline-offset-2 hover:text-foreground">
                                {t("browser.ports.scanLink")}
                            </Link>
                        )}
                    </p>
                )}

                {!error && other.length > 0 && (
                    <div className={web.length > 0 ? "mt-3" : undefined}>
                        <button
                            type="button"
                            onClick={() => setShowOther((v) => !v)}
                            aria-expanded={showOther}
                            className="flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <ChevronDown size={14} className={cn("transition-transform", !showOther && "-rotate-90")} />
                            {t("browser.ports.other", { count: other.length })}
                        </button>
                        {showOther && (
                            <div className="mt-1.5 space-y-1.5 pl-5">
                                <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                    {other.map((p) => (
                                        <li key={p.port}>
                                            <span className="font-mono text-foreground">:{p.port}</span>
                                            {portName(p, serviceName) && <span> {portName(p, serviceName)}</span>}
                                        </li>
                                    ))}
                                </ul>
                                <p className="text-xs text-muted-foreground">{t("browser.ports.otherHint")}</p>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </section>
    );
}
