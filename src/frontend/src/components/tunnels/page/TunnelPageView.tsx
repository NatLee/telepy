"use client";

/**
 * 每條通道自己的頁面（`/tunnels/<id>?tab=…`），取代以前的「詳細資訊」對話框：左側分頁（頁面夠寬時黏在左邊，不夠寬是
 * 上面一排）——總覽 / 連線方式 / 裝置 / 金鑰與身分 / 存取 / 工作階段 / 紀錄 / 設定。標題列的「更多」是跟列表同一份快速
 * 入口選單（在這裡，通道頁面的項目直接換分頁）。分享、登入帳號、腳本、SSH 設定、刪除仍是原本的對話框。
 * Each tunnel's own page (`/tunnels/<id>?tab=…`), replacing the old details dialog: tabs on the left when the page is
 * wide enough, a row on top otherwise. The header's "More" is the list's quick-access menu (its page items switch tabs
 * here). Sharing, login accounts, scripts, SSH config and delete stay the existing dialogs.
 */
import React, { useRef } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Activity, ArrowLeft, Cpu, History, KeyRound, LayoutDashboard, Loader2, Rocket, Route, Server, Settings, Users, UserCheck } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Section, SectionOutline, SectionOutlineProvider, SectionPanels } from "@/components/ui/section";
import { NavTabLabel, NavTabs } from "@/components/ui/nav-tabs";
import { TunnelStatusPill } from "@/components/tunnels/TunnelStatus";
import { TunnelActions } from "@/components/tunnels/TunnelActions";
import { TunnelModals } from "@/components/tunnels/TunnelModals";
import { ConnectionTab } from "@/components/tunnels/ConnectionTab";
import { DeviceFactsSection } from "@/components/tunnels/DeviceFacts";
import { StepUpSetting } from "@/components/tunnels/StepUpSetting";
import { RecordingSetting } from "@/components/tunnels/RecordingSetting";
import { TerminalDetachSetting } from "@/components/tunnels/TerminalDetachSetting";
import { ShellHistorySetting } from "@/components/tunnels/ShellHistorySetting";
import { TunnelConnectionsSection } from "@/components/tunnels/TunnelConnections";
import { OverviewPanel } from "@/components/tunnels/page/OverviewPanel";
import { AccessPanel } from "@/components/tunnels/page/AccessPanel";
import { SettingsPanel } from "@/components/tunnels/page/SettingsPanel";
import { IdentityPanel } from "@/components/tunnels/page/IdentityPanel";
import { useFeatures } from "@/hooks/useFeatures";
import { useTunnelPage } from "@/hooks/useTunnelPage";
import { useTunnelDetails, type TunnelFormErrors } from "@/hooks/useTunnelDetails";
import { useLeaveTunnel, useTunnelModals } from "@/hooks/useTunnelModals";
import { useTunnelConnections } from "@/hooks/useTunnelConnections";
import { useWiderThan } from "@/hooks/useWiderThan";
import { TUNNEL_TABS, parseTunnelId, parseTunnelTab, tunnelPageUrl, type TunnelTab } from "@/lib/tunnelPage";
import { liveHealth } from "@/lib/tunnelHealth";
import { getTerminalPageUrl } from "@/lib/tunnelUrls";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import type { TunnelActionHandlers } from "@/types/tunnel";

/** 頁面至少這麼寬（rem）分頁才放左邊（同伺服器狀態頁）。/ Page width (rem) for the left rail (as on Server health). */
const RAIL_MIN_REM = 56;

const TAB_ICON: Record<TunnelTab, React.ReactNode> = {
    overview: <LayoutDashboard />,
    connection: <Route />,
    device: <Cpu />,
    identity: <KeyRound />,
    access: <Users />,
    sessions: <UserCheck />,
    history: <Activity />,
    settings: <Settings />,
};

/** 欄位在哪一頁：後端擋下時跳過去。/ Which tab a field lives on, to jump there on a rejection. */
const FIELD_TAB: Record<keyof TunnelFormErrors, TunnelTab> = { host_friendly_name: "settings", description: "settings", labels: "settings", key: "identity" };

