"use client";

/**
 * 通道列表頁：統計兼篩選方塊、搜尋、卡片 / 清單檢視、WebSocket 即時狀態、動作選單與彈窗。
 * Tunnels list page: stat/filter tiles, search, card / list views, live WebSocket status, actions menu and modals.
 */
import React, { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TunnelModals } from "@/components/tunnels/TunnelModals";
import { PageHeader } from "@/components/layout/PageHeader";
import { Plus, Network, Info, RefreshCw, SearchX, FolderTree, FolderPlus, FileCode2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { TunnelCard } from "@/components/tunnels/TunnelCard";
import { TunnelTableRow } from "@/components/tunnels/TunnelTableRow";
import { TunnelFilterTiles, type TunnelFilter } from "@/components/tunnels/TunnelFilterTiles";
import { TunnelSearchBar } from "@/components/tunnels/TunnelSearchBar";
import { ViewToggle } from "@/components/ui/ViewToggle";
import { Segmented } from "@/components/ui/segmented";
import { EmptyGroup, GroupHeader, GroupHeaderRow, type GroupHeaderProps } from "@/components/tunnels/TunnelGroupSection";
import { TunnelGroupDialogs } from "@/components/tunnels/TunnelGroupDialogs";
import { BulkConfigModal } from "@/components/sshconfig/BulkConfigModal";
import { sectionKey, useTunnelGroupsUi } from "@/hooks/useTunnelGroupsUi";
import { groupOf, groupSections, TUNNEL_GROUPING_KEY, TUNNEL_GROUPINGS, type Section } from "@/lib/groups";

import { useTunnelsPage } from "@/hooks/useTunnelsPage";
import { useViewMode } from "@/hooks/useViewMode";
import { useStoredChoice } from "@/hooks/useStoredChoice";
import { liveHealth } from "@/lib/tunnelHealth";
import { compareTunnels, matchTunnel, parseQuery, pinnedFirst, TUNNEL_SORTS, type MatchContext } from "@/lib/tunnelQuery";
import { useI18n } from "@/lib/i18n";
import { useFeatures } from "@/hooks/useFeatures";
import { Tunnel, TunnelActionHandlers } from "@/types/tunnel";
import { getTerminalPageUrl } from "@/lib/tunnelUrls";
import { Pagination } from "@/components/ui/pagination";
import { usePagination, useSectionPages } from "@/hooks/usePagination";
import { CARD_PAGE_SIZES, pageSlice } from "@/lib/pagination";

const TH = "px-4 py-2.5 text-left text-xs text-muted-foreground whitespace-nowrap";
/** 依群組分段或一個列表（有群組時才有這個選擇）。/ Sections by group or one list (offered once groups exist). */

export default function TunnelsPage() {
    const { t } = useI18n();
    // 「建立隧道」被管理員關掉就不放按鈕。/ No create buttons when creating tunnels is turned off.
    const canCreate = useFeatures().has("tunnels.create");
    const router = useRouter();
    const {
        tunnels,
        portsMap,
        latencyMap,
        loading,
        fetchData,
        togglePin,
        handleLeaveTunnel,
        modals: {
            configModal, setConfigModal,
            scriptModal, setScriptModal,
            usersModal, setUsersModal,
            detailsModal, setDetailsModal,
            shareModal, setShareModal,
            requestModal, setRequestModal,
            deleteConfirm, setDeleteConfirm,
            leaveConfirm, setLeaveConfirm
        }
    } = useTunnelsPage();

    const [viewMode, setViewMode] = useViewMode("tunnels-view");
    const [filter, setFilter] = useState<TunnelFilter>("all");
    const [query, setQuery] = useState("");
    // 多台的 SSH config（標題列按鈕）。/ The bulk SSH config (header button).
    const [bulkConfigOpen, setBulkConfigOpen] = useState(false);

    const isOnline = (tunnel: Tunnel) => portsMap[String(tunnel.reverse_port)] === true;
    // 我的通道群組（每個人自己的資料夾）。/ My tunnel groups (personal folders).
    const groupsUi = useTunnelGroupsUi(tunnels, isOnline);
    const [grouping, setGrouping] = useStoredChoice(TUNNEL_GROUPING_KEY, TUNNEL_GROUPINGS, "groups");
    const groupNames = useMemo(() => {
        const names = new Map(groupsUi.groups.map((g) => [g.id, g.name]));
        const of = groupOf(groupsUi.groups);
        return (tn: Tunnel) => {
            const id = of.get(tn.id);
            return id === undefined ? null : (names.get(id) ?? null);
        };
    }, [groupsUi.groups]);

    const counts = useMemo(() => {
        const online = tunnels.filter(tn => portsMap[String(tn.reverse_port)] === true).length;
        return {
            all: tunnels.length,
            online,
            offline: tunnels.length - online,
            shared: tunnels.filter(tn => !tn.is_owner).length,
        };
    }, [tunnels, portsMap]);

    const [sort, setSort] = useStoredChoice("telepy.tunnelSort", TUNNEL_SORTS, "name");
    const parsed = useMemo(() => parseQuery(query), [query]);

    // 方塊篩選 AND 搜尋語法（lib/tunnelQuery），再依選的方式排序。/ Tile filter AND the query, then sorted.
    const visible = useMemo(() => {
        const now = Date.now();
        const ctx = (tn: Tunnel): MatchContext => ({ health: liveHealth(tn, isOnline(tn)), now, group: groupNames(tn) });
        return tunnels
            .filter((tn) => {
                const online = isOnline(tn);
                if (filter === "online" && !online) return false;
                if (filter === "offline" && online) return false;
                if (filter === "shared" && tn.is_owner) return false;
                return matchTunnel(tn, parsed, ctx(tn));
            })
            .sort((a, b) => pinnedFirst(a, b) || compareTunnels(a, b, sort, ctx));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tunnels, portsMap, filter, parsed, sort, groupNames]);

    // 有群組時依群組分段（搜尋 / 篩選中只留有符合的段）。/ Sections by group once groups exist.
    const filtering = filter !== "all" || query.trim() !== "";
    const grouped = grouping === "groups" && groupsUi.groups.length > 0;
    const sections = useMemo(() => groupSections(visible, tunnels, groupsUi.groups, filtering), [visible, tunnels, groupsUi.groups, filtering]);
    // 分頁：搜尋 / 篩選 / 排序對全部通道做完再分頁；分段時每段各自分頁（段標題都在），條件一變回第 1 頁。
    // 每頁 12 / 24 / 48 / 96 張，卡片格（1–4 欄）每頁都排滿整列；選擇記在 localStorage `telepy.tunnelsPageSize`。
    // Pages: search / filter / sort run over every tunnel first; with sections each one pages on its own (every
    // header stays), and any change goes back to page 1. 12 / 24 / 48 / 96 per page fill whole rows of the 1–4
    // column card grid; the choice is kept in localStorage `telepy.tunnelsPageSize`.
    const listTop = useRef<HTMLDivElement>(null);
    const pageKey = `${query}|${filter}|${sort}|${grouping}`;
    const pager = usePagination(visible.length, { storageKey: "telepy.tunnelsPageSize", resetKey: pageKey, sizes: CARD_PAGE_SIZES });
    const sectionPages = useSectionPages({ storageKey: "telepy.tunnelsPageSize", resetKey: pageKey, sizes: CARD_PAGE_SIZES });
    const flatItems = pageSlice(visible, pager.page, pager.size);
    const sectionPage = (s: Section<Tunnel>) => {
        const pg = sectionPages.pager(sectionKey(s.group), s.items.length);
        return { pg, items: pageSlice(s.items, pg.page, pg.size) };
    };
    const headerProps = (s: Section<Tunnel>): GroupHeaderProps => ({
        id: `tunnels-sec-${sectionKey(s.group)}`,
        group: s.group,
        shown: s.items.length,
        total: s.total,
        online: tunnels.filter((tn) => (s.group ? s.group.tunnel_ids.includes(tn.id) : !groupOf(groupsUi.groups).has(tn.id)) && isOnline(tn)).length,
        filtering,
        collapsed: groupsUi.collapsed.has(sectionKey(s.group)),
        onToggle: () => groupsUi.toggleSection(sectionKey(s.group)),
        isFirst: !!s.group && groupsUi.orderedIds[0] === s.group.id,
        isLast: !!s.group && groupsUi.orderedIds[groupsUi.orderedIds.length - 1] === s.group.id,
        onEdit: s.group ? () => groupsUi.openEdit(s.group!) : undefined,
        onMove: s.group ? (delta) => groupsUi.moveGroup(s.group!, delta) : undefined,
        onDelete: s.group ? () => void groupsUi.requestDelete(s.group!) : undefined,
    });

    const actions: TunnelActionHandlers = {
        onDetails: (tunnelId, tab) => setDetailsModal({ isOpen: true, tunnelId, tab }),
        onConfig: (tunnelId) => setConfigModal({ isOpen: true, tunnelId }),
        onScript: (tunnelId) => setScriptModal({ isOpen: true, tunnelId, sshPort: 22 }),
        onLogs: (tunnelId) => router.push(`/tunnels/logs?tunnel=${tunnelId}`),
        onKeys: (tunnelId) => router.push(`/tunnels/keys/devices?device=${tunnelId}`),
        onCommands: (tunnelId) => router.push(`/tunnels/cheatsheet?tunnel=${tunnelId}`),
        onNetwork: (tunnelId) => router.push(`/tunnels/network?tunnel=${tunnelId}`),
        onDesktop: (tunnelId) => router.push(`/tunnels/desktop?tunnel=${tunnelId}`),
        onUsers: (tunnelId, readOnly) => setUsersModal({ isOpen: true, tunnelId, readOnly }),
        onShare: (tunnelId) => setShareModal({ isOpen: true, tunnelId }),
        onRequestAccess: (tunnelId) => setRequestModal({ isOpen: true, tunnelId }),
        onRecordings: (tunnelId) => router.push(`/tunnels/recordings?tunnel=${tunnelId}`),
        onCommandRules: (tunnelId) => router.push(`/tunnels/commands?tunnel=${tunnelId}`),
        onToolbox: (tunnelId) => {
            const tn = tunnels.find((x) => x.id === tunnelId);
            router.push(`${tn ? getTerminalPageUrl(tn) : `/tunnels/terminal?serverId=${tunnelId}`}&toolbox=1`);
        },
        onLeave: (tunnelId, name) => setLeaveConfirm({ isOpen: true, tunnelId, name }),
        onDelete: (tunnelId, name) => setDeleteConfirm({ isOpen: true, tunnelId, name }),
        onTogglePin: (tunnelId, pinned) => void togglePin(tunnelId, pinned),
        // 點標籤：把 label:x 加進搜尋（已經有就不重複）。/ Clicking a label adds label:x to the search.
        onLabel: (label) => setQuery((q) => (q.split(/\s+/).includes(`label:${label}`) ? q : `${q.trim()} label:${label}`.trim())),
        onMoveToGroup: (tunnelId) => groupsUi.openMove(tunnelId),
    };

    const card = (tunnel: Tunnel) => (
        <TunnelCard
            key={tunnel.id}
            tunnel={tunnel}
            isActive={isOnline(tunnel)}
            latencyMs={latencyMap[String(tunnel.reverse_port)] ?? null}
            sharedCount={tunnel.shared_with_count ?? 0}
            {...actions}
        />
    );
    const row = (tunnel: Tunnel) => (
        <TunnelTableRow
            key={tunnel.id}
            tunnel={tunnel}
            isActive={isOnline(tunnel)}
            latencyMs={latencyMap[String(tunnel.reverse_port)] ?? null}
            sharedCount={tunnel.shared_with_count ?? 0}
            {...actions}
        />
    );
    const CARD_GRID = "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-5";

    const clearFilters = () => {
        setFilter("all");
        setQuery("");
    };

    return (
        <div className="space-y-6 animate-fade-in-up">
            {/* 標題列 / Page header */}
            <PageHeader
                icon={<Network />}
                title={t("tunnels.title")}
                titleAddon={
                    <TooltipProvider delayDuration={100}>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button className="text-muted-foreground hover:text-primary transition-colors focus:outline-none" aria-label={t("tunnels.aboutAria")}>
                                    <Info size={18} />
                                </button>
                            </TooltipTrigger>
                            <TooltipContent side="right" className="max-w-xs text-sm" sideOffset={8}>
                                <p>{t("tunnels.aboutTooltip")}</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                }
                description={t("tunnels.subtitle")}
                actions={
                    <>
                        <Button variant="outline" onClick={fetchData} disabled={loading} aria-label={t("tunnels.refreshAria")}>
                            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
                            {t("common.refresh")}
                        </Button>
                        {tunnels.length > 0 && (
                            <Button variant="outline" onClick={() => setBulkConfigOpen(true)} title={t("config.bulk.openHint")}>
                                <FileCode2 size={16} />
                                {t("config.bulk.open")}
                            </Button>
                        )}
                        {canCreate && (
                            <Button asChild>
                                <Link href="/tunnels/create" prefetch={false}>
                                    <Plus size={16} />
                                    {t("tunnels.create")}
                                </Link>
                            </Button>
                        )}
                    </>
                }
            />

            {loading && tunnels.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-12 text-muted-foreground">
                    <div className="mb-4 size-8 animate-spin rounded-full border-2 border-border border-t-primary" aria-hidden></div>
                    {t("tunnels.loading")}
                </div>
            ) : tunnels.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-input bg-card p-16 text-center">
                    <div className="mb-5 grid size-12 place-items-center rounded-lg border border-border bg-surface text-muted-foreground" aria-hidden>
                        <Network size={22} />
                    </div>
                    <h3 className="text-lg text-foreground tracking-tight">{t("tunnels.emptyTitle")}</h3>
                    <p className="mt-2 text-sm text-muted-foreground max-w-sm">{canCreate ? t("tunnels.emptyBody") : t("access.emptyNoCreate")}</p>
                    {canCreate && (
                        <div className="mt-6">
                            <Button asChild>
                                <Link href="/tunnels/create" prefetch={false}>
                                    <Plus size={16} />
                                    {t("tunnels.new")}
                                </Link>
                            </Button>
                        </div>
                    )}
                </div>
            ) : (
                <>
                    <TunnelFilterTiles counts={counts} value={filter} onChange={setFilter} />

                    {/* 搜尋（含篩選語法）+ 排序 + 檢視切換 / Search (with filter syntax) + sort + view toggle */}
                    <TunnelSearchBar
                        query={query}
                        onQueryChange={setQuery}
                        invalid={parsed.invalid}
                        sort={sort}
                        onSortChange={setSort}
                        shown={visible.length}
                        total={tunnels.length}
                        groupControls={
                            <>
                                <Button variant="outline" size="sm" className="h-9" onClick={groupsUi.openManage} aria-label={t("groups.tunnel.manageAria")}>
                                    <FolderTree size={15} />
                                    {t("groups.tunnel.manage")}
                                </Button>
                                {/* 先用搜尋 / 篩選挑出一批（所有頁，不只這一頁），再一次建成群組。/ Filter first, then group every result (all pages). */}
                                {filtering && visible.length > 0 && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-9 text-primary hover:text-primary"
                                        onClick={() => groupsUi.openNew(visible.map((tn) => tn.id))}
                                        title={t("groups.tunnel.fromShownHint")}
                                    >
                                        <FolderPlus size={15} />
                                        {t("groups.tunnel.fromShown", { count: visible.length })}
                                    </Button>
                                )}
                                {groupsUi.groups.length > 0 && (
                                    <Segmented
                                        size="sm"
                                        value={grouping}
                                        onChange={setGrouping}
                                        aria-label={t("groups.tunnel.view")}
                                        options={[
                                            { value: "groups", label: t("groups.tunnel.viewGrouped") },
                                            { value: "flat", label: t("groups.tunnel.viewFlat") },
                                        ]}
                                    />
                                )}
                            </>
                        }
                        viewToggle={
                            <div className="hidden min-[1200px]:flex items-center">
                                <ViewToggle value={viewMode} onChange={setViewMode} storageKey="tunnels-view" />
                            </div>
                        }
                    />

                    {visible.length === 0 ? (
                        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-input bg-card p-12 text-center">
                            <SearchX size={32} className="text-muted-foreground/60" aria-hidden />
                            <p className="text-sm text-muted-foreground">{t("tunnels.noMatch")}</p>
                            <Button variant="outline" size="sm" onClick={clearFilters}>{t("tunnels.clearFilters")}</Button>
                        </div>
                    ) : grouped && viewMode === "card" ? (
                        <div className="space-y-6">
                            {sections.map((sec) => {
                                const h = headerProps(sec);
                                const { pg, items } = sectionPage(sec);
                                return (
                                    <section key={sectionKey(sec.group)} className="space-y-3">
                                        <GroupHeader {...h} />
                                        {!h.collapsed &&
                                            (sec.items.length > 0 ? (
                                                <>
                                                    <div className={CARD_GRID}>{items.map(card)}</div>
                                                    <Pagination pager={pg} anchor={() => document.getElementById(h.id!)} />
                                                </>
                                            ) : (
                                                <EmptyGroup />
                                            ))}
                                    </section>
                                );
                            })}
                        </div>
                    ) : viewMode === "card" ? (
                        <div ref={listTop} className="scroll-mt-20 space-y-4">
                            <div className={CARD_GRID}>{flatItems.map(card)}</div>
                            <Pagination pager={pager} anchor={listTop} />
                        </div>
                    ) : (
                        <div ref={listTop} className="scroll-mt-20 space-y-4">
                            <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-card">
                                <table className="min-w-full divide-y divide-border">
                                    <thead className="bg-surface">
                                        <tr>
                                            <th scope="col" className={TH}>{t("tunnels.thName")}</th>
                                            <th scope="col" className={TH}>{t("tunnels.thStatus")}</th>
                                            <th scope="col" className={TH}>{t("tunnels.thPort")}</th>
                                            <th scope="col" className={TH}>{t("tunnels.thAccess")}</th>
                                            <th scope="col" className={`${TH} text-right`}>{t("tunnels.thActions")}</th>
                                        </tr>
                                    </thead>
                                    {grouped ? (
                                        sections.map((sec) => {
                                            const h = headerProps(sec);
                                            const { pg, items } = sectionPage(sec);
                                            return (
                                                <tbody key={sectionKey(sec.group)} className="divide-y divide-border border-t border-border">
                                                    <GroupHeaderRow colSpan={5} {...h} />
                                                    {!h.collapsed &&
                                                        (sec.items.length > 0 ? (
                                                            <>
                                                                {items.map(row)}
                                                                {sec.items.length > pg.sizes[0] && (
                                                                    <tr>
                                                                        <td colSpan={5} className="px-4 py-2">
                                                                            <Pagination pager={pg} anchor={() => document.getElementById(h.id!)} />
                                                                        </td>
                                                                    </tr>
                                                                )}
                                                            </>
                                                        ) : (
                                                            <tr>
                                                                <td colSpan={5} className="px-4 py-3 text-center text-sm text-muted-foreground">{t("groups.tunnel.emptySection")}</td>
                                                            </tr>
                                                        ))}
                                                </tbody>
                                            );
                                        })
                                    ) : (
                                        <tbody className="divide-y divide-border">{flatItems.map(row)}</tbody>
                                    )}
                                </table>
                            </div>
                            {!grouped && <Pagination pager={pager} anchor={listTop} />}
                        </div>
                    )}
                </>
            )}

            <TunnelModals
                modals={{
                    configModal, setConfigModal,
                    scriptModal, setScriptModal,
                    usersModal, setUsersModal,
                    detailsModal, setDetailsModal,
                    shareModal, setShareModal,
                    requestModal, setRequestModal,
                    deleteConfirm, setDeleteConfirm,
                    leaveConfirm, setLeaveConfirm
                }}
                tunnels={tunnels}
                fetchData={fetchData}
                handleLeaveTunnel={handleLeaveTunnel}
                onBulkConfig={() => setBulkConfigOpen(true)}
            />
            <TunnelGroupDialogs ui={groupsUi} tunnels={tunnels} health={(tn) => liveHealth(tn, isOnline(tn))} />
            {bulkConfigOpen && (
                <BulkConfigModal
                    onClose={() => setBulkConfigOpen(false)}
                    tunnels={tunnels}
                    health={(tn) => liveHealth(tn, isOnline(tn))}
                    groups={groupsUi.groups}
                    shownIds={filtering ? visible.map((tn) => tn.id) : null}
                />
            )}
        </div>
    );
}
