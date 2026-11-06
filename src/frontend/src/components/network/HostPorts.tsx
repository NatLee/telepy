"use client";

/**
 * 主機面板「這台機器上的服務」：每個開著的 port 一列（名字用掃描看到的網頁標題 / banner，再來是常見服務名），配它最直接的用法——
 * SSH = 終端機（在這裡開 / 終端機頁 ↗，用下面的登入設定）、RDP / VNC / RustDesk = 遠端桌面頁（帶協定與 port）、網頁 = 遠端
 * 瀏覽器（在這裡開 = 本頁 dock、↗ = 瀏覽器頁）、其他 = `telepy forward` 開到你電腦上（點了才展開指令）。最後一列可以自己打
 * 「其他網頁」（`8080/admin`、完整網址）。說明按鈕打開網頁兩條路的對照圖。
 * The host panel's "services on this machine": one row per open port (named by the page title / banner the scan saw,
 * then the usual service name) with its most direct use — SSH = a terminal (here / terminal page ↗, with the login
 * settings below), RDP / VNC / RustDesk = the remote desktop page (protocol and port filled in), a web page = the remote
 * browser (here = this page's dock, ↗ = the browser page), anything else = `telepy forward` to your computer (the command
 * unfolds on click). The last row takes "another page" (`8080/admin`, a full URL). The info button compares the two
 * ways to a web page.
 */
import React, { useState } from "react";
import Link from "next/link";
import { ArrowDownToLine, ExternalLink, FolderOpen, Globe, Info, ScreenShare, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Section } from "@/components/ui/section";
import { LanWebInfoDialog } from "@/components/network/LanWebInfo";
import { useFeatures } from "@/hooks/useFeatures";
import { useI18n } from "@/lib/i18n";
import { getTerminalPageUrl } from "@/lib/tunnelUrls";
import { forwardCommand, parseWebInput, shortUrl, type WebInputError } from "@/lib/lanWeb";
import { serviceName } from "@/lib/lanConnect";
import { desktopUrl, portRows, type PortRow } from "@/lib/lanPorts";
import { isOwn } from "@/lib/lanChanges";
import { CopyButton } from "@/components/ui/CopyButton";
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

/** SSH 那一列的動作（跟下面的大按鈕同一組設定）。/ The SSH row's actions (the same settings as the big buttons below). */
export interface TerminalRowAction {
    onOpenHere: () => void;
    href: string;
    /** 不能開的原因（沒有帳號、離線、登入名不對）。/ Why it can't open. */
    reason?: string;
    /** dock 裡有開著的終端機時「終端機頁」開新分頁。/ Open terminals make "Terminal page" open a new tab. */
    newTab: boolean;
    onNavigate?: () => void;
    /** 這台主機的檔案（同一組登入設定）；沒有 = 不能用（功能關了）。/ The host's files (same login settings); absent = not available. */
    onFiles?: () => void;
}

const DESKTOP_LABEL: Record<string, string> = { rdp: "RDP", vnc: "VNC", rustdesk: "RustDesk" };

