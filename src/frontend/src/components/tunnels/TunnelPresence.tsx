/**
 * 「N 人使用中」按鈕：所有看得到隧道的人都看得到人數，點開是浮層。owner / ADMIN / 管理員在浮層裡看到誰、哪種連線、IP、
 * 多久（依使用者分組，同一人同種連線同 IP 合併成「×N」，太長就在浮層裡捲動，不會把列表撐高）；其他人看到一句說明。
 * 沒人用時不顯示。卡片與表格共用，放在存取標籤旁邊。
 * "N using" button next to the access badges: everyone sees the count; a click opens a popover. Owner / ADMIN /
 * superuser get the sessions (who, how, IP, since) grouped per user, identical sessions folded into "×N" and the
 * list scrolling inside the popover so the tunnel list never grows; everyone else gets a one-line note. Hidden
 * when nobody is connected.
 */
import React, { useMemo } from "react";
import { Bot, ChevronDown, FolderOpen, Laptop, MonitorPlay, Plug, ScreenShare, TerminalSquare, type LucideIcon } from "lucide-react";
import { MoreBelow } from "@/components/ui/Modal";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { formatRelativeTime } from "@/lib/relativeTime";
import { PresenceSession, TunnelPresence } from "@/types/tunnel";
import { IpPlace } from "@/components/ui/IpPlace";

const KINDS: Record<string, { icon: LucideIcon; label: TranslationKey }> = {
    terminal: { icon: TerminalSquare, label: "tunnels.presenceKind.terminal" },
    files: { icon: FolderOpen, label: "tunnels.presenceKind.files" },
    browser: { icon: MonitorPlay, label: "tunnels.presenceKind.browser" },
    ssh: { icon: Laptop, label: "tunnels.presenceKind.ssh" },
    ai: { icon: Bot, label: "tunnels.presenceKind.ai" },
    desktop: { icon: ScreenShare, label: "tunnels.presenceKind.desktop" },
};

interface PresenceLine {
    kind: string;
    ip: string | null;
    geo: PresenceSession["geo"];
    client: string | null;
    /** 這組裡最早的一條。/ The earliest session in the group. */
    since: string;
    count: number;
}

interface PresenceUser {
    user: string;
    lines: PresenceLine[];
}

const sinceMs = (s: { since: string }) => Date.parse(s.since) || 0;

/** 依使用者分組（最早來的在前），同種連線 + 同 IP + 同 app 合併計數。/ Group per user, fold identical sessions. */
function groupSessions(sessions: PresenceSession[]): PresenceUser[] {
    const users = new Map<string, PresenceUser>();
    for (const s of [...sessions].sort((a, b) => sinceMs(a) - sinceMs(b))) {
        let u = users.get(s.user);
        if (!u) {
            u = { user: s.user, lines: [] };
            users.set(s.user, u);
        }
        const line = u.lines.find(l => l.kind === s.kind && l.ip === s.ip && l.client === s.client);
        if (line) line.count += 1;
        else u.lines.push({ kind: s.kind, ip: s.ip, geo: s.geo, client: s.client, since: s.since, count: 1 });
    }
    return [...users.values()];
}

/** 浮層裡的一個人：頭像、名字，底下是他的連線（種類 ×N、多久、IP）。/ One person in the popover with their sessions. */
function PresenceUserRow({ group }: { group: PresenceUser }) {
    const { t, locale } = useI18n();
    const kindLabel = (l: PresenceLine) => {
        const k = KINDS[l.kind] ? t(KINDS[l.kind].label) : l.kind;
        return l.kind === "ai" && l.client ? `${k} · ${l.client}` : k;
    };
    return (
        <li className="flex gap-2.5 px-3 py-2.5">
            <span
                className="mt-px grid size-6 shrink-0 place-items-center rounded-full bg-foreground text-background text-[0.6875rem] uppercase"
                aria-hidden
            >
                {group.user.slice(0, 1)}
            </span>
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground" title={group.user}>
                    {group.user}
                </p>
                <ul className="mt-1 space-y-1.5">
                    {group.lines.map(l => {
                        const Icon = KINDS[l.kind]?.icon ?? Plug;
                        return (
                            <li key={`${l.kind}|${l.ip}|${l.client}`} className="text-xs text-muted-foreground">
                                <div className="flex items-center gap-1.5">
                                    <Icon className="size-3.5 shrink-0" aria-hidden />
                                    <span className="truncate text-foreground/80">{kindLabel(l)}</span>
                                    {l.count > 1 && (
                                        <span className="shrink-0 rounded-sm bg-muted px-1 font-mono text-[0.6875rem] text-foreground/75">
                                            ×{l.count}
                                        </span>
                                    )}
                                    <span className="ml-auto shrink-0 pl-2" title={new Date(l.since).toLocaleString(locale)}>
                                        {formatRelativeTime(l.since, locale)}
                                    </span>
                                </div>
                                {l.ip && (
                                    <p className="flex min-w-0 items-center gap-2 pl-5">
                                        <span className="truncate font-mono text-[0.75rem]">{l.ip}</span>
                                        <IpPlace geo={l.geo} className="text-[0.75rem]" />
                                    </p>
                                )}
                            </li>
                        );
                    })}
                </ul>
            </div>
        </li>
    );
}

export function TunnelPresenceButton({ presence, className }: { presence?: TunnelPresence | null; className?: string }) {
    const { t } = useI18n();
    const sessions = presence?.sessions;
    const groups = useMemo(() => groupSessions(sessions ?? []), [sessions]);
    if (!presence || presence.count <= 0) return null;

    const label = t("tunnels.presenceCount", { count: presence.count });
    const detailed = !!sessions && sessions.length > 0;
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    title={t("tunnels.presenceShow")}
                    aria-label={`${label} · ${t("tunnels.presenceShow")}`}
                    className={cn(
                        // 狀態 = 點 + 文字（設計語言）；箭頭表示可以展開。/ Status is a dot + text; the chevron says it opens.
                        "group inline-flex items-center gap-1.5 rounded-sm border py-px pl-1.5 pr-1 text-[0.75rem] whitespace-nowrap transition-colors",
                        "border-success/25 bg-success/10 text-success hover:border-success/50 hover:bg-success/15",
                        "data-[state=open]:border-success/50 data-[state=open]:bg-success/15",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                        className
                    )}
                >
                    <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden />
                    {label}
                    <ChevronDown className="size-3 shrink-0 opacity-70 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className={cn("flex flex-col overflow-hidden", detailed ? "w-80" : "w-64")}>
                <div className="flex shrink-0 items-baseline justify-between gap-3 border-b border-border px-3 py-2.5">
                    <p className="text-sm text-foreground">{t("tunnels.presenceTitle")}</p>
                    <p className="text-xs text-muted-foreground whitespace-nowrap">
                        {detailed ? t("tunnels.presenceConnections", { count: sessions.length }) : label}
                    </p>
                </div>
                {detailed ? (
                    <div className="relative flex min-h-0 max-h-80 flex-col overflow-y-auto overscroll-contain">
                        <ul className="divide-y divide-border">
                            {groups.map(g => (
                                <PresenceUserRow key={g.user} group={g} />
                            ))}
                        </ul>
                        <MoreBelow className="bottom-0 -mt-12 h-12 from-popover via-popover/85" />
                    </div>
                ) : (
                    <p className="px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">{t("tunnels.presenceHidden")}</p>
                )}
            </PopoverContent>
        </Popover>
    );
}
