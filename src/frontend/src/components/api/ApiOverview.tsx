"use client";

/**
 * API 頁頂端的總覽：基底網址（可複製）、CLI 文件與完整參考（Swagger）的連結，以及收合的「三條路怎麼比」圖
 * （預設收起，讓下面的分頁一眼看得到；之後記住，localStorage `telepy.apiOverview`）。
 * The API page's overview: the base URL (copy), links to the CLI guide and the full reference (Swagger), and the
 * collapsible "three ways in" diagram (closed by default so the tabs stay in view; the choice is remembered).
 */
import React from "react";
import { BookOpen, ChevronDown, ExternalLink, TerminalSquare } from "lucide-react";
import { CopyButton } from "@/components/ui/CopyButton";
import { useAuth } from "@/lib/auth";
import { hasFeature } from "@/lib/features";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useStoredChoice } from "@/hooks/useStoredChoice";
import { WaysInDiagram } from "./WaysInDiagram";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";
export const CLI_DOC_URL = "https://github.com/NatLee/telepy/blob/main/docs/cli.md";
const OPEN_STATES = ["open", "closed"] as const;

export function ApiOverview({ baseUrl }: { baseUrl: string }) {
    const { t } = useI18n();
    const { user } = useAuth();
    const [stored, setStored] = useStoredChoice("telepy.apiOverview", OPEN_STATES, "closed");
    const open = stored === "open";
    const toggle = () => setStored(open ? "closed" : "open");
    const linkClass = "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-foreground ring-1 ring-inset ring-border hover:bg-muted";
    return (
        <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-card sm:p-5" aria-label={t("apiPage.overviewTitle")}>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                <div className="min-w-0 flex-1">
                    <p className="text-xs text-muted-foreground">{t("apiPage.baseUrl")}</p>
                    <div className="mt-1 flex items-center gap-1 rounded-lg bg-surface py-0.5 pl-3 pr-0.5 ring-1 ring-inset ring-border/80">
                        <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground" title={baseUrl}>
                            {baseUrl || "…"}
                        </span>
                        {baseUrl && <CopyButton value={baseUrl} />}
                    </div>
                </div>
                <div className="flex flex-wrap gap-2">
                    <a href={CLI_DOC_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
                        <TerminalSquare size={15} className="text-muted-foreground" /> {t("apiPage.cliDoc")}
                        <ExternalLink size={12} className="opacity-60" />
                    </a>
                    {hasFeature(user, "api.docs") && (
                        <a href={`${API_BASE}/api/__hidden_swagger`} target="_blank" rel="noopener noreferrer" className={linkClass}>
                            <BookOpen size={15} className="text-muted-foreground" /> {t("apiPage.fullReference")}
                            <ExternalLink size={12} className="opacity-60" />
                        </a>
                    )}
                </div>
            </div>
            <button type="button" onClick={toggle} aria-expanded={open} className="mt-4 flex w-full items-center gap-2 text-left text-sm text-foreground">
                <ChevronDown size={16} className={cn("text-muted-foreground transition-transform", !open && "-rotate-90")} aria-hidden />
                {t("apiPage.overviewTitle")}
                <span className="hidden text-xs text-muted-foreground sm:inline">· {t("apiPage.overviewHint")}</span>
            </button>
            {open && (
                <div className="mt-3">
                    <WaysInDiagram />
                </div>
            )}
        </section>
    );
}
