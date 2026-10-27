"use client";

/**
 * 多台裝置的 SSH config：一個 ~/.ssh/config 放勾選的每一台，`ssh <裝置名稱>` 各自連得到。上方路線圖（伺服器區塊 ①
 * 只寫一次、每台一個區塊 ②），下面四步——挑裝置（全部 / 在線 / 通道頁篩出來的 / 群組）→ 一行指令或手動貼上 →
 * 我的金鑰在每台的狀態（可一鍵補上）→ 連線。帳號模式（每台一個 / 每個帳號一個）與傳輸方式放在固定的工具列。
 * The SSH config for several devices: one ~/.ssh/config with every ticked device, so `ssh <device name>` reaches
 * each. A route map (block ① once, one block ② per device), then four steps — pick devices (all / online / what the
 * tunnels page shows / a group) → one command or by hand → my keys on each device (with one-click add) → connect.
 * The accounts mode and the transport sit in the fixed toolbar.
 */
import React, { useMemo, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, FileCode2, KeyRound, Loader2, Search } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { NativeSelect } from "@/components/ui/native-select";
import { MiniCommand } from "@/components/cheatsheet/CommandView";
import { StatusDot } from "@/components/tunnels/TunnelStatus";
import { ConfigRouteMap, type ConfigPart } from "./ConfigRouteMap";
import { SshConfigInstall } from "./SshConfigInstall";
import { CheckRow, Step, ToolbarField } from "./ConfigSteps";
import { TransportInfoDialog } from "./TransportInfoDialog";
import { useBulkConfig } from "@/hooks/useBulkConfig";
import { useFeatures } from "@/hooks/useFeatures";
import { countAccess, deviceAccess, initialSelection, keysToAdd, pickStanzas, type DeviceAccess } from "@/lib/bulkSshConfig";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import type { TunnelGroup } from "@/types/groups";
import type { Tunnel, TunnelHealth } from "@/types/tunnel";

/** 這麼多台以上才有搜尋。/ Search from this many devices on. */
const SEARCH_FROM = 7;
/** 沒搜尋時先列幾台。/ Rows shown before "show all". */
const COLLAPSE_AT = 8;
/** 名單類的提示先列幾個名字。/ Names listed in a note before "and N more". */
const NAMES_SHOWN = 5;

const ACCESS_CHIP: Record<DeviceAccess, { tone?: "success" | "warning" | "danger"; key: TranslationKey } | null> = {
    ready: { tone: "success", key: "config.access.installed" },
    installing: { tone: "warning", key: "config.access.pending" },
    error: { tone: "danger", key: "config.bulk.accessError" },
    missing: { key: "config.access.missing" },
    unknown: null,
};

/** 只在打開時掛載（每次打開都重抓、勾選重來）。/ Mounted only while open (every open refetches and re-picks). */
interface Props {
    onClose: () => void;
    /** 通道頁的清單（狀態點、在線與否）。/ The tunnels page's list (status dots, online). */
    tunnels: Tunnel[];
    health: (t: Tunnel) => TunnelHealth;
    /** 我的通道群組（快速勾選）。/ My tunnel groups (quick picks). */
    groups: TunnelGroup[];
    /** 通道頁有篩選時畫面上的那些；沒篩選 = null。/ What the tunnels page shows while filtered; null = unfiltered. */
    shownIds: number[] | null;
}

function names(list: string[], t: ReturnType<typeof useI18n>["t"]): string {
    const head = list.slice(0, NAMES_SHOWN).join(", ");
    return list.length > NAMES_SHOWN ? t("config.bulk.andMore", { names: head, count: list.length - NAMES_SHOWN }) : head;
}

