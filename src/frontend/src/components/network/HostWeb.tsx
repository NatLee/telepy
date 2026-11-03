"use client";

/**
 * 主機面板的「網頁」：這台主機開著的每個網頁 port 一列，加一列自己打的（`8080/admin`、完整網址）。跟終端機一樣兩種開法：
 * 「在這裡開」= 本頁 dock 裡的遠端瀏覽器（同一台裝置再開的網頁是它裡面的新分頁）、「瀏覽器頁 ↗」= 終端機頁的瀏覽器
 * 畫面（Ctrl/⌘ 點開新分頁）。兩種都是 Telepy 的 Chromium，連線從裝置出去；想用自己的瀏覽器就看「指令」分頁的
 * `telepy forward`。說明按鈕打開兩條路的對照圖。
 * The host panel's web pages: one row per open web port plus one you type (`8080/admin`, a full URL). Two ways to
 * open, like terminals: "Open here" = the remote browser in this page's dock (more pages on the same device open as
 * tabs in it) and "Browser page ↗" = the terminal page's browser view (Ctrl/⌘-click for a new tab). Both are Telepy's
 * Chromium, going out through the device; your own browser is `telepy forward` on the Commands tab. The info button
 * compares the two ways.
 */
import React, { useState } from "react";
import Link from "next/link";
import { ExternalLink, Globe, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Section } from "@/components/ui/section";
import { LanWebInfoDialog } from "@/components/network/LanWebInfo";
import { useFeatures } from "@/hooks/useFeatures";
import { useI18n } from "@/lib/i18n";
import { getTerminalPageUrl } from "@/lib/tunnelUrls";
import { parseWebInput, shortUrl, webLinks, type WebInputError } from "@/lib/lanWeb";
import { serviceName } from "@/lib/lanConnect";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import type { LanHost, TopologyTunnel } from "@/types/lan";

const INPUT_ERROR: Record<WebInputError, TranslationKey> = {
    empty: "network.web.errEmpty",
    scheme: "network.web.errScheme",
    port: "network.web.errPort",
    host: "network.web.errHost",
};

/** 遠端瀏覽器頁的網址（終端機頁的瀏覽器畫面，一開就到那個網頁）。/ The browser page URL, opening on that page. */
export function lanWebPageUrl(tn: Pick<TopologyTunnel, "id" | "reverse_port">, url: string, deviceUser: string | null): string {
    return getTerminalPageUrl(tn, { mainView: "browser", browserUrl: url, account: deviceUser ?? undefined });
}

/** 一對按鈕：在這裡開（dock）+ 瀏覽器頁 ↗。/ The pair: open here (the dock) + browser page ↗. */
export function WebOpenPair({ url, tunnel, deviceUser, disabled, reason, onOpenHere, onNavigate, size = "default" }: {
    url: string;
    tunnel: TopologyTunnel;
    deviceUser: string | null;
    disabled: boolean;
    reason?: string;
    onOpenHere: (url: string) => void;
    onNavigate?: () => void;
    size?: "default" | "sm";
}) {
    const { t } = useI18n();
    return (
        <div className="inline-flex shrink-0" role="group" aria-label={t("network.web.group")}>
            <Button type="button" size={size} onClick={() => onOpenHere(url)} disabled={disabled} title={reason ?? t("network.web.hereHint")} className="rounded-r-none">
                <Globe size={15} /> {t("network.open.here")}
            </Button>
            {disabled ? (
                <Button type="button" size={size} variant="outline" disabled title={reason} className="-ml-px rounded-l-none" aria-label={t("network.web.page")}>
                    <ExternalLink size={14} />
                </Button>
            ) : (
                <Button size={size} variant="outline" asChild className="-ml-px rounded-l-none">
                    <Link href={lanWebPageUrl(tunnel, url, deviceUser)} prefetch={false} target="_blank" rel="noopener" onClick={onNavigate} title={t("network.web.pageHint")} aria-label={t("network.web.page")}>
                        <ExternalLink size={14} />
                    </Link>
                </Button>
            )}
        </div>
    );
}

