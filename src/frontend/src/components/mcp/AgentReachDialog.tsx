"use client";

/**
 * MCP 頁的 info 對話框：一張「agent 碰得到哪裡」的圖 —— MCP app ─ Telepy（權限）─ 裝置（指令 / 互動 shell / 檔案）─
 * 裝置的區網與網際網路（遠端瀏覽器、區網掃描）。選一個已連接的 app，它的權限開著的分支亮起來，其餘是虛線「沒給」。
 * 只有直線與直角（border 畫的），窄的時候整條改成直的。邏輯在 `lib/aiAccess.ts` 的 `reachFor`（有測試）。
 * The MCP page's info dialog: what an agent can reach — MCP app ─ Telepy (permissions) ─ device (commands / shells /
 * files) ─ the device's LAN and the internet (remote browser, LAN scan). Pick a connected app and the branches its
 * permissions open light up; the rest are dashed "not granted". Straight lines and right angles only (borders); the
 * chain stacks vertically when narrow. The logic is `reachFor` in `lib/aiAccess.ts` (tested).
 */
import React, { useEffect, useMemo, useState } from "react";
import { Bot, FolderTree, Globe, Info, Radar, Server, SquareTerminal, TerminalSquare, Eye, type LucideIcon } from "lucide-react";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/section";
import { NativeSelect } from "@/components/ui/native-select";
import { SCOPE_META } from "@/components/oauth/ConnectFlow";
import { apiFetch } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { REACH_BRANCHES, reachFor, type ReachBranch } from "@/lib/aiAccess";
import { cn } from "@/lib/utils";
import type { OAuthGrant } from "@/types/oauth";
import { splitGrants } from "@/lib/cliSignIns";

const BRANCH_ICON: Record<ReachBranch, LucideIcon> = {
    tunnels: Eye,
    exec: SquareTerminal,
    shell: TerminalSquare,
    files: FolderTree,
    scan: Radar,
    browser: Globe,
};

function Node({ icon: Icon, brand, title, sub, lit, children }: { icon?: LucideIcon; brand?: boolean; title: string; sub?: string; lit: boolean; children?: React.ReactNode }) {
    return (
        <div className={cn("flex min-w-0 flex-col items-center gap-1.5 rounded-xl border bg-card px-3 py-3 text-center @2xl:flex-1 @2xl:basis-0", lit ? "border-primary/50" : "border-dashed border-border")}>
            <span className={cn("grid size-10 place-items-center rounded-lg", brand ? "bg-brand-gradient text-white" : lit ? "bg-muted text-foreground" : "bg-muted text-muted-foreground")} aria-hidden>
                {brand ? <TelepyGlyph size={22} /> : Icon ? <Icon size={20} /> : null}
            </span>
            <span className="max-w-full truncate text-sm text-foreground" title={title}>{title}</span>
            {sub && <span className="text-xs leading-snug text-muted-foreground">{sub}</span>}
            {children}
        </div>
    );
}

/** 兩個節點之間的線：寬的時候橫的、窄的時候直的；沒開 = 虛線。/ A link: horizontal when wide, vertical when narrow; dashed when closed. */
function Link({ label, lit }: { label: string; lit: boolean }) {
    const line = lit ? "border-primary/70" : "border-dashed border-border";
    return (
        <div className="flex min-w-0 flex-row items-center gap-3 px-6 @2xl:w-28 @2xl:shrink-0 @2xl:flex-col @2xl:gap-1 @2xl:px-1.5" aria-label={label}>
            <span className={cn("h-8 w-0 border-l-2 @2xl:hidden", line)} aria-hidden />
            <span className={cn("hidden h-0 w-full border-t-2 @2xl:block", line)} aria-hidden />
            <span className={cn("text-xs leading-tight @2xl:text-center", lit ? "text-foreground" : "text-muted-foreground")}>{label}</span>
        </div>
    );
}

/** 一條分支：左邊一段直角的線（└─），圖示、說法、工具與狀態。/ One branch: a right-angle elbow, icon, words, tools and state. */
function Branch({ id, lit, last, onward }: { id: ReachBranch; lit: boolean; last: boolean; onward?: React.ReactNode }) {
    const { t } = useI18n();
    const b = REACH_BRANCHES.find((x) => x.id === id)!;
    const Icon = BRANCH_ICON[id];
    const line = lit ? "border-primary/70" : "border-dashed border-border";
    return (
        <li className="relative flex gap-3 pl-6">
            {/* └ 或 ├：直的那段接到下一條，橫的那段接到這一條。/ The elbow: vertical to the next branch, horizontal to this one. */}
            <span className={cn("absolute left-0 top-0 w-0 border-l-2", line, last ? "h-5" : "h-full")} aria-hidden />
            <span className={cn("absolute left-0 top-5 h-0 w-5 border-t-2", line)} aria-hidden />
            <div className={cn("mb-2 flex min-w-0 flex-1 flex-wrap items-start gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2", lit ? "border-border bg-card" : "border-dashed border-border bg-transparent")}>
                <span className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-md", lit ? "bg-muted text-foreground" : "text-muted-foreground")} aria-hidden>
                    <Icon size={16} />
                </span>
                <div className="min-w-0 flex-1 basis-56">
                    <p className={cn("text-sm", lit ? "text-foreground" : "text-muted-foreground")}>{t(b.label)}</p>
                    <p className="text-xs leading-relaxed text-muted-foreground">{t(b.detail)}</p>
                    <p className="mt-1 flex flex-wrap gap-1">
                        {b.tools.map((tool) => (
                            <code key={tool} className="rounded-sm bg-muted px-1 py-px font-mono text-[0.75rem] text-muted-foreground">{tool}</code>
                        ))}
                    </p>
                    {onward}
                </div>
                <span className="flex shrink-0 flex-col items-end gap-1">
                    {lit ? <Chip tone="success">{t("mcp.reach.allowed")}</Chip> : <Chip>{t("mcp.reach.notGranted")}</Chip>}
                    <span className="font-mono text-[0.75rem] text-muted-foreground">{b.scope}</span>
                </span>
            </div>
        </li>
    );
}

