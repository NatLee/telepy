"use client";

/**
 * 開一台區網主機終端機的兩種方式：「在這裡開」（本頁浮動 dock，不離開網路頁）與「終端機頁」（跳到 /tunnels/terminal，
 * 是真的連結，所以 Ctrl/⌘ 點、中鍵都能開新分頁）。兩者用同一組登入帳號、裝置帳號與登入方式。
 * 主機面板用並排的大按鈕（SplitOpen），列表 / 樹的每一列用小圖示（HostQuickActions）。
 * The two ways to open a LAN host's terminal: "Open here" (this page's floating dock, you stay on the network page)
 * and "Terminal page" (a real link to /tunnels/terminal, so Ctrl/⌘-click and middle-click open a new tab). Both
 * use the same login, device account and login method. The host panel shows a joined pair of buttons
 * (SplitOpen); table rows and tree entries show small icons (HostQuickActions).
 */
import React from "react";
import Link from "next/link";
import { Code, ExternalLink, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { getTerminalPageUrl } from "@/lib/tunnelUrls";
import { lanAuthParam, TELEPY_AUTH, type LanAuth } from "@/lib/lanAuth";
import { isValidLogin } from "@/lib/lanConnect";
import type { LanHost, TopologyTunnel } from "@/types/lan";

/** 裝置那一跳預設用哪個帳號（裝置的預設帳號，不能用就第一個）。/ The device account a hop uses by default. */
export function defaultDeviceUser(tn: Pick<TopologyTunnel, "default_username" | "usernames">): string | null {
    if (tn.default_username && tn.usernames.includes(tn.default_username)) return tn.default_username;
    return tn.usernames[0] ?? null;
}

/** 終端機頁的網址（帶登入帳號、裝置帳號與登入方式）。/ The terminal page URL with the login, device account and method. */
export function lanTerminalUrl(tn: Pick<TopologyTunnel, "id" | "reverse_port">, host: Pick<LanHost, "id">, login: string, deviceUser: string | null, auth: LanAuth = TELEPY_AUTH): string {
    return getTerminalPageUrl(tn, { lanHost: host.id, lanUser: login || undefined, lanAuth: lanAuthParam(auth), lanAccount: deviceUser ?? undefined });
}

/**
 * 面板裡的一對按鈕：主要動作「在這裡開」+ 次要的「終端機頁 ↗」連結。不能開時兩個都停用，原因寫在 `reason`。
 * The panel's pair: primary "Open here" plus a secondary "Terminal page ↗" link. Both disabled with `reason` when
 * the terminal can't open.
 */
export function SplitOpen({ onOpenHere, href, disabled, reason, onNavigate }: {
    onOpenHere: () => void;
    href: string;
    disabled: boolean;
    reason?: string;
    /** 跳頁前（記錄「最近用過」）。/ Before navigating (to remember the host as recently used). */
    onNavigate?: () => void;
}) {
    const { t } = useI18n();
    return (
        <div className="inline-flex min-w-0 max-w-full flex-wrap" role="group" aria-label={t("network.open.group")}>
            <Button onClick={onOpenHere} disabled={disabled} title={reason ?? t("network.open.hereHint")} className="rounded-r-none">
                <Terminal size={16} /> {t("network.open.here")}
            </Button>
            {disabled ? (
                <Button variant="outline" disabled title={reason} className="-ml-px rounded-l-none">
                    {t("network.open.page")} <ExternalLink size={14} />
                </Button>
            ) : (
                <Button variant="outline" asChild className="-ml-px rounded-l-none">
                    <Link href={href} prefetch={false} title={t("network.open.pageHint")} onClick={onNavigate}>
                        {t("network.open.page")} <ExternalLink size={14} />
                    </Link>
                </Button>
            )}
        </div>
    );
}

/**
 * 一列主機的小圖示：在這裡開、終端機頁、指令。沒有可用的登入帳號（主機沒設預設帳號）時，前兩個改成打開面板讓你先填帳號。
 * A host row's small icons: open here, terminal page, commands. Without a usable login (the host has no default)
 * the first two open the panel instead so you can fill one in.
 */
export function HostQuickActions({ host, tunnel, online, onOpenHere, onOpenPanel, onNavigate, compact = false, className }: {
    host: LanHost;
    tunnel: TopologyTunnel;
    online: boolean;
    onOpenHere: (h: LanHost) => void;
    onOpenPanel: (h: LanHost, tab: "terminal" | "commands") => void;
    onNavigate?: (h: LanHost) => void;
    /** 只有兩個終端機圖示（樹裡的主機卡；指令在面板裡）。/ Only the two terminal icons (tree entries; commands are in the panel). */
    compact?: boolean;
    className?: string;
}) {
    const { t } = useI18n();
    const login = host.username ?? "";
    const deviceUser = defaultDeviceUser(tunnel);
    const ready = isValidLogin(login) && deviceUser !== null;
    const offline = !online;
    const name = host.label || host.hostname || host.address;
    const icon = "size-8 text-muted-foreground hover:text-foreground";
    const stop = (e: React.SyntheticEvent) => e.stopPropagation();
    return (
        <span className={cn("flex shrink-0 items-center", className)} onClick={stop} onKeyDown={stop}>
            <Button
                variant="ghost"
                size="icon"
                className={icon}
                disabled={offline}
                onClick={() => (ready ? onOpenHere(host) : onOpenPanel(host, "terminal"))}
                aria-label={t("network.open.hereFor", { name })}
                title={offline ? t("network.deviceOffline") : ready ? t("network.open.hereAs", { login }) : t("network.open.needLogin")}
            >
                <Terminal size={15} />
            </Button>
            {ready && !offline ? (
                <Button variant="ghost" size="icon" className={icon} asChild>
                    <Link
                        href={lanTerminalUrl(tunnel, host, login, deviceUser)}
                        prefetch={false}
                        onClick={() => onNavigate?.(host)}
                        aria-label={t("network.open.pageFor", { name })}
                        title={t("network.open.pageAs", { login })}
                    >
                        <ExternalLink size={15} />
                    </Link>
                </Button>
            ) : (
                <Button
                    variant="ghost"
                    size="icon"
                    className={icon}
                    disabled={offline}
                    onClick={() => onOpenPanel(host, "terminal")}
                    aria-label={t("network.open.pageFor", { name })}
                    title={offline ? t("network.deviceOffline") : t("network.open.needLogin")}
                >
                    <ExternalLink size={15} />
                </Button>
            )}
            {!compact && <Button variant="ghost" size="icon" className={icon} onClick={() => onOpenPanel(host, "commands")} aria-label={t("network.open.commandsFor", { name })} title={t("network.open.commands")}>
                <Code size={15} />
            </Button>}
        </span>
    );
}
