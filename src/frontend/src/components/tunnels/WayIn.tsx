"use client";

/**
 * 裝置怎麼連 Telepy 的三種方式（自動 / 只走 SSH 的 port / 只走網頁的 port）：
 * - `WayInLanes`：裝置與 Telepy 之間兩條平行的路——上面直接到 SSH 的 port，下面經網頁入口（Traefik 與前面的代理）到
 *   `/ws/gateway/`——依方式與「被擋」的假設標出走哪條、哪條備著、哪條被擋。只有直線與直角；寬的時候左右排，窄的時候上下排。
 * - `WayChoiceCards`：換的對話框裡的三選一。
 * - `WayInInfoDialog`：「三種方式差在哪」——選一種看、開關「SSH 的 port 被擋 / 網頁的 port 被擋」、對照表、網路上看得到什麼。
 * The three ways a device reaches Telepy (automatic / the SSH port only / the web port only): the two-lane diagram (the
 * SSH port straight on top, the web entrance to `/ws/gateway/` below) lit by the way and the "what if" blocks; the
 * switch dialog's three cards; and the "how they differ" dialog with the picker, the what-if switches, the comparison
 * table and what the network sees.
 */
import React, { useState } from "react";
import { Check, Globe, Server, XCircle } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { TransportVisibility, useHttps } from "@/components/tunnels/TransportVisibility";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { WAY_IN_KEY, type WayInSetup } from "@/lib/deviceInstall";
import { NOTHING_BLOCKED, WAY_CHOICES, WAY_ROWS, WAY_WHAT, isReinstall, outcome, outcomeKey, type Blocked, type CellTone, type LaneState } from "@/lib/wayIn";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";

const LANE_TONE: Record<LaneState, string> = {
    used: "text-success",
    standby: "text-muted-foreground",
    blocked: "text-destructive",
    unused: "text-muted-foreground/35",
};

const LANE_DASH: Record<LaneState, string> = { used: "7 5", standby: "4 5", blocked: "2 6", unused: "1 6" };

const LANE_TEXT: Record<LaneState, TranslationKey> = {
    used: "wayIn.state.used",
    standby: "wayIn.state.standby",
    blocked: "wayIn.state.blocked",
    unused: "wayIn.state.unused",
};

/** 「SSH」/「SSH over WSS」（Telepy 走 http 時 WS）：跟列表上的標籤同一套字。/ The list badge's own words. */
export function viaLabelKey(way: WayInSetup, https: boolean): TranslationKey {
    if (way === "ssh") return "platforms.via.ssh";
    if (way === "websocket") return https ? "platforms.via.wss" : "platforms.via.ws";
    return https ? "wayIn.via.autoWss" : "wayIn.via.autoWs";
}

/** 一段直線；被擋時中間一個 ✗。/ One straight line; a ✗ in the middle when blocked. */
function LaneLine({ state, vertical }: { state: LaneState; vertical?: boolean }) {
    const motion = !useReducedMotion();
    const animate = motion && state === "used";
    return (
        <span className={cn("relative flex shrink-0 items-center justify-center", vertical ? "w-4 self-stretch" : "h-4 w-full")} aria-hidden>
            {/* 直的那條絕對定位：不然 SVG 會照 viewBox 的比例自己長出 200px 高，把整張圖撐長。
                The vertical line is absolutely placed: otherwise the SVG takes 200 px of height from its viewBox ratio. */}
            <svg className={cn(vertical ? "absolute inset-y-0 left-0.5 h-full w-3" : "h-3 w-full", LANE_TONE[state])} viewBox={vertical ? "0 0 6 100" : "0 0 100 6"} preserveAspectRatio="none">
                <line
                    x1={vertical ? 3 : 0}
                    y1={vertical ? 0 : 3}
                    x2={vertical ? 3 : 100}
                    y2={vertical ? 100 : 3}
                    stroke="currentColor"
                    strokeWidth={state === "used" ? 2.5 : 2}
                    strokeDasharray={LANE_DASH[state]}
                    vectorEffect="non-scaling-stroke"
                >
                    {animate && <animate attributeName="stroke-dashoffset" values="48;0" dur="2s" repeatCount="indefinite" />}
                </line>
            </svg>
            {state === "blocked" && <XCircle size={16} className="absolute rounded-full bg-card text-destructive" />}
        </span>
    );
}

