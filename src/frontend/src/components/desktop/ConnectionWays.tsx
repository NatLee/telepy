"use client";

/**
 * 「比較連線方式」對話框：RDP / VNC 經隧道（guacd）、RustDesk 經隧道、Telepy 當 RustDesk 伺服器（沒有隧道），
 * 三條路徑上下對齊（你的瀏覽器 ─ Telepy ─ 裝置 ─ 桌面），每條下面一把「這段誰加密」的尺，接著是比較表與怎麼選。
 * 寬容器橫向、窄容器（手機）直向；只有直線。目前頁面上選的那一種會標出來。
 * The "ways to connect" dialog: the three paths aligned column by column with an encryption ruler under each,
 * then the comparison table and how to choose. Horizontal when wide, vertical on phones; straight lines only.
 */
import React from "react";
import Link from "next/link";
import { ArrowLeft, Check, Laptop, Lock, LockOpen, Monitor, MonitorSmartphone, Paintbrush, Route, Server, TriangleAlert, type LucideIcon } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/section";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { pathCells, ROWS, WAYS, type CellTone, type LayerTone, type LinkKind, type NodeIcon, type Way, type WayId, type WayLink, type WayNode } from "@/lib/connectionWays";
import type { TranslationKey } from "@/locales/en";

const ICON: Record<Exclude<NodeIcon, "telepy">, LucideIcon> = { browser: Laptop, device: Server, desktop: Monitor };

const SHORT: Record<WayId, TranslationKey> = {
    guacd: "desktop.ways.short.guacd",
    rustdeskTunnel: "desktop.ways.short.rustdeskTunnel",
    rustdeskServer: "desktop.ways.short.rustdeskServer",
};

const LAYER_STYLE: Record<LayerTone, string> = {
    e2e: "border-success/40 bg-success/10 text-success",
    transport: "border-info/35 bg-info/8 text-info",
    plain: "border-dashed border-border bg-transparent text-muted-foreground",
};

const TONE_TEXT: Record<CellTone, string> = { good: "text-success", bad: "text-warning", neutral: "text-foreground" };

function NodeTile({ node, compact }: { node: WayNode; compact?: boolean }) {
    const { t } = useI18n();
    const Icon = node.icon === "telepy" ? null : ICON[node.icon];
    return (
        <div className={cn("flex min-w-0 gap-2.5", compact ? "items-center" : "flex-col items-center gap-1 text-center")}>
            <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", node.icon === "telepy" ? "bg-brand-gradient text-white" : "bg-muted text-foreground")} aria-hidden>
                {Icon ? <Icon size={18} /> : <TelepyGlyph size={20} />}
            </span>
            <span className="min-w-0">
                <span className="block text-sm leading-tight text-foreground">{t(node.label)}</span>
                <span className="block text-xs leading-snug text-muted-foreground">{t(node.sub)}</span>
                {node.draws && (
                    <span className="mt-1 inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 text-xs leading-5 whitespace-nowrap text-foreground">
                        <Paintbrush size={12} aria-hidden /> {t("desktop.ways.draws")}
                    </span>
                )}
            </span>
        </div>
    );
}

/** 一條線（只有直線）：wss 實線、隧道雙線、裝置往外連帶箭頭、本機虛線。/ One straight link by kind. */
function LinkLine({ kind, vertical }: { kind: LinkKind; vertical?: boolean }) {
    if (vertical) {
        const v = kind === "tunnel" ? "w-1.5 border-x-2 border-foreground/45" : kind === "local" ? "w-0 border-l-2 border-dashed border-foreground/30" : "w-0 border-l-2 border-foreground/45";
        return (
            <span className="flex min-h-12 w-9 shrink-0 flex-col items-center self-stretch py-1" aria-hidden>
                {kind === "dialOut" && <ArrowLeft size={14} className="-mb-1 shrink-0 rotate-90 text-foreground/60" />}
                <span className={cn("flex-1", v)} />
            </span>
        );
    }
    const h = kind === "tunnel" ? "h-1.5 border-y-2 border-foreground/45" : kind === "local" ? "h-0 border-t-2 border-dashed border-foreground/30" : "h-0 border-t-2 border-foreground/45";
    return (
        <span className="relative flex w-full items-center" aria-hidden>
            {kind === "dialOut" && <ArrowLeft size={14} className="-mr-1 shrink-0 text-foreground/60" />}
            <span className={cn("w-full", h)} />
        </span>
    );
}

