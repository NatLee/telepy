"use client";

/**
 * 一個 Host 區塊，逐行加上註解（桌面在右欄、手機在下一行）。複製只複製設定本身。
 * 滑過或聚焦時通知外層，讓路線圖亮起對應的那一段。
 * One Host stanza with a note on every line (a right-hand column on desktop, under the line on phones). Copy copies
 * just the config. Hover / focus tells the parent so the route map can light up the matching leg.
 */
import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { stanzaText, type ConfigStanza } from "@/lib/sshConfig";
import type { ConfigPart } from "./ConfigRouteMap";

const NOTES: Record<ConfigPart, Record<string, TranslationKey>> = {
    server: {
        host: "config.line.serverHost",
        hostname: "config.line.serverHostName",
        port: "config.line.serverPort",
        user: "config.line.serverUser",
        compression: "config.line.compression",
        stricthostkeychecking: "config.line.strictHostKeyChecking",
        userknownhostsfile: "config.line.userKnownHostsFile",
        hostkeyalias: "config.line.hostKeyAlias",
    },
    device: {
        host: "config.line.deviceHost",
        hostname: "config.line.deviceHostName",
        port: "config.line.devicePort",
        user: "config.line.deviceUser",
        compression: "config.line.compression",
        stricthostkeychecking: "config.line.strictHostKeyChecking",
        proxycommand: "config.line.deviceProxyCommand",
    },
};

interface Props {
    n: number;
    part: ConfigPart;
    title: React.ReactNode;
    hint?: React.ReactNode;
    stanza: ConfigStanza;
    active: ConfigPart | null;
    onActive: (part: ConfigPart | null) => void;
}

export function ConfigStanzaCard({ n, part, title, hint, stanza, active, onActive }: Props) {
    const { t } = useI18n();
    const [copied, setCopied] = useState(false);
    const copy = () =>
        navigator.clipboard
            .writeText(stanzaText(stanza))
            .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            })
            .catch(() => { /* 剪貼簿不可用時不做事 / clipboard unavailable: no-op */ });

    const lines: { key: string; value: string; indent: boolean }[] = [
        { key: "Host", value: stanza.alias, indent: false },
        ...stanza.options.map((o) => ({ ...o, indent: true })),
    ];
    const note = (key: string, value: string) => {
        // 伺服器區塊釘住了 Telepy 的主機金鑰時，StrictHostKeyChecking 的意思相反。/ With pinning, the line means the opposite.
        const k = key.toLowerCase() === "stricthostkeychecking" && value.toLowerCase() === "yes" ? "config.line.strictHostKeyCheckingYes" : NOTES[part][key.toLowerCase()];
        return k ? t(k, { alias: stanza.alias }) : null;
    };

    return (
        <div
            className={cn(
                "overflow-hidden rounded-lg bg-[oklch(0.2_0.012_260)] ring-1 ring-black/10 transition-shadow dark:bg-[oklch(0.14_0.01_260)] dark:ring-white/10",
                active === part && "ring-2 ring-primary/70 dark:ring-primary/70"
            )}
            onMouseEnter={() => onActive(part)}
            onMouseLeave={() => onActive(null)}
            onFocus={() => onActive(part)}
            onBlur={() => onActive(null)}
        >
            <div className="flex items-center gap-2.5 border-b border-white/8 py-1.5 pl-3 pr-1.5 text-xs">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-white text-[0.6875rem] text-[oklch(0.2_0.012_260)]" aria-hidden>{n}</span>
                <span className="min-w-0 flex-1 truncate">
                    <span className="text-white/90">{title}</span>
                    {hint && <span className="ml-2 text-white/50">{hint}</span>}
                </span>
                <button
                    type="button"
                    onClick={copy}
                    className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-white/70 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
                    title={t("ui.copyToClipboard")}
                >
                    {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
                    {copied ? t("common.copied") : t("common.copy")}
                </button>
            </div>
            <div className="overflow-x-auto px-4 py-3">
                <div className="grid grid-cols-1 gap-y-1 sm:grid-cols-[max-content_minmax(12rem,1fr)] sm:gap-x-6 sm:gap-y-0.5">
                    {lines.map((l, i) => {
                        const text = note(l.key, l.value);
                        return (
                            <React.Fragment key={i}>
                                <code className="whitespace-pre font-mono text-[0.8125rem] leading-relaxed">
                                    {l.indent && "    "}
                                    <span className={l.indent ? "text-sky-400" : "text-success"}>{l.key}</span>{" "}
                                    <span className={l.indent ? "text-warning" : "text-violet-300"}>{l.value}</span>
                                </code>
                                <span className={cn("-mt-1 pl-8 text-xs leading-relaxed text-slate-400 sm:mt-0 sm:self-center sm:pl-0", !text && "hidden sm:block")}>
                                    {text && (
                                        <>
                                            <span className="select-none font-mono text-slate-500"># </span>
                                            {text}
                                        </>
                                    )}
                                </span>
                            </React.Fragment>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