/** 一條路的說明：順序（自動時）+ 名稱 + 埠，下面是狀態。/ A lane's label: order (automatic), name, port; the state below. */
function LaneText({ order, title, mono, state, center }: { order?: string; title: string; mono?: string; state?: LaneState; center?: boolean }) {
    const { t } = useI18n();
    return (
        <span className={cn("flex min-w-0 flex-col gap-0.5 text-xs leading-tight", center && "items-center text-center")}>
            <span className="text-foreground [overflow-wrap:anywhere]">
                {order && <span className="mr-1 tabular-nums">{order}</span>}
                {title}
                {mono && <span className="ml-1 font-mono text-muted-foreground">{mono}</span>}
            </span>
            {state && <span className={cn(state === "unused" ? "text-muted-foreground/70" : LANE_TONE[state])}>{t(LANE_TEXT[state])}</span>}
        </span>
    );
}

/** 兩端：裝置 / Telepy。寬的時候直的置中，窄的時候橫的。/ The two ends; centred and upright when wide, one row when narrow. */
function EndTile({ brand, title, sub, row }: { brand?: boolean; title: string; sub: string; row?: boolean }) {
    return (
        <div className={cn("flex min-w-0 items-center gap-2 rounded-xl border border-border bg-card p-2.5", row ? "flex-row" : "h-full flex-col justify-center text-center")}>
            <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", brand ? "bg-brand-gradient text-white" : "bg-muted text-foreground")} aria-hidden>
                {brand ? <TelepyGlyph size={20} /> : <Server size={18} />}
            </span>
            <span className="min-w-0">
                <span className="block text-sm leading-tight text-foreground">{title}</span>
                <span className="block text-xs leading-snug text-muted-foreground [overflow-wrap:anywhere]">{sub}</span>
            </span>
        </div>
    );
}

/** 網頁入口（Traefik，前面可能還有代理）；不走這條時淡掉。/ The web entrance; faded when its lane is not used. */
function EntranceTile({ state }: { state: LaneState }) {
    const { t } = useI18n();
    return (
        <div className={cn("flex min-w-0 items-center gap-2 rounded-lg border bg-card px-2 py-1.5", state === "used" ? "border-success/50" : state === "blocked" ? "border-destructive/60" : "border-border", state === "unused" && "opacity-45")}>
            <Globe size={15} className="shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 text-xs leading-tight">
                <span className="block text-foreground">{t("wayIn.entry")}</span>
                <span className="block text-muted-foreground [overflow-wrap:anywhere]">{t("wayIn.entrySub")}</span>
            </span>
        </div>
    );
}

interface LanesProps {
    way: WayInSetup;
    blocked?: Blocked;
    /** Telepy 的 SSH port（有的話寫在線上）。/ Telepy's SSH port, shown on the line when known. */
    sshPort?: string | null;
    className?: string;
}

/**
 * 兩條路的圖：寬（≥ 36rem 的容器）時裝置在左、Telepy 在右，兩條橫線上下並排；窄時裝置在上、Telepy 在下，兩條直線左右並排。
 * The two-lane diagram: device left / Telepy right with two horizontal lanes when the container is wide, device on top /
 * Telepy below with two vertical lanes when narrow.
 */