export function HostPorts({ host, tunnel, online, deviceUser, terminal, onOpenWeb, onNavigate, onShowCommands }: {
    host: LanHost;
    tunnel: TopologyTunnel;
    online: boolean;
    deviceUser: string | null;
    terminal: TerminalRowAction;
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
    const [unfolded, setUnfolded] = useState<number | null>(null);
    // 裝置自己：SSH = 裝置的終端機頁、桌面 = 裝置本身（不經區網那一跳）。/ The device itself: SSH = its terminal page, desktop = the device.
    const own = isOwn(host);
    const rows = portRows(host, serviceName);
    const parsed = parseWebInput(host.address, other);
    const otherError = "error" in parsed && (tried || parsed.error !== "empty") ? t(INPUT_ERROR[parsed.error]) : null;
    const webReason = !has("remote_browser")
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

    const action = (r: PortRow) => {
        switch (r.action.kind) {
            case "ssh":
                if (own) {
                    return (
                        <Button size="sm" variant="outline" asChild>
                            <Link href={getTerminalPageUrl(tunnel, { account: deviceUser ?? undefined })} prefetch={false} onClick={onNavigate} title={t("network.own.terminalHint")} {...(terminal.newTab ? { target: "_blank", rel: "noopener" } : {})}>
                                <Terminal size={15} /> {t("network.own.terminal")} <ExternalLink size={13} className="text-muted-foreground" />
                            </Link>
                        </Button>
                    );
                }
                return (
                    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                    {terminal.onFiles && (
                        <Button type="button" size="sm" variant="outline" onClick={terminal.onFiles} disabled={!!terminal.reason} title={terminal.reason ?? t("lanFiles.openHint")}>
                            <FolderOpen size={15} /> {t("lanFiles.open")}
                        </Button>
                    )}
                    <div className="inline-flex shrink-0" role="group" aria-label={t("network.open.group")}>
                        <Button type="button" size="sm" onClick={terminal.onOpenHere} disabled={!!terminal.reason} title={terminal.reason ?? t("network.open.hereHint")} className="rounded-r-none">
                            <Terminal size={15} /> {t("network.open.here")}
                        </Button>
                        {terminal.reason ? (
                            <Button type="button" size="sm" variant="outline" disabled title={terminal.reason} className="-ml-px rounded-l-none" aria-label={t("network.open.page")}>
                                <ExternalLink size={14} />
                            </Button>
                        ) : (
                            <Button size="sm" variant="outline" asChild className="-ml-px rounded-l-none">
                                <Link href={terminal.href} prefetch={false} onClick={terminal.onNavigate} title={t("network.open.pageHint")} aria-label={t("network.open.page")} {...(terminal.newTab ? { target: "_blank", rel: "noopener" } : {})}>
                                    <ExternalLink size={14} />
                                </Link>
                            </Button>
                        )}
                    </div>
                    </div>
                );
            case "desktop":
                return has("remote_desktop") ? (
                    <Button size="sm" variant="outline" asChild>
                        <Link href={desktopUrl(tunnel.id, own ? null : host.id, r.action.protocol, r.port, deviceUser)} prefetch={false} onClick={onNavigate} title={t("network.ports.desktopHint")}>
                            <ScreenShare size={15} /> {t("network.ports.desktop")}
                        </Link>
                    </Button>
                ) : null;
            case "web":
                return <WebOpenPair url={r.action.link.url} tunnel={tunnel} deviceUser={deviceUser} disabled={!!webReason} reason={webReason} onOpenHere={onOpenWeb} onNavigate={onNavigate} size="sm" />;
            default:
                return (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setUnfolded((p) => (p === r.port ? null : r.port))} aria-expanded={unfolded === r.port}>
                        <ArrowDownToLine size={15} /> {t("network.ports.forward")}
                    </Button>
                );
        }
    };

    return (
        <Section
            wrapTitle
            title={own ? t("network.own.portsTitle") : t("network.ports.title")}
            description={own ? t("network.own.portsHint", { device: tunnel.name }) : undefined}
            action={
                <Button variant="ghost" size="sm" onClick={() => setInfoOpen(true)} title={t("network.web.howTitle")} aria-label={t("network.web.howTitle")} className="px-2">
                    <Info size={15} /> <span className="hidden @md:inline">{t("network.web.how")}</span>
                </Button>
            }
        >
            <div className="space-y-3">
                {rows.length > 0 ? (
                    <ul className="divide-y divide-border rounded-lg border border-border">
                        {rows.map((r) => (
                            <li key={r.port} className="px-3 py-2">
                                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                                    <span className="min-w-[8rem] flex-[1_1_8rem]">
                                        <span className="flex flex-wrap items-baseline gap-x-2">
                                            <span className="font-mono text-sm text-foreground">{r.port}</span>
                                            {r.name && <span className="text-sm text-foreground [overflow-wrap:anywhere]">{r.name}</span>}
                                        </span>
                                        <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">
                                            {r.action.kind === "web" ? shortUrl(r.action.link.url) : r.action.kind === "desktop" && r.name !== DESKTOP_LABEL[r.action.protocol] ? DESKTOP_LABEL[r.action.protocol] : null}
                                            {r.detail && <>{(r.action.kind === "web" || (r.action.kind === "desktop" && r.name !== DESKTOP_LABEL[r.action.protocol])) && " · "}{r.detail}</>}
                                        </span>
                                    </span>
                                    {action(r)}
                                </div>
                                {r.action.kind === "forward" && unfolded === r.port && (
                                    <div className="mt-2 flex items-center gap-1.5 rounded-md bg-surface px-2 py-1.5">
                                        <code className="min-w-0 flex-1 font-mono text-xs text-foreground/85 [overflow-wrap:anywhere]">{forwardCommand(tunnel.name, deviceUser, host.address, r.port)}</code>
                                        <CopyButton value={forwardCommand(tunnel.name, deviceUser, host.address, r.port)} className="size-7" />
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-sm text-muted-foreground">{own ? t("network.own.none") : host.last_seen ? t("network.ports.noneSeen") : t("network.ports.noneKnown")}</p>
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
                            <WebOpenPair url={parsed.url} tunnel={tunnel} deviceUser={deviceUser} disabled={!!webReason} reason={webReason} onOpenHere={onOpenWeb} onNavigate={onNavigate} />
                        ) : (
                            <Button type="submit" disabled={!!webReason} title={webReason}>
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