export function BulkConfigModal({ onClose, tunnels, health, groups, shownIds }: Props) {
    const { t, tn } = useI18n();
    const { has } = useFeatures();
    const bulk = useBulkConfig();
    const { data, split } = bulk;
    // null = 還沒動過：用預設勾選（通道頁篩出來的，否則全部）；切換帳號模式不會重設。
    // null = untouched: the default pick (what the tunnels page shows, else all); switching modes keeps a choice.
    const [touched, setSelected] = useState<Set<number> | null>(null);
    const [query, setQuery] = useState("");
    const [expanded, setExpanded] = useState(false);
    const [active, setActive] = useState<ConfigPart | null>(null);
    const [transportInfo, setTransportInfo] = useState(false);

    const byId = useMemo(() => new Map(tunnels.map((x) => [x.id, x])), [tunnels]);
    const rows = useMemo(() => data?.tunnels ?? [], [data]);
    const order = useMemo(() => rows.map((r) => r.id), [rows]);
    const selected = useMemo(() => touched ?? initialSelection(order, shownIds), [touched, order, shownIds]);
    const healthOf = (id: number): TunnelHealth => {
        const tun = byId.get(id);
        return tun ? health(tun) : "never";
    };
    const isUp = (id: number) => ["online", "degraded"].includes(healthOf(id));

    const q = query.trim().toLowerCase();
    const filtered = q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.hosts.some((h) => h.alias.toLowerCase().includes(q) || h.username.toLowerCase().includes(q))) : rows;
    const collapsed = !q && !expanded && filtered.length > COLLAPSE_AT;
    const visible = collapsed ? filtered.slice(0, COLLAPSE_AT) : filtered;

    const chosen = rows.filter((r) => selected.has(r.id));
    const stanzas = split ? pickStanzas(split, order, selected) : [];
    const aliases = chosen.flatMap((r) => r.hosts.map((h) => h.alias));
    const access = new Map(chosen.map((r) => [r.id, deviceAccess(bulk.deviceMap.get(r.id), r.hosts.map((h) => h.username))]));
    const counts = countAccess([...access.values()]);
    const keyIds = (bulk.myKeys ?? []).map((k) => k.id);
    const needKeys = chosen.filter((r) => access.get(r.id) === "missing" && keysToAdd(bulk.deviceMap.get(r.id), keyIds).length > 0);
    const keyCount = bulk.myKeys?.length ?? 0;
    const accessDone = chosen.length > 0 && keyCount > 0 && counts.ready === chosen.length;

    const setMany = (ids: number[], on: boolean) =>
        setSelected((prev) => {
            const next = new Set(prev ?? selected);
            for (const id of ids) {
                if (on) next.add(id);
                else next.delete(id);
            }
            return next;
        });
    const eligible = new Set(order);
    const shownEligible = shownIds ? shownIds.filter((id) => eligible.has(id)) : [];
    const groupChoices = groups.map((g) => ({ g, ids: g.tunnel_ids.filter((id) => eligible.has(id)) })).filter((x) => x.ids.length > 0);
    const code = (s: string) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{s}</code>;
    const wsClient = data?.transport === "websocket" && data.ws_client_url ? { url: data.ws_client_url, path: data.ws_client_path, wsUrl: data.ws_url } : null;

    const accessStatus = !bulk.devicesLoaded || chosen.length === 0 ? null
        : accessDone ? <Chip tone="success"><Check />{t("config.access.ready")}</Chip>
        : <Chip tone="warning">{t("config.bulk.accessCount", { ready: counts.ready, count: chosen.length })}</Chip>;

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={t("config.bulk.title")}
            description={tn("config.bulk.subtitle", { cmd: code(t("config.bulk.cmdExample")) })}
            icon={<FileCode2 />}
            size="3xl"
            isLoading={bulk.loading && !data}
            toolbar={
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                    <ToolbarField label={t("config.bulk.accountsLabel")}>
                        <Segmented
                            size="sm"
                            fullWidth
                            aria-label={t("config.bulk.accountsLabel")}
                            value={bulk.accounts}
                            onChange={bulk.setAccounts}
                            options={[
                                { value: "default", label: t("config.bulk.accountsDefault"), title: t("config.bulk.accountsDefaultHint") },
                                { value: "all", label: t("config.bulk.accountsAll"), title: t("config.bulk.accountsAllHint") },
                            ]}
                        />
                    </ToolbarField>
                    <ToolbarField label={t("config.transportLabel")} info={{ label: t("config.ti.open"), onClick: () => setTransportInfo(true) }}>
                        <Segmented
                            size="sm"
                            fullWidth
                            aria-label={t("config.transportLabel")}
                            value={bulk.transport}
                            onChange={bulk.setTransport}
                            options={[
                                { value: "ssh", label: t("config.transportSsh") },
                                { value: "websocket", label: t("config.transportWeb") },
                            ]}
                        />
                    </ToolbarField>
                </div>
            }
        >
            {data && (
                <div className="space-y-6">
                    <div className="space-y-2.5">
                        <ConfigRouteMap
                            server={{ host: data.server.host, port: String(data.server.port) }}
                            hosts={[]}
                            deviceName=""
                            reversePort={null}
                            online={null}
                            active={active}
                            onActive={setActive}
                            many={{ count: chosen.length, online: chosen.filter((r) => isUp(r.id)).length }}
                        />
                        <p className="text-center text-sm leading-relaxed text-muted-foreground">{t("config.bulk.mapCaption")}</p>
                    </div>

                    {rows.length === 0 ? (
                        <Callout tone="warning">{t("config.bulk.none")}</Callout>
                    ) : (
                        <ol className="list-none">
                            <Step
                                n={1}
                                done={chosen.length > 0}
                                title={t("config.bulk.step.pick")}
                                status={<span className="text-xs text-muted-foreground">{t("config.bulk.selected", { count: chosen.length, total: rows.length })}</span>}
                            >
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button type="button" variant="outline" size="sm" onClick={() => setSelected(new Set(order))}>
                                        {t("config.bulk.pickAll", { count: rows.length })}
                                    </Button>
                                    <Button type="button" variant="outline" size="sm" onClick={() => setSelected(new Set(order.filter(isUp)))}>
                                        {t("config.bulk.pickOnline", { count: order.filter(isUp).length })}
                                    </Button>
                                    {shownIds && shownEligible.length > 0 && shownEligible.length < rows.length && (
                                        <Button type="button" variant="outline" size="sm" onClick={() => setSelected(new Set(shownEligible))}>
                                            {t("config.bulk.pickShown", { count: shownEligible.length })}
                                        </Button>
                                    )}
                                    {groupChoices.length > 0 && (
                                        <NativeSelect
                                            className="h-8 w-auto min-w-40 text-sm"
                                            aria-label={t("config.bulk.pickGroup")}
                                            value=""
                                            onChange={(e) => {
                                                const g = groupChoices.find((x) => String(x.g.id) === e.target.value);
                                                if (g) setMany(g.ids, true);
                                            }}
                                        >
                                            <option value="">{t("config.bulk.pickGroup")}</option>
                                            {groupChoices.map(({ g, ids }) => (
                                                <option key={g.id} value={String(g.id)}>{`${g.name} (${ids.length})`}</option>
                                            ))}
                                        </NativeSelect>
                                    )}
                                    {chosen.length > 0 && (
                                        <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                                            {t("config.bulk.pickNone")}
                                        </Button>
                                    )}
                                </div>
                                {rows.length >= SEARCH_FROM && (
                                    <div className="relative">
                                        <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                                        <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("config.bulk.search")} aria-label={t("config.bulk.search")} className="h-8 pl-8" />
                                    </div>
                                )}
                                <ul className="divide-y divide-border/70 rounded-lg bg-surface ring-1 ring-inset ring-border/70">
                                    {visible.map((r) => {
                                        const a = access.get(r.id) ?? "unknown";
                                        const chip = bulk.devicesLoaded && keyCount > 0 && selected.has(r.id) ? ACCESS_CHIP[a] : null;
                                        const chipText = chip && t(a === "installing" && !isUp(r.id) ? "config.access.waitingOnline" : chip.key);
                                        return (
                                            <li key={r.id}>
                                                <label className="flex min-w-0 cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-muted/40">
                                                    <input type="checkbox" checked={selected.has(r.id)} onChange={(e) => setMany([r.id], e.target.checked)} className="size-4 shrink-0 accent-primary" />
                                                    <StatusDot health={healthOf(r.id)} />
                                                    <span className="min-w-0 flex-1">
                                                        <span className="block truncate text-foreground" title={r.name}>{r.name}</span>
                                                        {/* 手機上別名換行、狀態放在下面，名字才不會被擠成「…」。/ Phones: aliases wrap, the chip goes below. */}
                                                        <span className="block font-mono text-xs text-muted-foreground [overflow-wrap:anywhere] sm:truncate" title={r.hosts.map((h) => `ssh ${h.alias} (${h.username})`).join("\n")}>
                                                            {r.hosts.map((h) => `${h.alias} → ${h.username}`).join(" · ")}
                                                        </span>
                                                        {chip && (
                                                            <span className="mt-1 block sm:hidden">
                                                                <Chip tone={chip.tone} className="h-auto max-w-full whitespace-normal py-0.5 text-left">{chipText}</Chip>
                                                            </span>
                                                        )}
                                                    </span>
                                                    {chip && (
                                                        <span className="hidden shrink-0 sm:block">
                                                            <Chip tone={chip.tone}>{chipText}</Chip>
                                                        </span>
                                                    )}
                                                </label>
                                            </li>
                                        );
                                    })}
                                </ul>
                                {filtered.length === 0 && <p className="py-2 text-center text-sm text-muted-foreground">{t("config.bulk.noMatch")}</p>}
                                {collapsed && (
                                    <Button type="button" variant="ghost" size="sm" className="w-full text-primary hover:text-primary" onClick={() => setExpanded(true)}>
                                        <ChevronDown /> {t("config.bulk.showAll", { count: filtered.length })}
                                    </Button>
                                )}
                                {data.skipped.length > 0 && (
                                    <p className="text-xs text-muted-foreground">
                                        {t("config.bulk.skipped", { count: data.skipped.length, names: names(data.skipped.map((s) => s.name), t) })}
                                    </p>
                                )}
                            </Step>

                            <Step n={2} title={t("config.step.add")} hint={t("config.step.addHint")}>
                                {chosen.length === 0 ? (
                                    <Callout tone="info">{t("config.bulk.pickFirst")}</Callout>
                                ) : (
                                    <SshConfigInstall
                                        serverStanza={split?.server ?? null}
                                        deviceStanzas={stanzas}
                                        knownHosts={data.known_hosts}
                                        wsClient={wsClient}
                                        active={active}
                                        onActive={setActive}
                                        bulk
                                    />
                                )}
                            </Step>

                            <Step n={3} done={accessDone} title={t("config.step.access")} status={accessStatus}>
                                {!bulk.devicesLoaded || bulk.myKeys === null ? (
                                    <p className="flex items-center gap-2 text-muted-foreground">
                                        <Loader2 size={14} className="animate-spin" aria-hidden />
                                        {t("config.access.loading")}
                                    </p>
                                ) : keyCount === 0 ? (
                                    <ul className="divide-y divide-border/70 rounded-lg bg-surface ring-1 ring-inset ring-border/70">
                                        <CheckRow
                                            icon={<KeyRound />}
                                            right={
                                                <Button asChild size="sm">
                                                    <Link href="/tunnels/keys" prefetch={false}><KeyRound size={15} />{t("config.access.addKey")}</Link>
                                                </Button>
                                            }
                                        >
                                            {t("config.access.noKeys")}
                                        </CheckRow>
                                    </ul>
                                ) : chosen.length === 0 ? (
                                    <p className="text-muted-foreground">{t("config.bulk.pickFirst")}</p>
                                ) : (
                                    <>
                                        <ul className="divide-y divide-border/70 rounded-lg bg-surface ring-1 ring-inset ring-border/70">
                                            {(["ready", "installing", "error", "missing"] as const).map((state) => {
                                                const list = chosen.filter((r) => access.get(r.id) === state).map((r) => r.name);
                                                if (list.length === 0) return null;
                                                const chip = ACCESS_CHIP[state]!;
                                                return (
                                                    <CheckRow key={state} icon={<KeyRound />} right={<Chip tone={chip.tone}>{t(chip.key)}</Chip>}>
                                                        <span className="block">{t(`config.bulk.access.${state}`, { count: list.length })}</span>
                                                        {state !== "ready" && <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]" title={list.join(", ")}>{names(list, t)}</span>}
                                                    </CheckRow>
                                                );
                                            })}
                                        </ul>
                                        {needKeys.length > 0 && has("keys.personal") && (
                                            <Button size="sm" onClick={() => bulk.addMyKeys(needKeys.map((r) => r.id))} disabled={bulk.adding}>
                                                {bulk.adding ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
                                                {t("config.bulk.addMine", { count: needKeys.length })}
                                            </Button>
                                        )}
                                        <p className="text-xs text-muted-foreground">
                                            {tn("config.access.manual", { path: code("~/.ssh/authorized_keys") })}{" "}
                                            <Link href="/tunnels/keys/devices" prefetch={false} className="text-primary underline-offset-4 hover:underline">
                                                {t("config.bulk.manageAll")}
                                            </Link>
                                        </p>
                                    </>
                                )}
                            </Step>

                            <Step n={4} last title={t("config.step.connect")}>
                                <p className="text-muted-foreground">{t("config.connect.body")}</p>
                                {aliases.length > 0 && (
                                    <div className="space-y-2">
                                        {aliases.slice(0, 3).map((a) => <MiniCommand key={a} command={`ssh ${a}`} />)}
                                    </div>
                                )}
                                {aliases.length > 3 && <p className="text-xs text-muted-foreground">{t("config.bulk.connectMore", { count: aliases.length - 3 })}</p>}
                            </Step>
                        </ol>
                    )}
                </div>
            )}
            <TransportInfoDialog
                isOpen={transportInfo}
                onClose={() => setTransportInfo(false)}
                choice={bulk.transport}
                onChoose={bulk.setTransport}
                server={data ? { host: data.server.host, port: String(data.server.port) } : null}
                wsUrl={data?.ws_url ?? null}
                devices={chosen.map((r) => {
                    const tun = byId.get(r.id);
                    return { online: isUp(r.id), transport: tun?.endpoint?.live ? tun.endpoint.transport : null };
                })}
            />
        </Modal>
    );
}