export function WayInLanes({ way, blocked = NOTHING_BLOCKED, sshPort, className }: LanesProps) {
    const { t } = useI18n();
    const https = useHttps();
    const o = outcome(way, blocked);
    const auto = way === "auto";
    const sshTitle = t("wayIn.lane.ssh");
    const sshMono = sshPort ? `:${sshPort}` : undefined;
    const webTitle = t(https ? "wayIn.lane.web" : "wayIn.lane.webHttp");
    const deviceSub = t(way === "ssh" ? "wayIn.deviceSsh" : "wayIn.deviceHelper");
    const device = t("deviceInstall.flow.device");
    const failed = o.via === null;
    return (
        <figure className={cn("@container space-y-3", className)} aria-label={t("wayIn.diagramAria", { way: t(WAY_IN_KEY[way]) })}>
            {/* 寬：五欄（裝置 ─ 線 ─ 入口 ─ 線 ─ Telepy），兩列。/ Wide: five columns, two rows. */}
            <div className="hidden items-center gap-y-3 @xl:grid" style={{ gridTemplateColumns: "minmax(0,8.5rem) minmax(0,1fr) minmax(0,9.5rem) minmax(0,1fr) minmax(0,8.5rem)" }}>
                <div className="self-stretch" style={{ gridColumn: 1, gridRow: "1 / span 2" }}>
                    <EndTile title={device} sub={deviceSub} />
                </div>
                <div className="flex flex-col items-center gap-1" style={{ gridColumn: "2 / 5", gridRow: 1 }}>
                    <LaneText order={auto ? "①" : undefined} title={sshTitle} mono={sshMono} center />
                    <LaneLine state={o.ssh} />
                    <LaneText title="" state={o.ssh} center />
                </div>
                <div className="flex flex-col items-center gap-1" style={{ gridColumn: 2, gridRow: 2 }}>
                    <LaneText order={auto ? "②" : undefined} title={webTitle} center />
                    <LaneLine state={o.web} />
                    <LaneText title="" state={o.web} center />
                </div>
                <div style={{ gridColumn: 3, gridRow: 2 }}>
                    <EntranceTile state={o.web} />
                </div>
                <div className="flex flex-col items-center gap-1" style={{ gridColumn: 4, gridRow: 2 }}>
                    <LaneText title="/ws/gateway/" center />
                    <LaneLine state={o.web} />
                    <span className="text-xs leading-tight">&nbsp;</span>
                </div>
                <div className="self-stretch" style={{ gridColumn: 5, gridRow: "1 / span 2" }}>
                    <EndTile brand title="Telepy" sub={t("wayIn.gateway")} />
                </div>
            </div>
            {/* 窄：兩欄（左 SSH 的 port、右網頁的 port），裝置在上、Telepy 在下。/ Narrow: two columns, device on top. */}
            <div className="grid gap-x-3 @xl:hidden" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
                <div style={{ gridColumn: "1 / span 2", gridRow: 1 }}>
                    <EndTile row title={device} sub={deviceSub} />
                </div>
                <div className="flex min-h-40 gap-2 pl-5" style={{ gridColumn: 1, gridRow: "2 / span 3" }}>
                    <LaneLine state={o.ssh} vertical />
                    <span className="self-center">
                        <LaneText order={auto ? "①" : undefined} title={sshTitle} mono={sshMono} state={o.ssh} />
                    </span>
                </div>
                <div className="flex min-h-14 gap-2 py-1.5 pl-5" style={{ gridColumn: 2, gridRow: 2 }}>
                    <LaneLine state={o.web} vertical />
                    <span className="self-center">
                        <LaneText order={auto ? "②" : undefined} title={webTitle} state={o.web} />
                    </span>
                </div>
                <div style={{ gridColumn: 2, gridRow: 3 }}>
                    <EntranceTile state={o.web} />
                </div>
                <div className="flex min-h-12 gap-2 py-1.5 pl-5" style={{ gridColumn: 2, gridRow: 4 }}>
                    <LaneLine state={o.web} vertical />
                    <span className="min-w-0 self-center font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">/ws/gateway/</span>
                </div>
                <div style={{ gridColumn: "1 / span 2", gridRow: 5 }}>
                    <EndTile row brand title="Telepy" sub={t("wayIn.gateway")} />
                </div>
            </div>
            <figcaption className={cn("rounded-md border px-3 py-2 text-sm", failed ? "border-destructive/40 bg-destructive/5 text-destructive" : "border-border bg-surface text-foreground")} role="status">
                {t(outcomeKey(way, blocked))}
            </figcaption>
        </figure>
    );
}

/**
 * 換的對話框的三選一：每張卡是一種方式（名稱、列表上的標籤、一句話），自動標「建議」，現在這種標「現在」。
 * The switch dialog's three cards: name, the list badge's words, one line; automatic is "Recommended", the current
 * one "Now".
 */
