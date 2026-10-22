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
import { Activity, ArrowRight, KeyRound, Plug, ShieldCheck, SlidersHorizontal, Timer } from "lucide-react";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { CopyButton } from "@/components/ui/CopyButton";
import { ConnectedApps } from "@/components/layout/ConnectedApps";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { useMcpPage } from "@/hooks/useMcpPage";

type ClientId = "claudeCode" | "claudeApp" | "other";

/** 同意頁上的 scope 與它開放的工具(與後端 mcp/ 的檢查一致)。/ Scopes and the tools they unlock (mirrors mcp/). */
const SCOPES: { scope: string; label: TranslationKey; description: TranslationKey; tools: string[] }[] = [
    { scope: "tunnels:read", label: "oauth.scope.tunnelsRead", description: "oauth.scope.tunnelsReadDescription", tools: ["list_tunnels", "tunnel_status"] },
    { scope: "ssh:exec", label: "oauth.scope.sshExec", description: "oauth.scope.sshExecDescription", tools: ["ssh_session_open", "ssh_exec"] },
    { scope: "ssh:files", label: "oauth.scope.sshFiles", description: "oauth.scope.sshFilesDescription", tools: ["ssh_session_open", "sftp_list", "sftp_read", "sftp_write"] },
];

const SESSION_RULES: TranslationKey[] = [
    "mcp.ruleTimers",
    "mcp.ruleClosed",
    "mcp.ruleLimit",
    "mcp.ruleNotify",
    "mcp.ruleAudit",
];

function Panel({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
    return (
        <section className="rounded-xl border border-border bg-card text-card-foreground shadow-sm p-5">
            <h2 className="text-sm font-semibold flex items-center gap-2 mb-3">
                <span className="text-primary">{icon}</span>
                {title}
            </h2>
            {children}
        </section>
    );
}

export default function McpPage() {
    const { t, tn } = useI18n();
    const { user } = useAuth();
    const { serverUrl, openSessions } = useMcpPage();
    const [client, setClient] = useState<ClientId>("claudeCode");
    const url = serverUrl ?? "https://…/mcp";

    const clients: { id: ClientId; label: string }[] = [
        { id: "claudeCode", label: "Claude Code" },
        { id: "claudeApp", label: "Claude Desktop / claude.ai" },
        { id: "other", label: t("mcp.clientOther") },
    ];

    const code = (text: string) => <code className="px-1 py-0.5 rounded bg-muted font-mono text-[0.85em]">{text}</code>;

    return (
        <div className="animate-fade-in-up space-y-6">
            <PageHeader icon={<Plug />} title={t("mcp.title")} description={t("mcp.subtitle")} />

            <div className="grid gap-6 lg:grid-cols-5 items-start">
                <div className="lg:col-span-3 space-y-6 min-w-0">
                    {/* 伺服器網址 / Server URL */}
                    <Panel icon={<Plug size={15} />} title={t("mcp.serverUrl")}>
                        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 pl-3 pr-1 py-1">
                            <span className="flex-1 min-w-0 truncate font-mono text-sm text-foreground" title={url}>{url}</span>
                            {serverUrl && <CopyButton value={serverUrl} />}
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground leading-relaxed">{t("mcp.serverUrlHint")}</p>
                    </Panel>

                    {/* 客戶端設定 / Client setup */}
                    <Panel icon={<SlidersHorizontal size={15} />} title={t("mcp.setupTitle")}>
                        <div className="flex flex-wrap gap-1.5 mb-3" role="tablist">
                            {clients.map((c) => (
                                <button
                                    key={c.id}
                                    type="button"
                                    role="tab"
                                    aria-selected={client === c.id}
                                    onClick={() => setClient(c.id)}
                                    className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${client === c.id
                                        ? "border-primary bg-primary/10 text-primary"
                                        : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                                        }`}
                                >
                                    {c.label}
                                </button>
                            ))}
                        </div>

                        {client === "claudeCode" && (
                            <div className="space-y-2">
                                <CodeBlock language="bash" value={`claude mcp add --transport http telepy ${url}`} />
                                <p className="text-xs text-muted-foreground">{tn("mcp.claudeCodeHint", { cmd: code("/mcp") })}</p>
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
                                <p className="text-xs text-muted-foreground">{tn("mcp.otherHint", { file: code("mcp.json") })}</p>
                            </div>
                        )}
                    </Panel>

                    {/* 權限與工具 / Permissions and tools */}
                    <Panel icon={<KeyRound size={15} />} title={t("mcp.permissionsTitle")}>
                        <p className="text-xs text-muted-foreground leading-relaxed mb-3">{t("mcp.permissionsHint")}</p>
                        <ul className="rounded-lg border border-border divide-y divide-border">
                            {SCOPES.map((s) => (
                                <li key={s.scope} className="px-4 py-3 text-sm sm:flex sm:items-start sm:gap-4">
                                    <div className="sm:w-1/2 min-w-0">
                                        <p className="font-medium text-foreground">{t(s.label)}</p>
                                        <p className="text-xs text-muted-foreground">{t(s.description)}</p>
                                        <p className="mt-1 font-mono text-[11px] text-muted-foreground/80">{s.scope}</p>
                                    </div>
                                    <div className="mt-2 sm:mt-0 flex flex-wrap gap-1.5 sm:flex-1">
                                        {s.tools.map((tool) => (
                                            <code key={tool} className="px-1.5 py-0.5 rounded border border-border bg-muted/50 font-mono text-[11px] text-foreground">
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
                    <section className="rounded-xl border border-border bg-card text-card-foreground shadow-sm p-5">
                        <ConnectedApps />
                    </section>

                    {/* Session 規則 / How sessions end */}
                    <Panel icon={<Timer size={15} />} title={t("mcp.sessionsTitle")}>
                        <ul className="space-y-2 text-sm text-muted-foreground">
                            {SESSION_RULES.map((key) => (
                                <li key={key} className="flex gap-2">
                                    <ShieldCheck size={14} className="mt-0.5 shrink-0 text-primary/70" />
                                    <span className="leading-relaxed">{t(key)}</span>
                                </li>
                            ))}
                        </ul>
                        <div className="mt-4 flex flex-col gap-2">
                            <Link
                                href="/tunnels/activity"
                                prefetch={false}
                                className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-sm hover:border-primary/50 hover:bg-primary/5 transition-colors"
                            >
                                <Activity size={15} className="text-primary shrink-0" />
                                <span className="flex-1 min-w-0">
                                    <span className="block font-medium text-foreground">{t("mcp.viewActivity")}</span>
                                    {openSessions !== null && (
                                        <span className="block text-xs text-muted-foreground">{t("mcp.openSessions", { count: openSessions })}</span>
                                    )}
                                </span>
                                <ArrowRight size={15} className="text-muted-foreground shrink-0" />
                            </Link>
                            {user?.is_superuser && (
                                <Link
                                    href="/tunnels/settings?tab=ai"
                                    prefetch={false}
                                    className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-sm hover:border-primary/50 hover:bg-primary/5 transition-colors"
                                >
                                    <SlidersHorizontal size={15} className="text-primary shrink-0" />
                                    <span className="flex-1 min-w-0">
                                        <span className="block font-medium text-foreground">{t("mcp.adminLimits")}</span>
                                        <span className="block text-xs text-muted-foreground">{t("mcp.adminLimitsDescription")}</span>
                                    </span>
                                    <ArrowRight size={15} className="text-muted-foreground shrink-0" />
                                </Link>
                            )}
                        </div>
                    </Panel>
                </div>
            </div>
        </div>
    );
}
