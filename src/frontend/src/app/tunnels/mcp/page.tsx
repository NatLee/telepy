"use client";

/**
 * MCP 頁:讓 AI 工具(Claude Code、Claude Desktop / claude.ai、Cursor…)連上 Telepy 的入口。
 * 伺服器網址 + 各客戶端的設定方式、授權後能做什麼(scope → 工具)、session 何時自動關閉,
 * 以及已連接的應用程式(可撤銷)。所有使用者都看得到;管理員另有調整上限的捷徑。
 * MCP page: how to connect an AI tool to Telepy — the server URL and per-client setup, what each
 * permission allows, when sessions close, and the connected apps (with revoke).
 */
import React, { useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { Activity, ArrowRight, Info, KeyRound, Plug, ShieldCheck, SlidersHorizontal, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentReachDialog } from "@/components/mcp/AgentReachDialog";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { CopyButton } from "@/components/ui/CopyButton";
import { ConnectedApps } from "@/components/layout/ConnectedApps";
import { Segmented } from "@/components/ui/segmented";
import { Chip, SectionHeading } from "@/components/ui/section";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { useMcpPage } from "@/hooks/useMcpPage";
import { SCOPES } from "@/lib/aiAccess";

type ClientId = "claudeCode" | "claudeApp" | "other";

const SESSION_RULES: TranslationKey[] = [
    "mcp.ruleTimers",
    "mcp.ruleShells",
    "mcp.ruleBrowser",
    "mcp.ruleClosed",
    "mcp.ruleLimit",
    "mcp.ruleNotify",
    "mcp.ruleAudit",
];

function Panel({ icon, title, description, children }: { icon: React.ReactNode; title: string; description?: string; children: React.ReactNode }) {
    return (
        <section className="rounded-xl border border-border/80 bg-card p-5 text-card-foreground shadow-card">
            <SectionHeading as="h2" icon={icon} title={title} description={description} className="mb-3" />
            {children}
        </section>
    );
}

export default function McpPage() {
    const { t, tn } = useI18n();
    const { user } = useAuth();
    const { serverUrl, openSessions } = useMcpPage();
    const [client, setClient] = useState<ClientId>("claudeCode");
    const [reachOpen, setReachOpen] = useState(false);
    const url = serverUrl ?? "https://…/mcp";

    const clients: { id: ClientId; label: string }[] = [
        { id: "claudeCode", label: "Claude Code" },
        { id: "claudeApp", label: "Claude Desktop / claude.ai" },
        { id: "other", label: t("mcp.clientOther") },
    ];

    const code = (text: string) => <code className="px-1 py-0.5 rounded bg-muted font-mono text-[0.85em]">{text}</code>;
    const linkCardClass = "flex items-center gap-3 rounded-xl bg-surface px-3.5 py-3 text-sm ring-1 ring-inset ring-border/80 transition-colors hover:bg-primary/5 hover:ring-primary/40";

    return (
        <div className="animate-fade-in-up space-y-6">
            <PageHeader
                icon={<Plug />}
                title={t("mcp.title")}
                description={t("mcp.subtitle")}
                actions={
                    <Button variant="outline" onClick={() => setReachOpen(true)}>
                        <Info size={16} /> {t("mcp.reach.button")}
                    </Button>
                }
            />
            <AgentReachDialog isOpen={reachOpen} onClose={() => setReachOpen(false)} />

            <div className="grid gap-6 lg:grid-cols-5 items-start">
                <div className="lg:col-span-3 space-y-6 min-w-0">
                    {/* 伺服器網址 / Server URL */}
                    <Panel icon={<Plug />} title={t("mcp.serverUrl")}>
                        <div className="flex items-center gap-2 rounded-xl bg-surface py-1 pl-3.5 pr-1 ring-1 ring-inset ring-border/80">
                            <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground" title={url}>{url}</span>
                            {serverUrl && <CopyButton value={serverUrl} />}
                        </div>
                        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t("mcp.serverUrlHint")}</p>
                    </Panel>

                    {/* 客戶端設定 / Client setup */}
                    <Panel icon={<SlidersHorizontal />} title={t("mcp.setupTitle")}>
                        <div className="-mx-1 mb-3 overflow-x-auto px-1 py-0.5">
                            <Segmented kind="tabs" aria-label={t("mcp.setupTitle")} options={clients.map((c) => ({ value: c.id, label: c.label }))} value={client} onChange={setClient} />
                        </div>

                        {client === "claudeCode" && (
                            <div className="space-y-2">
                                <CodeBlock language="bash" value={`claude mcp add --transport http telepy ${url}`} />
                                <p className="text-sm text-muted-foreground">{tn("mcp.claudeCodeHint", { cmd: code("/mcp") })}</p>
                            </div>
                        )}
                        {client === "claudeApp" && (
                            <ol className="list-decimal pl-5 space-y-1.5 text-sm text-foreground">
                                <li>{tn("mcp.claudeAppStep1", { path: <strong>Settings → Connectors</strong>, action: <strong>Add custom connector</strong> })}</li>
                                <li>{t("mcp.claudeAppStep2")}</li>
                                <li>{t("mcp.claudeAppStep3")}</li>
                            </ol>
                        )}
                        {client === "other" && (
                            <div className="space-y-2">
                                <CodeBlock language="json" value={JSON.stringify({ mcpServers: { telepy: { url } } }, null, 2)} />
                                <p className="text-sm text-muted-foreground">{tn("mcp.otherHint", { file: code("mcp.json") })}</p>
                            </div>
                        )}
                    </Panel>

                    {/* 權限與工具 / Permissions and tools */}
                    <Panel icon={<KeyRound />} title={t("mcp.permissionsTitle")} description={t("mcp.permissionsHint")}>
                        <ul className="divide-y divide-border/70 rounded-xl ring-1 ring-inset ring-border/80">
                            {SCOPES.map((s) => (
                                <li key={s.scope} className="px-4 py-3 text-sm sm:flex sm:items-start sm:gap-4">
                                    <div className="min-w-0 sm:w-1/2">
                                        <p className="text-foreground">{t(s.label)}</p>
                                        <p className="text-xs text-muted-foreground">{t(s.description)}</p>
                                        <p className="mt-1 font-mono text-xs text-muted-foreground/80">{s.scope}</p>
                                    </div>
                                    <div className="mt-2 flex flex-wrap gap-1.5 sm:mt-0 sm:flex-1">
                                        {s.tools.map((tool) => (
                                            <code key={tool} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                                                {tool}
                                            </code>
                                        ))}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </Panel>
                </div>

                <div className="lg:col-span-2 space-y-6 min-w-0">
                    {/* 已連接的應用程式 / Connected apps */}
                    <section className="rounded-xl border border-border/80 bg-card p-5 text-card-foreground shadow-card">
                        <ConnectedApps />
                    </section>

                    {/* Session 規則 / How sessions end */}
                    <Panel icon={<Timer />} title={t("mcp.sessionsTitle")}>
                        <ul className="space-y-2 text-sm text-muted-foreground">
                            {SESSION_RULES.map((key) => (
                                <li key={key} className="flex gap-2">
                                    <ShieldCheck size={15} className="mt-0.5 shrink-0 text-primary/70" />
                                    <span className="leading-relaxed">{t(key)}</span>
                                </li>
                            ))}
                        </ul>
                        {/* 每個人都看得到 AI 活動;工作階段上限是全站設定,只有管理員能改(其他人看不到這張卡)。
                            Everyone can open AI activity; session limits are a site setting only admins can
                            change, so only they see that card. */}
                        <div className="mt-4 flex flex-col gap-2">
                            <Link href="/tunnels/activity" prefetch={false} className={linkCardClass}>
                                <Activity size={16} className="shrink-0 text-primary" />
                                <span className="min-w-0 flex-1">
                                    <span className="block text-foreground">{t("mcp.viewActivity")}</span>
                                    <span className="block text-xs text-muted-foreground">
                                        {openSessions !== null ? t("mcp.openSessions", { count: openSessions }) : t("mcp.viewActivityDescription")}
                                    </span>
                                </span>
                                <ArrowRight size={15} className="shrink-0 text-muted-foreground" />
                            </Link>
                            {user?.is_superuser && (
                                <Link href="/tunnels/settings?tab=ai" prefetch={false} className={linkCardClass}>
                                    <SlidersHorizontal size={16} className="shrink-0 text-primary" />
                                    <span className="min-w-0 flex-1">
                                        <span className="flex flex-wrap items-center gap-1.5 text-foreground">
                                            {t("mcp.adminLimits")}
                                            <Chip tone="primary">{t("common.adminOnly")}</Chip>
                                        </span>
                                        <span className="block text-xs text-muted-foreground">{t("mcp.adminLimitsDescription")}</span>
                                    </span>
                                    <ArrowRight size={15} className="shrink-0 text-muted-foreground" />
                                </Link>
                            )}
                        </div>
                    </Panel>
                </div>
            </div>
        </div>
    );
}