export function HostWeb({ host, tunnel, online, deviceUser, first = false, onOpenWeb, onNavigate, onShowCommands }: {
    host: LanHost;
    /** 排在面板最上面（不用上面的分隔線）。/ Shown first in the panel (no divider above). */
    first?: boolean;
    tunnel: TopologyTunnel;
    online: boolean;
    deviceUser: string | null;
    onOpenWeb: (url: string) => void;
    onNavigate?: () => void;
    /** 換到「指令」分頁（自己的瀏覽器）。/ Switch to the Commands tab (your own browser). */
    onShowCommands: () => void;
}) {
    const { t } = useI18n();
    const { has } = useFeatures();
    const [other, setOther] = useState("");
    const [tried, setTried] = useState(false);
    const [infoOpen, setInfoOpen] = useState(false);
    const links = webLinks(host);
    const parsed = parseWebInput(host.address, other);
    const otherError = "error" in parsed && (tried || parsed.error !== "empty") ? t(INPUT_ERROR[parsed.error]) : null;
    const reason = !has("remote_browser")
        ? t("network.web.featureOff")
        : !online
            ? t("network.deviceOffline")
            : !deviceUser
                ? t("network.noDeviceUser")
                : undefined;
    const openOther = () => {
        setTried(true);
        if ("url" in parsed) onOpenWeb(parsed.url);
    };

    return (
        <Section
            wrapTitle
            title={t("network.web.title")}
            action={
                <Button variant="ghost" size="sm" onClick={() => setInfoOpen(true)} title={t("network.web.howTitle")} aria-label={t("network.web.howTitle")} className="px-2">
                    <Info size={15} /> <span className="hidden @md:inline">{t("network.web.how")}</span>
                </Button>
            }
            className={first ? undefined : "border-t border-border pt-5"}
        >
            <div className="space-y-3">
                {/* 說明放在內容裡：放標題旁邊會被說明按鈕擠成窄窄一欄。/ In the body: beside the title the info button squeezed it into a narrow column. */}
                <p className="text-sm text-muted-foreground">{t("network.web.desc", { device: tunnel.name })}</p>
                {links.length > 0 ? (
                    <ul className="divide-y divide-border rounded-lg border border-border">
                        {links.map((l) => (
                            <li key={l.port} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2">
                                <span className="min-w-0">
                                    <span className="block font-mono text-sm text-foreground [overflow-wrap:anywhere]">{shortUrl(l.url)}</span>
                                    <span className="text-xs text-muted-foreground">{serviceName(l.port) ?? l.scheme.toUpperCase()} · {l.scheme === "https" ? t("network.web.https") : t("network.web.http")}</span>
                                </span>
                                <WebOpenPair url={l.url} tunnel={tunnel} deviceUser={deviceUser} disabled={!!reason} reason={reason} onOpenHere={onOpenWeb} onNavigate={onNavigate} size="sm" />
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-sm text-muted-foreground">{host.last_seen ? t("network.web.noneSeen") : t("network.web.noneKnown")}</p>
                )}

                <form
                    className="space-y-1.5"
                    onSubmit={(e) => {
                        e.preventDefault();
                        openOther();
                    }}
                >
                    <label htmlFor={`lan-web-${host.id}`} className="text-sm text-foreground">{t("network.web.other")}</label>
                    <div className="flex flex-wrap items-start gap-2">
                        <Input
                            id={`lan-web-${host.id}`}
                            value={other}
                            onChange={(e) => setOther(e.target.value)}
                            placeholder="8080/admin"
                            autoComplete="off"
                            spellCheck={false}
                            aria-invalid={!!otherError}
                            className="min-w-[10rem] flex-1 font-mono"
                        />
                        {"url" in parsed ? (
                            <WebOpenPair url={parsed.url} tunnel={tunnel} deviceUser={deviceUser} disabled={!!reason} reason={reason} onOpenHere={onOpenWeb} onNavigate={onNavigate} />
                        ) : (
                            <Button type="submit" disabled={!!reason} title={reason}>
                                <Globe size={15} /> {t("network.open.here")}
                            </Button>
                        )}
                    </div>
                    <p className={cn("text-xs", otherError ? "text-destructive" : "text-muted-foreground")}>
                        {otherError ?? ("url" in parsed ? t("network.web.willOpen", { url: parsed.url }) : t("network.web.otherHint", { address: host.address }))}
                    </p>
                </form>

                <p className="text-xs text-muted-foreground">
                    {t("network.web.explain")}{" "}
                    <button type="button" onClick={onShowCommands} className="text-primary hover:underline">{t("network.web.ownBrowser")}</button>
                </p>
            </div>
            <LanWebInfoDialog isOpen={infoOpen} onClose={() => setInfoOpen(false)} host={host} tunnel={tunnel} online={online} deviceUser={deviceUser} />
        </Section>
    );
}