function layerFor(way: Way, link: WayLink) {
    return way.layers.find((l) => l.from <= link.from && l.to >= link.to) ?? null;
}

function LayerChip({ tone, label, nowrap }: { tone: LayerTone; label: TranslationKey; nowrap?: boolean }) {
    const { t } = useI18n();
    const Icon = tone === "plain" ? LockOpen : Lock;
    return (
        <span className={cn("inline-flex min-w-0 items-center justify-center gap-1 rounded-sm border px-1.5 text-xs leading-5", nowrap && "whitespace-nowrap", LAYER_STYLE[tone])}>
            <Icon size={12} className="shrink-0" aria-hidden />
            <span className="min-w-0">{t(label)}</span>
        </span>
    );
}

/** 寬版：7 欄（點、線、點…），三列共用欄寬所以上下對齊；尺只畫在線底下。/ Wide: seven aligned slots; the ruler sits under the links. */
function PathGrid({ way }: { way: Way }) {
    const { t } = useI18n();
    const cells = pathCells(way);
    return (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(4.5rem,0.8fr)_minmax(0,1fr)_minmax(4.5rem,0.8fr)_minmax(0,1fr)_minmax(4.5rem,0.8fr)_minmax(0,1fr)] items-start gap-y-3">
            {cells.map((c, i) => {
                const start = c.start;
                if (c.kind === "node") return <div key={i} style={{ gridColumn: `${start}`, gridRow: 1 }}><NodeTile node={c.node} /></div>;
                if (c.kind === "gap") return <div key={i} style={{ gridColumn: `${start}`, gridRow: 1 }} />;
                return (
                    <div key={i} className="flex flex-col items-center gap-1.5 px-1.5 pt-[16px]" style={{ gridColumn: `${start} / span ${c.span}`, gridRow: 1 }}>
                        <LinkLine kind={c.link.kind} />
                        <span className="text-center text-xs leading-tight text-muted-foreground">{t(c.link.label)}</span>
                    </div>
                );
            })}
            {way.layers.map((l) => (
                <div key={`${l.from}-${l.to}`} className="flex justify-center px-1" style={{ gridColumn: `${l.from * 2 + 2} / ${l.to * 2 + 1}`, gridRow: 2 }}>
                    <LayerChip tone={l.tone} label={l.label} nowrap />
                </div>
            ))}
        </div>
    );
}

/** 窄版：直向，線的右邊寫它是什麼、由誰加密。/ Narrow: vertical, each link labelled with its encryption. */
function PathList({ way }: { way: Way }) {
    const { t } = useI18n();
    return (
        <ol className="space-y-0">
            {pathCells(way).map((c, i) => {
                if (c.kind === "gap") return null;
                if (c.kind === "node") return <li key={i}><NodeTile node={c.node} compact /></li>;
                const layer = layerFor(way, c.link);
                return (
                    <li key={i} className="flex items-stretch gap-2.5">
                        <LinkLine kind={c.link.kind} vertical />
                        <span className="flex min-w-0 flex-col justify-center gap-1 py-1.5">
                            <span className="text-xs text-muted-foreground">{t(c.link.label)}</span>
                            {layer && <span><LayerChip tone={layer.tone} label={layer.label} /></span>}
                        </span>
                    </li>
                );
            })}
        </ol>
    );
}

function WayCard({ way, current }: { way: Way; current: boolean }) {
    const { t } = useI18n();
    return (
        <section className={cn("rounded-xl border p-4", current ? "border-primary/45 bg-primary/4" : "border-border bg-card")} aria-current={current ? "true" : undefined}>
            <header className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <h3 className="text-base text-foreground">{t(way.title)}</h3>
                {current && <Chip tone="primary">{t("desktop.ways.current")}</Chip>}
                <p className="basis-full text-sm text-muted-foreground">{t(way.when)}</p>
            </header>
            <div className="hidden @2xl:block"><PathGrid way={way} /></div>
            <div className="@2xl:hidden"><PathList way={way} /></div>
        </section>
    );
}

function Cell({ tone, text }: { tone: CellTone; text: TranslationKey }) {
    const { t } = useI18n();
    return (
        <span className={cn("inline-flex items-start gap-1.5", TONE_TEXT[tone])}>
            {tone === "good" ? <Check size={14} className="mt-0.5 shrink-0" aria-hidden /> : tone === "bad" ? <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden /> : null}
            <span>{t(text)}</span>
        </span>
    );
}

