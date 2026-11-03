"use client";

/**
 * IP 地圖：一台裝置的網段，每個 /24 一張 16 × 16 的格子（一格一個位址，`lib/ipMap`）。已知的主機照種類上色、閘道深色、裝置
 * 自己綠框、這次沒看到的斜線、網路 / 廣播位址虛線、空的淡色；滑過看位址與名稱，點主機打開主機面板，點空位（能編輯的人）
 * 直接用那個位址新增主機。方向鍵在格子裡移動。搜尋時不符合的主機變淡。
 * The IP map: a device's networks, one 16 × 16 grid per /24 (one cell per address, `lib/ipMap`). Known hosts are
 * coloured by kind, the gateway dark, the device itself outlined green, hosts not seen this time hatched, network /
 * broadcast addresses dashed, free ones faint; hover shows address and name, a host opens its panel, a free cell
 * (for editors) adds a host at that address. Arrow keys move around; with a search, non-matching hosts fade.
 */
import React, { useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { useWiderThan } from "@/hooks/useWiderThan";
import { NativeSelect } from "@/components/ui/native-select";
import { KIND_LABEL, KIND_TONE } from "@/components/network/TopologyTree";
import { hostKind, hostName } from "@/lib/lanConnect";
import { identityLine } from "@/lib/lanIdentity";
import { blockCounts, cellKind, CELLS, gridStep, hostsByIp, intToIp, ipToInt, mapBlocks, type CellKind, type MapBlock } from "@/lib/ipMap";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import type { LanHost, TopologyTunnel } from "@/types/lan";

const KIND_CELL: Record<Exclude<CellKind, "host">, string> = {
    outside: "invisible",
    edge: "border border-dashed border-border bg-transparent text-muted-foreground/60",
    device: "bg-success/20 text-success ring-2 ring-inset ring-success",
    gateway: "bg-foreground text-background",
    missing: "border border-dashed border-muted-foreground/50 text-muted-foreground bg-[repeating-linear-gradient(135deg,var(--color-muted)_0_3px,transparent_3px_6px)]",
    free: "bg-muted/45 text-muted-foreground/70 hover:bg-muted",
};

function Block({ tn, block, hosts, deviceIps, matches, selectedHostId, onOpenHost, onAdd, cols }: {
    tn: TopologyTunnel;
    /** 一列幾格：寬的時候 16，手機上 8（格子才點得到）。/ Cells per row: 16 when wide, 8 on phones (tappable). */
    cols: number;
    block: MapBlock;
    hosts: Map<number, LanHost>;
    deviceIps: Set<number>;
    /** 搜尋符合的主機 id（null = 沒在搜尋）。/ Host ids matching the search (null = no search). */
    matches: Set<number> | null;
    selectedHostId: number | null;
    onOpenHost: (h: LanHost) => void;
    onAdd: (tn: TopologyTunnel, address: string) => void;
}) {
    const { t } = useI18n();
    const ref = useRef<HTMLDivElement>(null);
    const counts = blockCounts(block, hosts, deviceIps);
    const own = tn.hosts.find((h) => h.own || h.source === "self") ?? null;
    const inside = (i: number) => i >= block.from && i <= block.to;
    // 一次只有一格能 Tab 進來：選到的主機、否則第一個用掉的位址、否則網段的第一格。/ One tabbable cell (roving tabindex).
    const firstUsed = useMemo(() => {
        for (let i = block.from; i <= block.to; i++) if (hosts.has(block.base + i)) return i;
        return block.from;
    }, [block, hosts]);
    const selectedAt = (() => {
        for (const [ip, h] of hosts) if (h.id === selectedHostId && ip >= block.base && ip < block.base + CELLS) return ip - block.base;
        return null;
    })();
    const [focusAt, setFocusAt] = useState<number>(selectedAt ?? firstUsed);

    const onKeyDown = (e: React.KeyboardEvent, i: number) => {
        const next = gridStep(i, e.key, inside, cols);
        if (next === i) return;
        e.preventDefault();
        setFocusAt(next);
        ref.current?.querySelector<HTMLElement>(`[data-cell="${next}"]`)?.focus();
    };

    // 只畫網段涵蓋的那幾列（/32 就只有一列）。/ Only the rows the network covers (a /32 is one row).
    const rowFrom = Math.floor(block.from / cols);
    const rowTo = Math.floor(block.to / cols);
    const cell = (i: number) => {
        const kind = cellKind(block, i, hosts, deviceIps);
        const ip = intToIp(block.base + i);
        const host = kind === "host" || kind === "gateway" || kind === "missing" ? hosts.get(block.base + i) ?? null : null;
        const dim = matches !== null && (!host || !matches.has(host.id));
        const tone = kind === "host" && host ? KIND_TONE[hostKind(host)] + " ring-1 ring-inset" : KIND_CELL[kind as Exclude<CellKind, "host">];
        const what = host
            ? [hostName(host) !== ip ? hostName(host) : null, identityLine(host) || t(KIND_LABEL[hostKind(host)]), kind === "gateway" ? t("network.change.gateway") : null, kind === "missing" ? t("network.change.missing") : null].filter(Boolean).join(" · ")
            : kind === "device"
                ? t("network.map.device", { device: tn.name })
                : kind === "edge"
                    ? (block.base + i) % 2 === 0 ? t("network.map.networkAddress") : t("network.map.broadcast")
                    : kind === "free"
                        ? tn.can_edit ? t("network.map.freeAdd") : t("network.map.free")
                        : "";
        const title = what ? `${ip} · ${what}` : ip;
        const cls = cn(
            "relative grid aspect-square min-w-0 place-items-center rounded-[3px] font-mono text-[0.5625rem] leading-none tabular-nums transition-[opacity,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            tone,
            dim && kind !== "outside" && "opacity-25",
            host && host.id === selectedHostId && "ring-2 ring-primary ring-offset-1 ring-offset-card"
        );
        const label = <span className={cols === 16 ? "hidden @[34rem]:inline" : ""} aria-hidden>{i}</span>;
        if (kind === "outside") return <span key={i} className={cls} aria-hidden />;
        const clickable = !!host || (kind === "free" && tn.can_edit) || (kind === "device" && !!own);
        if (!clickable) {
            return (
                <span key={i} data-cell={i} role="gridcell" tabIndex={i === focusAt ? 0 : -1} title={title} aria-label={title} onKeyDown={(e) => onKeyDown(e, i)} onFocus={() => setFocusAt(i)} className={cls}>
                    {label}
                </span>
            );
        }
        return (
            <button
                key={i}
                type="button"
                data-cell={i}
                role="gridcell"
                tabIndex={i === focusAt ? 0 : -1}
                title={title}
                aria-label={title}
                aria-selected={host ? host.id === selectedHostId : undefined}
                onKeyDown={(e) => onKeyDown(e, i)}
                onFocus={() => setFocusAt(i)}
                onClick={() => (host ? onOpenHost(host) : kind === "device" && own ? onOpenHost(own) : onAdd(tn, ip))}
                className={cn(cls, "cursor-pointer")}
            >
                {label}
            </button>
        );
    };
    const rows = Array.from({ length: rowTo - rowFrom + 1 }, (_, r) => {
        const row = rowFrom + r;
        return (
            <React.Fragment key={row}>
                <span className="self-center pr-1 text-right font-mono text-[0.625rem] text-muted-foreground" aria-hidden>.{row * cols}</span>
                {Array.from({ length: cols }, (_, c) => cell(row * cols + c))}
            </React.Fragment>
        );
    });

    return (
        <section className="space-y-2" aria-label={block.label}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <h3 className="font-mono text-sm text-foreground">{block.label}</h3>
                <p className="text-xs text-muted-foreground">
                    {t("network.map.counts", { used: counts.used, free: counts.free })}
                    {counts.gateway > 0 && ` · ${t("network.map.gatewayCount")}`}
                    {counts.missing > 0 && ` · ${t("network.map.missingCount", { count: counts.missing })}`}
                </p>
            </div>
            {block.derived && <p className="text-xs text-muted-foreground">{t("network.map.derived")}</p>}
            {/* 格子最寬 44rem，寬螢幕上一格也不會大到看不出是張表。/ At most 44rem wide, so cells stay cell-sized on wide screens. */}
            <div ref={ref} role="grid" aria-label={t("network.map.gridAria", { network: block.label })} className={cn("grid max-w-[44rem] gap-[3px]", cols === 16 ? "grid-cols-[2.25rem_repeat(16,minmax(0,1fr))]" : "grid-cols-[2.25rem_repeat(8,minmax(0,1fr))]")}>
                {rows}
            </div>
        </section>
    );
}

export function IpMap({ tunnels, matches, focusTunnel, selectedHostId, onOpenHost, onAdd }: {
    /** 全部的裝置（地圖畫所有主機，搜尋只讓不符合的變淡）。/ Every device (all hosts drawn; the search only fades). */
    tunnels: TopologyTunnel[];
    matches: Set<number> | null;
    focusTunnel: string | null;
    selectedHostId: number | null;
    onOpenHost: (h: LanHost) => void;
    onAdd: (tn: TopologyTunnel, address: string) => void;
}) {
    const { t } = useI18n();
    // 地圖寬不到 30rem（手機）就一列 8 格。/ Under 30rem (phones): eight cells per row.
    const boxRef = useRef<HTMLDivElement>(null);
    const cols = useWiderThan(boxRef, 30) ? 16 : 8;
    const withData = tunnels.filter((tn) => (tn.lan?.networks.length ?? 0) > 0 || tn.hosts.some((h) => ipToInt(h.address) !== null && !h.own));
    const start = withData.find((tn) => String(tn.id) === focusTunnel) ?? withData.find((tn) => tn.hosts.some((h) => h.id === selectedHostId)) ?? withData[0] ?? null;
    const [pick, setPick] = useState<number | null>(start?.id ?? null);
    const tn = withData.find((x) => x.id === pick) ?? start;
    if (!tn) return <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("network.map.empty")}</p>;

    const hosts = hostsByIp(tn.hosts);
    const deviceIps = new Set((tn.endpoint?.lan ?? []).map((a) => ipToInt(a.ip)).filter((n): n is number => n !== null));
    const blocks = mapBlocks(tn.lan?.networks ?? [], tn.hosts.map((h) => h.address));
    const legend: { kind: string; cls: string; label: TranslationKey }[] = [
        { kind: "ssh", cls: KIND_TONE.ssh + " ring-1 ring-inset", label: "network.kind.ssh" },
        { kind: "web", cls: KIND_TONE.web + " ring-1 ring-inset", label: "network.map.legendWeb" },
        { kind: "files", cls: KIND_TONE.files + " ring-1 ring-inset", label: "network.kind.files" },
        { kind: "other", cls: KIND_TONE.other + " ring-1 ring-inset", label: "network.kind.other" },
        { kind: "gateway", cls: KIND_CELL.gateway, label: "network.change.gateway" },
        { kind: "device", cls: KIND_CELL.device, label: "network.map.legendDevice" },
        { kind: "missing", cls: KIND_CELL.missing, label: "network.change.missing" },
        { kind: "free", cls: KIND_CELL.free, label: "network.map.free" },
    ];

    return (
        <div ref={boxRef} className="@container min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 shadow-card sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
                {withData.length > 1 ? (
                    <NativeSelect value={String(tn.id)} onChange={(e) => setPick(Number(e.target.value))} aria-label={t("network.map.deviceAria")} className="h-8 w-auto min-w-0 max-w-full text-sm">
                        {withData.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </NativeSelect>
                ) : (
                    <p className="text-sm text-foreground">{tn.name}</p>
                )}
                {tn.lan?.gateway && <p className="font-mono text-xs text-muted-foreground">{t("network.changes.gatewayIs", { gateway: tn.lan.gateway })}</p>}
            </div>
            {blocks.map((b) => (
                <Block key={`${b.base}-${cols}`} cols={cols} tn={tn} block={b} hosts={hosts} deviceIps={deviceIps} matches={matches} selectedHostId={selectedHostId} onOpenHost={onOpenHost} onAdd={onAdd} />
            ))}
            <ul className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-border pt-3 text-xs text-muted-foreground" aria-label={t("network.map.legend")}>
                {legend.map((l) => (
                    <li key={l.kind} className="flex items-center gap-1.5">
                        <span className={cn("inline-block size-3 rounded-[3px]", l.cls)} aria-hidden />
                        {t(l.label)}
                    </li>
                ))}
            </ul>
            <p className="text-xs text-muted-foreground">{t("network.map.hint")}</p>
        </div>
    );
}
