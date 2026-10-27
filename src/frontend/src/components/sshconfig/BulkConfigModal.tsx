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
import { Check, ChevronDown, FileCode2, FolderPlus, KeyRound, Loader2, Search } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MiniCommand } from "@/components/cheatsheet/CommandView";
import { StatusDot } from "@/components/tunnels/TunnelStatus";
import { ConfigRouteMap, type ConfigPart } from "./ConfigRouteMap";
import { SshConfigInstall } from "./SshConfigInstall";
import { CheckRow, StepPanel, ToolbarField } from "./ConfigSteps";
import { StepFooter, StepTabs, type StepTab } from "@/components/ui/step-tabs";
import type { StepState } from "@/lib/stepTabs";
import { allDone, configDoneKey, markKeys, readConfigDone, writeConfigDone, type ConfigDone } from "@/lib/configDone";
import { TransportInfoDialog } from "./TransportInfoDialog";
import { AccountChips } from "./AccountChips";
import { withoutPrefix } from "@/lib/aliasPrefix";
import { useBulkConfig } from "@/hooks/useBulkConfig";
import { useFeatures } from "@/hooks/useFeatures";
import { countAccess, deviceAccess, initialSelection, keysToAdd, pickStanzas, toggleAccount, type BulkConfigTunnel, type DeviceAccess } from "@/lib/bulkSshConfig";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import type { TunnelGroup } from "@/types/groups";
import type { Tunnel, TunnelHealth } from "@/types/tunnel";