function CompareTable({ current }: { current: WayId | null }) {
    const { t } = useI18n();
    const ids = WAYS.map((w) => w.id);
    return (
        <>
            <table className="hidden w-full table-fixed border-collapse text-sm @2xl:table">
                <thead>
                    <tr className="border-b border-border text-left">
                        <th className="w-[22%] py-2 pr-3 text-xs text-muted-foreground" scope="col"><span className="sr-only">{t("desktop.ways.tableCaption")}</span></th>
                        {ids.map((id) => (
                            <th key={id} scope="col" className={cn("px-3 py-2 text-sm text-foreground", current === id && "bg-primary/5")}>{t(SHORT[id])}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {ROWS.map((r) => (
                        <tr key={r.label} className="border-b border-border align-top last:border-0">
                            <th scope="row" className="py-2.5 pr-3 text-left text-muted-foreground">{t(r.label)}</th>
                            {ids.map((id) => (
                                <td key={id} className={cn("px-3 py-2.5", current === id && "bg-primary/5")}><Cell {...r.cells[id]} /></td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
            <dl className="space-y-3 @2xl:hidden">
                {ROWS.map((r) => (
                    <div key={r.label} className="rounded-md border border-border bg-surface px-3 py-2.5">
                        <dt className="mb-1.5 text-sm text-foreground">{t(r.label)}</dt>
                        {ids.map((id) => (
                            <dd key={id} className={cn("flex gap-2 py-0.5 text-sm", current === id && "rounded-sm bg-primary/5 px-1 -mx-1")}>
                                <span className="w-28 shrink-0 text-xs leading-5 text-muted-foreground">{t(SHORT[id])}</span>
                                <Cell {...r.cells[id]} />
                            </dd>
                        ))}
                    </div>
                ))}
            </dl>
        </>
    );
}

/** 「比較連線方式」對話框。/ The ways-to-connect dialog. */
export function ConnectionWaysDialog({ isOpen, onClose, current }: { isOpen: boolean; onClose: () => void; current: WayId | null }) {
    const { t } = useI18n();
    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("desktop.ways.title")}
            description={t("desktop.ways.description")}
            icon={<Route />}
            size="4xl"
            footer={<Button onClick={onClose}>{t("common.close")}</Button>}
        >
            <div className="@container space-y-6">
                <div className="space-y-3">
                    {WAYS.map((w) => <WayCard key={w.id} way={w} current={current === w.id} />)}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground" aria-label={t("desktop.ways.legend")}>
                    <span className="inline-flex items-center gap-1.5"><span className="inline-block w-6 border-t-2 border-foreground/45" aria-hidden /> {t("desktop.ways.legend.wss")}</span>
                    <span className="inline-flex items-center gap-1.5"><span className="inline-block h-1.5 w-6 border-y-2 border-foreground/45" aria-hidden /> {t("desktop.ways.legend.tunnel")}</span>
                    <span className="inline-flex items-center gap-1.5"><ArrowLeft size={12} aria-hidden /><span className="-ml-1 inline-block w-5 border-t-2 border-foreground/45" aria-hidden /> {t("desktop.ways.legend.dialOut")}</span>
                    <span className="inline-flex items-center gap-1.5"><span className="inline-block w-6 border-t-2 border-dashed border-foreground/30" aria-hidden /> {t("desktop.ways.legend.local")}</span>
                </div>
                <CompareTable current={current} />
                <section className="space-y-2">
                    <h3 className="text-base text-foreground">{t("desktop.ways.pickTitle")}</h3>
                    <ul className="space-y-2 text-sm leading-relaxed">
                        <li className="flex gap-2.5"><Monitor size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden /><span>{t("desktop.ways.pick.guacd")}</span></li>
                        <li className="flex gap-2.5"><Server size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden /><span>{t("desktop.ways.pick.rustdeskTunnel")}</span></li>
                        <li className="flex gap-2.5">
                            <MonitorSmartphone size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                            <span>
                                {t("desktop.ways.pick.rustdeskServer")}{" "}
                                <Link href="/tunnels/rustdesk" prefetch={false} onClick={onClose} className="text-primary underline-offset-2 hover:underline">{t("desktop.ways.addRustDesk")}</Link>
                            </span>
                        </li>
                    </ul>
                </section>
            </div>
        </Modal>
    );
}