export function WayChoiceCards({ value, current, onChange, disabled }: { value: WayInSetup | null; current: WayInSetup | null | undefined; onChange: (w: WayInSetup) => void; disabled?: boolean }) {
    const { t } = useI18n();
    const https = useHttps();
    return (
        <div role="radiogroup" aria-label={t("wayIn.pickAria")} className="grid gap-2 sm:grid-cols-3">
            {WAY_CHOICES.map((w) => {
                const on = value === w;
                return (
                    <button
                        key={w}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        disabled={disabled}
                        onClick={() => onChange(w)}
                        className={cn(
                            "flex min-w-0 flex-col gap-1.5 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-60",
                            on ? "border-primary/60 bg-primary/[0.05] ring-1 ring-primary/30" : "border-border hover:border-foreground/30"
                        )}
                    >
                        <span className="flex flex-wrap items-center justify-between gap-1.5">
                            <span className="flex items-center gap-1.5 text-sm text-foreground">
                                <span className={cn("grid size-4 shrink-0 place-items-center rounded-full border", on ? "border-primary bg-primary text-primary-foreground" : "border-border")} aria-hidden>
                                    {on && <Check size={11} strokeWidth={3} />}
                                </span>
                                {t(WAY_IN_KEY[w])}
                            </span>
                            <span className="flex flex-wrap gap-1">
                                {w === "auto" && <Chip tone="success">{t("wayIn.recommended")}</Chip>}
                                {current === w && <Chip>{t("deviceInstall.switch.now")}</Chip>}
                            </span>
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">{t(viaLabelKey(w, https))}</span>
                        <span className="text-xs leading-snug text-muted-foreground">{t(WAY_WHAT[w])}</span>
                    </button>
                );
            })}
        </div>
    );
}

const TONE_TEXT: Record<CellTone, string> = { good: "text-success", bad: "text-warning", neutral: "text-foreground/85" };

