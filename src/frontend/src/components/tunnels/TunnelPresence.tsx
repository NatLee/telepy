/**
 * 「N 人在用」：所有看得到隧道的人都看得到人數；owner / ADMIN / 管理員另外拿到 sessions（誰、哪種連線、IP、
 * 多久），hover 顯示。沒人用時不顯示。卡片與表格共用。
 * "N using" chip: everyone sees the count; owner / ADMIN / superuser also get the sessions (who, how, IP,
 * since) in a tooltip. Hidden when nobody is connected.
 */
import React from "react";
import { Users } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { formatRelativeTime } from "@/lib/relativeTime";
import { PresenceSession, TunnelPresence } from "@/types/tunnel";

const KIND_KEYS: Record<string, TranslationKey> = {
    terminal: "tunnels.presenceKind.terminal",
    files: "tunnels.presenceKind.files",
    browser: "tunnels.presenceKind.browser",
    ssh: "tunnels.presenceKind.ssh",
    ai: "tunnels.presenceKind.ai",
};

export function TunnelPresenceChip({ presence, className }: { presence?: TunnelPresence | null; className?: string }) {
    const { t, locale } = useI18n();
    if (!presence || presence.count <= 0) return null;

    const label = t("tunnels.presenceCount", { count: presence.count });
    const kind = (s: PresenceSession) => {
        const k = KIND_KEYS[s.kind] ? t(KIND_KEYS[s.kind]) : s.kind;
        return s.kind === "ai" && s.client ? `${k} (${s.client})` : k;
    };
    const chip = (
        <span
            className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset whitespace-nowrap [&>svg]:size-3",
                "bg-violet-500/10 text-violet-700 ring-violet-500/25 dark:text-violet-300",
                className
            )}
            aria-label={label}
            tabIndex={presence.sessions ? 0 : undefined}
        >
            <Users /> {label}
        </span>
    );
    if (!presence.sessions || presence.sessions.length === 0) return chip;

    return (
        <TooltipProvider delayDuration={150}>
            <Tooltip>
                <TooltipTrigger asChild>{chip}</TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-sm">
                    <p className="font-medium mb-1">{t("tunnels.presenceTitle")}</p>
                    <ul className="space-y-0.5 text-xs">
                        {presence.sessions.map((s, i) => (
                            <li key={i} className="flex flex-wrap gap-x-1.5">
                                <span className="font-medium">{s.user}</span>
                                <span>· {kind(s)}</span>
                                {s.ip && <span className="font-mono">· {s.ip}</span>}
                                <span className="opacity-80">· {formatRelativeTime(s.since, locale)}</span>
                            </li>
                        ))}
                    </ul>
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}
