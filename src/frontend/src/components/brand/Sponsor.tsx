"use client";

/**
 * 關於 Telepy 的「贊助」按鈕：一個小浮層，列出 Ko-fi（單次）與 Liberapay（定期）。
 * 帳號和 .github/FUNDING.yml、三份 README 的「贊助」段落相同，改帳號時一起改。
 *
 * The About section's Sponsor button: a small popover with Ko-fi (one-off) and Liberapay (recurring).
 * The accounts match .github/FUNDING.yml and the READMEs' sponsoring section; change them together.
 */

import React from "react";
import { Coffee, ExternalLink, Heart, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";

export const SPONSOR_LINKS: { name: string; href: string; icon: React.ReactNode; hint: TranslationKey }[] = [
    { name: "Ko-fi", href: "https://ko-fi.com/natlee_", icon: <Coffee />, hint: "about.sponsorKofiHint" },
    { name: "Liberapay", href: "https://liberapay.com/natlee/donate", icon: <Repeat />, hint: "about.sponsorLiberapayHint" },
];

export function SponsorButton() {
    const { t } = useI18n();
    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                    <Heart />
                    {t("about.sponsor")}
                </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[min(21rem,calc(100vw-1.5rem))] space-y-3 overflow-y-auto p-4 text-sm">
                <div className="space-y-1">
                    <p className="text-foreground">{t("about.sponsorTitle")}</p>
                    <p className="leading-relaxed text-muted-foreground">{t("about.sponsorBody")}</p>
                </div>
                <ul className="space-y-1.5">
                    {SPONSOR_LINKS.map((l) => (
                        <li key={l.name}>
                            <a
                                href={l.href}
                                target="_blank"
                                rel="noreferrer"
                                className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&>svg]:size-4 [&>svg]:shrink-0"
                            >
                                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-foreground [&>svg]:size-4" aria-hidden>
                                    {l.icon}
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block text-foreground">{l.name}</span>
                                    <span className="block text-xs text-muted-foreground">{t(l.hint)}</span>
                                </span>
                                <ExternalLink className="text-muted-foreground" aria-hidden />
                            </a>
                        </li>
                    ))}
                </ul>
            </PopoverContent>
        </Popover>
    );
}