type BulkStep = "pick" | "add" | "access" | "connect";

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
    // 這台現在寫哪些帳號：改過的照改的（回應還沒回來時也先顯示），否則照回應。/ Accounts in use for a device.
    const chosenOf = (r: BulkConfigTunnel) => bulk.picks[r.id] ?? r.hosts.map((h) => h.username_id);
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

    // 「我已經加好了」：每台 × 帳號一筆，跟單台的對話框、指令速查共用。/ "I've added it", per device × account, shared.
    const [configDone, setConfigDone] = useState<ConfigDone>(readConfigDone);
    const doneKeys = chosen.flatMap((r) => r.hosts.map((h) => configDoneKey(r.id, h.username)));
    const addDone = allDone(configDone, doneKeys);
    const markAdded = (done: boolean) => setConfigDone((prev) => {
        const next = markKeys(prev, doneKeys, done);
        writeConfigDone(next);
        return next;
    });
    const keysLoaded = bulk.devicesLoaded && bulk.myKeys !== null;
    const accessState: StepState = !keysLoaded || chosen.length === 0 ? "todo" : accessDone ? "done" : keyCount === 0 ? "attention" : counts.installing > 0 && counts.error === 0 && counts.missing === 0 ? "working" : "attention";
    const connectState: StepState = chosen.length > 0 && addDone && accessDone ? "done" : "todo";
    const steps: StepTab<BulkStep>[] = [
        { value: "pick", label: t("config.bulk.step.pick"), state: chosen.length > 0 ? "done" : "todo", status: chosen.length > 0 ? t("config.bulk.selected", { count: chosen.length, total: rows.length }) : t("config.steps.pickTodo") },
        { value: "add", label: t("config.step.add"), state: addDone ? "done" : "todo", status: addDone ? t("config.steps.addDone") : t("config.steps.addTodo") },
        {
            value: "access",
            label: t("config.step.access"),
            state: accessState,
            status: !keysLoaded ? t("config.access.loading") : keyCount === 0 ? t("config.steps.noKey") : t("config.bulk.accessCount", { ready: counts.ready, count: chosen.length }),
        },
        { value: "connect", label: t("config.step.connect"), state: connectState, status: connectState === "done" ? t("config.steps.connectReady") : t("config.steps.connectTodo") },
    ];
    // 一律從挑裝置開始（預設的勾選只是猜的）；對話框每次打開都重新掛載。/ Always start at picking (the default
    // selection is only a guess); the dialog remounts on every open.
    const [current, setStep] = useState<BulkStep>("pick");

    // 原本在固定工具列的兩個切換，各放到它影響的那一步。/ The two switches live in the step each one affects.
    const hostsField = (
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
    );
    const transportField = (
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
    );
    const routeMap = data && (
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
    );
    const addMark = addDone ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-success/10 px-3 py-2.5 text-success ring-1 ring-inset ring-success/30">
            <Check size={16} aria-hidden />
            <span className="min-w-0 flex-1 text-foreground">{t("config.steps.addDoneBody")}</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => markAdded(false)}>{t("sheet.setup.configUnmark")}</Button>
        </div>
    ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-surface px-3 py-2.5 ring-1 ring-inset ring-border/70">
            <span className="min-w-0 flex-1 text-muted-foreground">{t("config.steps.addAsk")}</span>
            <Button type="button" size="sm" onClick={() => { markAdded(true); setStep("access"); }}>
                <Check size={15} />
                {t("sheet.setup.configMark")}
            </Button>
        </div>
    );

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
            size="5xl"
            isLoading={bulk.loading && !data}
            nav={rows.length > 0 ? <StepTabs aria-label={t("ui.steps.aria")} tabs={steps} value={current} onChange={setStep} /> : undefined}
            fixedHeight
            footer={rows.length > 0 ? <StepFooter tabs={steps} value={current} onChange={setStep} final={<Button type="button" onClick={onClose}>{t("common.close")}</Button>} /> : undefined}
        >
            {data && (
                <div className="space-y-6">

                    {rows.length === 0 ? (
                        <>
                            {routeMap}
                            <Callout tone="warning">{t("config.bulk.none")}</Callout>
                        </>
                    ) : (
                        <>
                            <StepPanel
                                hidden={current !== "pick"}
                                title={t("config.bulk.step.pick")}
                                hint={t("config.bulk.pickHint")}
                                status={<span className="text-xs text-muted-foreground">{t("config.bulk.selected", { count: chosen.length, total: rows.length })}</span>}
                            >
                                {hostsField}
                                {routeMap}
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
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button type="button" variant="outline" size="sm">
                                                    <FolderPlus size={15} />
                                                    {t("config.bulk.pickGroup")}
                                                    <ChevronDown size={14} className="text-muted-foreground" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="start" className="max-w-[min(20rem,calc(100vw-2rem))]">
                                                {groupChoices.map(({ g, ids }) => (
                                                    <DropdownMenuItem key={g.id} onSelect={() => setMany(ids, true)}>
                                                        <span className="min-w-0 flex-1 truncate" title={g.name}>{g.name}</span>
                                                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{ids.length}</span>
                                                    </DropdownMenuItem>
                                                ))}
                                            </DropdownMenuContent>
                                        </DropdownMenu>
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
                                            <li key={r.id} className="px-3 py-2.5 hover:bg-muted/40">
                                                <div className="flex min-w-0 items-center gap-3">
                                                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
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
                                                    </label>
                                                    {chip && (
                                                        <span className="hidden shrink-0 sm:block">
                                                            <Chip tone={chip.tone}>{chipText}</Chip>
                                                        </span>
                                                    )}
                                                </div>
                                                {/* 這台要寫哪些帳號（有兩個以上才給選）；放在 label 外面，點了不會切換勾選。
                                                    Which accounts go in for this device (from two up); outside the label so a click never toggles the row. */}
                                                {selected.has(r.id) && r.usernames.length > 1 && (
                                                    <AccountChips
                                                        className="mt-2 pl-7 sm:pl-12"
                                                        accounts={r.usernames}
                                                        selected={new Set(chosenOf(r))}
                                                        onToggle={(id) => bulk.setDeviceAccounts(r.id, toggleAccount(chosenOf(r), id, r.usernames.map((u) => u.id)))}
                                                        onAll={() => bulk.setDeviceAccounts(r.id, r.usernames.map((u) => u.id))}
                                                        defaultId={r.default_username_id}
                                                    />
                                                )}
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
                            </StepPanel>

                            <StepPanel hidden={current !== "add"} title={t("config.step.add")} hint={t("config.step.addHint")}>
                                {transportField}
                                {chosen.length === 0 ? (
                                    <Callout tone="info">{t("config.bulk.pickFirst")}</Callout>
                                ) : (
                                    <SshConfigInstall
                                        serverStanza={split?.server ?? null}
                                        deviceStanzas={stanzas}
                                        knownHosts={data.known_hosts}
                                        wsClient={wsClient}
                                        legacyAlias={data.server.legacy_alias}
                                        aliasPrefix={{ value: data.alias_prefix ?? "", example: withoutPrefix(chosen[0]?.hosts[0]?.alias, data.alias_prefix ?? ""), onSave: bulk.savePrefix }}
                                        active={active}
                                        onActive={setActive}
                                        bulk
                                    />
                                )}
                                {chosen.length > 0 && addMark}
                            </StepPanel>

                            <StepPanel hidden={current !== "access"} title={t("config.step.access")} status={accessStatus}>
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
                            </StepPanel>

                            <StepPanel hidden={current !== "connect"} title={t("config.step.connect")}>
                                {connectState !== "done" && <Callout tone="info">{t("config.steps.connectFirst")}</Callout>}
                                <p className="text-muted-foreground">{t("config.connect.body")}</p>
                                {aliases.length > 0 && (
                                    <div className="space-y-2">
                                        {aliases.slice(0, 3).map((a) => <MiniCommand key={a} command={`ssh ${a}`} />)}
                                    </div>
                                )}
                                {aliases.length > 3 && <p className="text-xs text-muted-foreground">{t("config.bulk.connectMore", { count: aliases.length - 3 })}</p>}
                            </StepPanel>
                        </>
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