/** 三種方式的對照表：寬的時候表格，窄的時候每種方式一塊。/ The comparison table; one block per way when narrow. */
function WayCompare({ viewed, current }: { viewed: WayInSetup; current: WayInSetup | null | undefined }) {
    const { t } = useI18n();
    const head = (w: WayInSetup) => (
        <span className="flex flex-wrap items-center gap-1">
            {t(WAY_IN_KEY[w])}
            {current === w && <Chip>{t("deviceInstall.switch.now")}</Chip>}
        </span>
    );
    return (
        <div className="@container">
            <table role="table" className="hidden w-full border-collapse text-xs leading-relaxed @2xl:table">
                <thead>
                    <tr>
                        <td className="w-[18%]" />
                        {WAY_CHOICES.map((w) => (
                            <th key={w} scope="col" className={cn("px-2 py-1.5 text-left align-bottom font-normal", w === viewed ? "bg-primary/[0.06] text-foreground" : "text-muted-foreground")}>
                                {head(w)}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {WAY_ROWS.map((row) => (
                        <tr key={row.label} className="border-t border-border">
                            <th scope="row" className="py-2 pr-2 text-left align-top font-normal text-muted-foreground">{t(row.label)}</th>
                            {WAY_CHOICES.map((w) => (
                                <td key={w} className={cn("px-2 py-2 align-top", TONE_TEXT[row.cells[w].tone], w === viewed && "bg-primary/[0.06]")}>
                                    {t(row.cells[w].text)}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
            <div className="space-y-2 @2xl:hidden">
                {WAY_CHOICES.map((w) => (
                    <section key={w} className={cn("rounded-lg border p-2.5 text-xs", w === viewed ? "border-primary/50 bg-primary/[0.04]" : "border-border")}>
                        <h4 className="mb-1.5 text-sm text-foreground">{head(w)}</h4>
                        <dl className="space-y-1">
                            {WAY_ROWS.map((row) => (
                                <div key={row.label}>
                                    <dt className="text-muted-foreground">{t(row.label)}</dt>
                                    <dd className={TONE_TEXT[row.cells[w].tone]}>{t(row.cells[w].text)}</dd>
                                </div>
                            ))}
                        </dl>
                    </section>
                ))}
            </div>
        </div>
    );
}

interface InfoProps {
    isOpen: boolean;
    onClose: () => void;
    /** 這台現在設定的方式（不知道 = null）。/ How the device is set up now (null = unknown). */
    current: WayInSetup | null | undefined;
    sshPort?: string | null;
    /** 有就在下面放「改成這個」（裝置分頁、可以換的時候）。/ When given, the footer offers to switch to the viewed way. */
    onPick?: (w: WayInSetup) => void;
    deviceName?: string;
    /** 從列表的標籤開的：說一聲在哪裡換（只有擁有者 / Admin 能換）。/ Opened from the list badge: say where switching lives. */
    whereHint?: boolean;
}

/**
 * 「三種方式差在哪」：上面選一種看、兩個「如果被擋」開關，圖跟著變；下面是對照表與網路上看得到什麼。從裝置分頁開的話，
 * 下面可以直接改成看的那一種。
 * "How the three ways differ": pick a way and flip the what-if blocks to watch the diagram; the comparison table and
 * what the network sees below. Opened from the Device tab, the footer switches to the way being viewed.
 */
export function WayInInfoDialog({ isOpen, onClose, current, sshPort, onPick, deviceName, whereHint }: InfoProps) {
    const { t } = useI18n();
    const [viewed, setViewed] = useState<WayInSetup>(current ?? "auto");
    const [blocked, setBlocked] = useState<Blocked>(NOTHING_BLOCKED);
    const reinstall = isReinstall(viewed, current);
    const label = (w: WayInSetup) => (current === w ? t("wayIn.optionNow", { way: t(WAY_IN_KEY[w]) }) : t(WAY_IN_KEY[w]));
    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("wayIn.title")}
            description={deviceName ? t("wayIn.descriptionFor", { name: deviceName }) : t("wayIn.description")}
            size="4xl"
            footer={
                <>
                    <Button type="button" variant="outline" onClick={onClose}>
                        {t("common.close")}
                    </Button>
                    {onPick && (
                        <Button type="button" onClick={() => onPick(viewed)}>
                            {t(reinstall ? "wayIn.reinstallThis" : "wayIn.switchToThis", { way: t(WAY_IN_KEY[viewed]) })}
                        </Button>
                    )}
                </>
            }
        >
            <div className="space-y-5 text-sm">
                <div className="space-y-3">
                    {/* 手機上三段擠成好幾行（日文最明顯），改成一行的選單。/ On phones a one-line select instead of three squeezed segments. */}
                    <Segmented
                        fullWidth
                        className="hidden sm:grid"
                        aria-label={t("wayIn.pickAria")}
                        value={viewed}
                        onChange={setViewed}
                        options={WAY_CHOICES.map((w) => ({ value: w, label: label(w) }))}
                    />
                    <NativeSelect className="sm:hidden" aria-label={t("wayIn.pickAria")} value={viewed} onChange={(e) => setViewed(e.target.value as WayInSetup)}>
                        {WAY_CHOICES.map((w) => (
                            <option key={w} value={w}>
                                {label(w)}
                            </option>
                        ))}
                    </NativeSelect>
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                        <span className="text-xs text-muted-foreground">{t("wayIn.whatIf")}</span>
                        <Switch size="sm" checked={blocked.ssh} onCheckedChange={(v) => setBlocked((b) => ({ ...b, ssh: v }))}>
                            {t("wayIn.blockSsh")}
                        </Switch>
                        <Switch size="sm" checked={blocked.web} onCheckedChange={(v) => setBlocked((b) => ({ ...b, web: v }))}>
                            {t("wayIn.blockWeb")}
                        </Switch>
                    </div>
                    <WayInLanes way={viewed} blocked={blocked} sshPort={sshPort} />
                </div>
                <section className="space-y-2">
                    <h3 className="text-base text-foreground">{t("wayIn.compareTitle")}</h3>
                    <WayCompare viewed={viewed} current={current} />
                </section>
                <Callout tone="info" title={t("wayIn.safeTitle")}>
                    {t("wayIn.safeBody")}
                </Callout>
                <TransportVisibility selected={viewed} />
                <p className="text-xs text-muted-foreground">
                    {whereHint && <span className="block">{t("wayIn.whereToSwitch")}</span>}
                    {t("wayIn.laptopNote")}
                </p>
            </div>
        </Modal>
    );
}