export function TunnelPageView() {
    const { t } = useI18n();
    const { has } = useFeatures();
    const router = useRouter();
    const searchParams = useSearchParams();
    const params = useParams<{ id: string }>();
    const id = parseTunnelId(params?.id);
    const tab = parseTunnelTab(searchParams.get("tab"));
    const page = useTunnelPage(id);
    const reload = () => void page.reload();
    const form = useTunnelDetails(page.state === "ok" ? id : null, reload);
    const modals = useTunnelModals();
    const leave = useLeaveTunnel(() => router.push("/tunnels"));
    const connections = useTunnelConnections(id, tab === "history");
    // 量外框（每個狀態都在），不是分頁格（載入後才出現，量不到）。/ Measure the shell, present in every state.
    const shellRef = useRef<HTMLDivElement>(null);
    const wide = useWiderThan(shellRef, RAIL_MIN_REM);

    const setTab = (next: TunnelTab) => {
        if (!id) return;
        router.replace(tunnelPageUrl(id, next), { scroll: false });
    };

    const tunnel = page.tunnel;
    if (!id || page.state === "missing" || (page.state === "error" && !tunnel)) {
        return (
            <div ref={shellRef} className="space-y-6">
                <PageHeader icon={<Server />} title={t(page.state === "error" ? "tunnelPage.failedTitle" : "tunnelPage.missingTitle")} />
                <Callout tone={page.state === "error" ? "danger" : "info"}>{t(page.state === "error" ? "tunnelPage.failed" : "tunnelPage.missing")}</Callout>
                <Button asChild variant="outline">
                    <Link href="/tunnels">
                        <ArrowLeft size={15} /> {t("tunnelPage.backToList")}
                    </Link>
                </Button>
            </div>
        );
    }
    if (!tunnel) {
        return (
            <div ref={shellRef}>
                <p className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
                    <Loader2 size={16} className="animate-spin" /> {t("common.loading")}
                </p>
            </div>
        );
    }

    const health = liveHealth(tunnel, page.online);
    const manager = tunnel.is_owner || tunnel.can_share;
    const role = form.state.details?.user_permission ?? (tunnel.is_owner ? "owner" : tunnel.can_share ? "admin" : tunnel.can_edit ? "edit" : "view");
    const showDevice = !!tunnel.endpoint;
    const active: TunnelTab = tab === "device" && !showDevice ? "overview" : tab;
    const { errors, basicsDirty, keyChanged } = form.state;
    const basicsError = !!(errors.host_friendly_name || errors.description || errors.labels);

    const tabs = TUNNEL_TABS.filter((v) => v !== "device" || showDevice).map((v) => {
        const mark =
            v === "settings" ? (basicsError ? "error" : basicsDirty ? "dirty" : null) : v === "identity" ? (errors.key || tunnel.host_key_changed || tunnel.device_claimed ? "error" : keyChanged ? "dirty" : null) : null;
        return {
            value: v,
            label: mark ? <NavTabLabel label={t(`tunnelPage.tab.${v}` as TranslationKey)} mark={mark} /> : t(`tunnelPage.tab.${v}` as TranslationKey),
            hint: t(`tunnelPage.tabHint.${v}` as TranslationKey),
            icon: TAB_ICON[v],
        };
    });

    const save = async () => {
        const rejected = await form.actions.save();
        if (!rejected) return;
        const tabsWithErrors = (Object.keys(rejected) as (keyof TunnelFormErrors)[]).map((f) => FIELD_TAB[f]);
        if (tabsWithErrors.length && !tabsWithErrors.includes(active)) setTab(tabsWithErrors[0]);
    };

    // 標題列的快速入口選單：通道頁面的項目在這裡直接換分頁。/ The header's quick menu: page items switch tabs here.
    const actions: TunnelActionHandlers = {
        onDetails: (_id, next) => setTab(next ?? "overview"),
        onConfig: () => modals.setConfigModal({ isOpen: true, tunnelId: tunnel.id }),
        onScript: () => modals.setScriptModal({ isOpen: true, tunnelId: tunnel.id, sshPort: 22 }),
        onLogs: () => router.push(`/tunnels/logs?tunnel=${tunnel.id}`),
        onKeys: () => router.push(`/tunnels/keys/devices?device=${tunnel.id}`),
        onCommands: () => router.push(`/tunnels/cheatsheet?tunnel=${tunnel.id}`),
        onNetwork: () => router.push(`/tunnels/network?tunnel=${tunnel.id}`),
        onDesktop: () => router.push(`/tunnels/desktop?tunnel=${tunnel.id}`),
        onUsers: (_id, readOnly) => modals.setUsersModal({ isOpen: true, tunnelId: tunnel.id, readOnly }),
        onShare: () => modals.setShareModal({ isOpen: true, tunnelId: tunnel.id }),
        onRequestAccess: () => modals.setRequestModal({ isOpen: true, tunnelId: tunnel.id }),
        onToolbox: () => router.push(`${getTerminalPageUrl(tunnel)}&toolbox=1`),
        onLeave: () => modals.setLeaveConfirm({ isOpen: true, tunnelId: tunnel.id, name: tunnel.host_friendly_name }),
        onDelete: () => modals.setDeleteConfirm({ isOpen: true, tunnelId: tunnel.id, name: tunnel.host_friendly_name }),
    };

    return (
        <div ref={shellRef} className="space-y-6">
            <PageHeader
                icon={<Server />}
                title={tunnel.host_friendly_name}
                titleAddon={<TunnelStatusPill health={health} lastSeenAt={tunnel.last_seen_at} />}
                description={tunnel.description || undefined}
                actions={
                    <>
                        <Button asChild variant="outline">
                            <Link href="/tunnels">
                                <ArrowLeft size={15} /> {t("tunnelPage.backToList")}
                            </Link>
                        </Button>
                        <TunnelActions tunnel={tunnel} {...actions} />
                    </>
                }
            />

            <SectionOutlineProvider>
            <div className={cn("grid", wide ? "grid-cols-[15rem_minmax(0,1fr)] items-start gap-6" : "gap-4")}>
                {/* 不夠寬是一列可橫捲的分頁，夠寬是黏在左側的一欄；左欄下面列出這個分頁有哪幾塊，捲到哪塊標哪塊。
                    A scrolling row when narrow, a sticky left rail when wide; under the rail, the blocks of this tab, the one in view marked. */}
                <div className={cn("min-w-0", wide ? "sticky top-20 -mx-1 max-h-[calc(100dvh-6rem)] space-y-4 overflow-y-auto px-1 pb-1" : "-mx-1 overflow-x-auto px-1 pb-0.5")}>
                    <NavTabs tabs={tabs} value={active} onChange={setTab} aria-label={tunnel.host_friendly_name} className={wide ? "sm:flex-col" : "sm:min-w-max sm:flex-row [&_span]:whitespace-nowrap"} />
                    {wide && <SectionOutline key={active} label={t("tunnelPage.outline")} />}
                </div>

                {/* 每一塊是一張卡片（標題列 + 細線 + 內容），一頁有幾塊一眼看得出來。/ Every block is a card, so a tab's blocks read apart. */}
                <SectionPanels>
                <div role="tabpanel" className="min-w-0">
                    {active === "overview" && (
                        <OverviewPanel
                            tunnel={tunnel}
                            health={health}
                            online={page.online}
                            latency={page.latency}
                            onTab={setTab}
                            onConfig={actions.onConfig.bind(null, tunnel.id)}
                            onShare={actions.onShare.bind(null, tunnel.id)}
                        />
                    )}
                    {active === "connection" && (
                        <div className="space-y-6">
                            <ConnectionTab tunnel={tunnel} active manager={manager} onChanged={reload} />
                            {/* 重新安裝：在裝置上跑的腳本（擁有者 / Admin）。/ Reinstalling: the device-side scripts (owner / Admin). */}
                            {manager && (
                                <Section icon={<Rocket />} title={t("tunnelActions.installScript")} description={t("tunnelPage.scriptHint")}>
                                    <div>
                                        <Button type="button" variant="outline" className="h-auto min-h-9 max-w-full py-1.5 whitespace-normal" onClick={() => actions.onScript(tunnel.id)}>
                                            <Rocket size={15} /> {t("tunnelPage.scriptOpen")}
                                        </Button>
                                    </div>
                                </Section>
                            )}
                        </div>
                    )}
                    {active === "device" && <DeviceFactsSection tunnelId={tunnel.id} isOpen endpoint={tunnel.endpoint} deviceName={tunnel.host_friendly_name} canRefresh={manager} />}
                    {active === "identity" && <IdentityPanel tunnelId={tunnel.id} form={form} onSave={() => void save()} onChanged={reload} />}
                    {active === "access" && (
                        <AccessPanel
                            tunnel={tunnel}
                            role={role}
                            manager={manager}
                            onShare={() => actions.onShare(tunnel.id)}
                            onUsers={(readOnly) => actions.onUsers(tunnel.id, readOnly)}
                            onRequestAccess={() => actions.onRequestAccess?.(tunnel.id)}
                        />
                    )}
                    {active === "sessions" && (
                        <div className="space-y-6">
                            <StepUpSetting tunnelId={tunnel.id} required={!!tunnel.require_step_up} canManage={manager} onChanged={reload} />
                            {has("recordings.manage") && <RecordingSetting tunnelId={tunnel.id} enabled={!!tunnel.record_sessions} canManage={manager} onChanged={reload} />}
                            <TerminalDetachSetting tunnelId={tunnel.id} policy={tunnel.terminal_detach_policy} canManage={manager} onChanged={reload} />
                            {/* 只影響自己：這條通道上打的指令寫不寫進裝置的歷史檔。/ Just for you: this tunnel's shell history choice. */}
                            {has("terminal") && <ShellHistorySetting tunnelId={tunnel.id} />}
                        </div>
                    )}
                    {active === "history" && (
                        <div className="space-y-6">
                            <TunnelConnectionsSection data={connections.data} failed={connections.failed} />
                            <Section icon={<History />} title={t("tunnelPage.historyMore")} description={t("tunnelPage.historyMoreHint")}>
                            <div className="flex flex-wrap gap-2">
                                <Button asChild variant="outline">
                                    <Link href={`/tunnels/logs?tunnel=${tunnel.id}`} prefetch={false}>{t("tunnelActions.logs")}</Link>
                                </Button>
                                <Button asChild variant="outline">
                                    <Link href={`/tunnels/sessions?tunnel=${tunnel.id}`} prefetch={false}>{t("tunnelPage.quick.sessions")}</Link>
                                </Button>
                                {tunnel.record_sessions && has("recordings.manage") && (
                                    <Button asChild variant="outline">
                                        <Link href={`/tunnels/recordings?tunnel=${tunnel.id}`} prefetch={false}>{t("recordings.menu")}</Link>
                                    </Button>
                                )}
                                {has("command_rules.manage") && (
                                    <Button asChild variant="outline">
                                        <Link href={`/tunnels/commands?tunnel=${tunnel.id}&tab=history`} prefetch={false}>{t("tunnelPage.commandHistory")}</Link>
                                    </Button>
                                )}
                            </div>
                            </Section>
                        </div>
                    )}
                    {active === "settings" && (
                        <SettingsPanel tunnel={tunnel} form={form} onSave={() => void save()} onLeave={() => actions.onLeave(tunnel.id, tunnel.host_friendly_name)} onDelete={() => actions.onDelete(tunnel.id, tunnel.host_friendly_name)} />
                    )}
                </div>
                </SectionPanels>
            </div>
            </SectionOutlineProvider>

            <TunnelModals modals={modals} tunnels={[tunnel]} fetchData={reload} onDeleted={() => router.push("/tunnels")} handleLeaveTunnel={(tid, name) => void leave(tid, name)} />
            {form.state.reauthDialog}
        </div>
    );
}