export function AgentReachDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const { t } = useI18n();
    const [grants, setGrants] = useState<OAuthGrant[] | null>(null);
    // "" = 沒選 app（顯示所有可能）。/ "" = no app picked (show everything possible).
    const [picked, setPicked] = useState<string>("");

    useEffect(() => {
        if (!isOpen) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await apiFetch("/api/oauth/grants");
                // 只有 MCP app：CLI 的瀏覽器登入不是 AI app，到不了 MCP 工具。/ MCP apps only; CLI sign-ins are not AI apps.
                const data: OAuthGrant[] = res.ok ? splitGrants((await res.json()) as OAuthGrant[]).apps : [];
                if (cancelled) return;
                setGrants(data);
                setPicked((prev) => (prev && data.some((g) => String(g.id) === prev) ? prev : data[0] ? String(data[0].id) : ""));
            } catch {
                if (!cancelled) setGrants([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [isOpen]);

    const grant = useMemo(() => grants?.find((g) => String(g.id) === picked) ?? null, [grants, picked]);
    const reach = reachFor(grant ? grant.scopes : null);
    const appName = grant?.client_name || t("mcp.reach.anyApp");
    const tunnels = grant ? (grant.tunnels === null ? t("mcp.reach.allTunnels") : t("mcp.reach.someTunnels", { count: grant.tunnels.length })) : t("mcp.reach.allTunnels");
    const deviceBranches: ReachBranch[] = ["exec", "shell", "files", "scan", "browser"];

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("mcp.reach.title")}
            description={t("mcp.reach.description")}
            icon={<Info />}
            size="4xl"
            toolbar={
                <label className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    {t("mcp.reach.pickApp")}
                    <NativeSelect value={picked} onChange={(e) => setPicked(e.target.value)} className="h-9 w-64 max-w-full">
                        <option value="">{t("mcp.reach.everything")}</option>
                        {(grants ?? []).map((g) => (
                            <option key={g.id} value={String(g.id)}>
                                {g.client_name}
                            </option>
                        ))}
                    </NativeSelect>
                </label>
            }
            footer={<Button onClick={onClose}>{t("common.close")}</Button>}
        >
            <div className="space-y-5">
                <p className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground" role="status">
                    {grant
                        ? reach.web
                            ? t("mcp.reach.nowWeb", { app: appName })
                            : reach.device
                              ? t("mcp.reach.nowDevice", { app: appName })
                              : t("mcp.reach.nowTelepy", { app: appName })
                        : t("mcp.reach.nowAny")}
                </p>

                <div className="@container">
                    <div className="flex flex-col items-stretch @2xl:flex-row @2xl:items-center">
                        <Node icon={Bot} title={appName} sub={t("mcp.reach.appSub")} lit />
                        <Link label={t("mcp.reach.linkMcp")} lit />
                        <Node brand title="Telepy" sub={t("mcp.reach.telepySub")} lit>
                            <span className="flex flex-wrap justify-center gap-1">
                                {(grant ? grant.scopes : Object.keys(SCOPE_META)).map((s) => {
                                    const meta = SCOPE_META[s];
                                    return (
                                        <Chip key={s} tone={meta?.changes ? "warning" : "neutral"} title={s}>
                                            {meta ? t(meta.label) : s}
                                        </Chip>
                                    );
                                })}
                            </span>
                        </Node>
                        <Link label={t("mcp.reach.linkTunnel")} lit={reach.device} />
                        <Node icon={Server} title={t("mcp.reach.device")} sub={tunnels} lit={reach.device} />
                    </div>
                </div>

                <section>
                    <h3 className="mb-2 text-sm text-foreground">{t("mcp.reach.inTelepy")}</h3>
                    <ul>
                        <Branch id="tunnels" lit={reach.branches.tunnels} last />
                    </ul>
                </section>

                <section>
                    <h3 className="mb-2 text-sm text-foreground">{t("mcp.reach.onDevice")}</h3>
                    <ul>
                        {deviceBranches.map((id, i) => (
                            <Branch
                                key={id}
                                id={id}
                                lit={reach.branches[id]}
                                last={i === deviceBranches.length - 1}
                                onward={
                                    id === "browser" || id === "scan" ? (
                                        // 再往外一段：裝置的區網 / 網際網路。/ One more hop: the device's LAN / the internet.
                                        <span className={cn("mt-1.5 flex items-center gap-2 text-xs", reach.branches[id] ? "text-foreground" : "text-muted-foreground")}>
                                            <span className={cn("h-0 w-6 border-t-2", reach.branches[id] ? "border-primary/70" : "border-dashed border-border")} aria-hidden />
                                            {t(id === "browser" ? "mcp.reach.beyondBrowser" : "mcp.reach.beyondScan")}
                                        </span>
                                    ) : undefined
                                }
                            />
                        ))}
                    </ul>
                </section>

                <ul className="space-y-1.5 border-t border-border pt-4 text-sm text-muted-foreground">
                    <li>{t("mcp.reach.noteRules")}</li>
                    <li>{t("mcp.reach.noteCommandRules")}</li>
                    <li>{t("mcp.reach.noteAudit")}</li>
                </ul>
            </div>
        </Modal>
    );
}
