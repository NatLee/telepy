"use client";

/**
 * 伺服器分頁「位址」那一組：一張圖就是整組設定。這台伺服器有三個讓人連進來的位址，各給不同的東西用，所以每一條畫成
 * 「誰連 ─ 連哪個位址 ─▶ 進 Telepy 的哪個入口」：網頁位址（瀏覽器、API、MCP、CLI）、SSH 主機（裝置的通道、筆電的
 * ssh）、代理位址（只收代理網址的程式）。位址那一格顯示現在實際生效的值（.env > 這頁 > 預設）與一行現況；沒設定的畫
 * 虛線並寫它跟著誰。按一條就在它下面打開那個位址的設定，有問題的那一條一進來就是開的。
 * The Server tab's "Addresses" group: one diagram is the whole group. The server has three addresses people connect
 * to, each for something else, so every lane reads "who connects ─ to which address ─▶ through which door of Telepy":
 * the web address (browsers, the API, MCP, the CLI), the SSH host (devices' tunnels, laptops' ssh) and the proxy
 * address (programs that only take a proxy URL). The address cell shows the value in force (.env > this page >
 * default) and one status line; an unset one is dashed and says what it follows. Clicking a lane opens that address's
 * setting under it, and a lane with a problem starts open.
 */
import React, { useCallback, useEffect, useState } from "react";
import { ArrowLeftRight, ChevronDown, ChevronRight, Cloud, CloudOff, CornerDownRight, Globe, Lock, TerminalSquare, type LucideIcon } from "lucide-react";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { useSettingsPage } from "@/hooks/useSettingsPage";
import { apiFetch, readJson } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type { ProxyInfo } from "@/lib/proxy";
import { tidyUrl } from "@/lib/proxyUrl";
import { addressLanes, firstProblem, inForce, laneDoor, laneStatus, LANE_KEY, type AddressLane, type LaneStatus } from "@/lib/serverAddresses";
import { isLocked } from "@/lib/settingSource";
import type { SshHostCheck } from "@/lib/sshHost";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import { ProxyUrlControl, type ProxyEndpoints } from "./ProxyUrl";
import { EnvLine, useSettingText } from "./SettingRow";
import { fetchSshHostCheck, SshHostControl } from "./SshHost";

type LaneId = AddressLane["id"];

const ICON: Record<LaneId, LucideIcon> = { web: Globe, ssh: TerminalSquare, proxy: ArrowLeftRight };
const DOT: Record<LaneStatus["tone"], string> = { ok: "bg-success", warn: "bg-warning", bad: "bg-destructive", plain: "bg-muted-foreground/50" };
/** 沒設定時那一格旁邊的小字：跟著誰。/ The small note beside an unset address: what it follows. */
const BOX: Record<LaneStatus["tone"], string> = { ok: "border-border", plain: "border-border", warn: "border-warning/70", bad: "border-destructive/70" };
const FOLLOWS: Record<LaneId, TranslationKey> = { web: "settingsEnv.addr.webAuto", ssh: "settingsEnv.addr.sshFollows", proxy: "settingsEnv.addr.proxyFollows" };

// 寬的時候四欄（誰、位址、入口、展開鈕），窄的時候疊起來。標題列與每一條共用，欄才對得齊。
// Four columns when wide (who, address, door, toggle), stacked when narrow. Shared by the header and every lane so the columns line up.
const COLS = "@3xl:grid-cols-[minmax(0,5fr)_minmax(0,8fr)_minmax(0,5fr)_1.25rem]";

/** 位址兩邊的直線（寬的時候才畫）；沒設定 = 虛線。/ The straight line either side of the address (wide only); dashed when unset. */
function Line({ dashed, arrow = false }: { dashed: boolean; arrow?: boolean }) {
    return (
        <span className="hidden shrink-0 items-center text-muted-foreground/70 @3xl:flex" aria-hidden>
            <span className={cn("w-5 border-t border-muted-foreground/60", dashed && "border-dashed")} />
            {arrow && <ChevronRight size={14} className="-ml-1.5" />}
        </span>
    );
}

/** 「網頁位址」的編輯器：網址 + 儲存；留白 = 照每個請求判斷。/ The editor for "Web address": a URL and Save; blank = taken from each request. */
function WebUrlControl({ shown, locked, onSave, label, origin }: { shown: unknown; locked: boolean; onSave: (value: string) => void; label: string; origin: string }) {
    const { t } = useI18n();
    const saved = String(shown ?? "");
    const [draft, setDraft] = useState(saved);
    const dirty = !locked && tidyUrl(draft) !== tidyUrl(saved);
    const save = () => {
        if (dirty) onSave(tidyUrl(draft));
    };
    return (
        <div className="flex flex-wrap items-center gap-2">
            <Input
                type="url"
                className="h-8 w-full max-w-md font-mono"
                value={locked ? saved : draft}
                disabled={locked}
                placeholder={origin}
                aria-label={label}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") save();
                }}
            />
            {!locked && (
                <Button type="button" size="sm" variant="soft" disabled={!dirty} onClick={save}>
                    {t("common.save")}
                </Button>
            )}
            {!locked && saved.trim() !== "" && (
                <Button type="button" size="sm" variant="ghost" onClick={() => onSave("")}>
                    {t("settingsEnv.addr.webClear")}
                </Button>
            )}
        </div>
    );
}

export function ServerAddresses({ settings, onExplain }: { settings: ReturnType<typeof useSettingsPage>; onExplain: (key: string) => void }) {
    const { t } = useI18n();
    const { descriptionOf } = useSettingText();
    const { settingsObj: values, env, meta } = settings.state;
    const { handleUpdate } = settings.actions;
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    const lanes = addressLanes(values, env, origin);

    // 兩個即時檢查，圖與打開的編輯器共用：undefined = 還在查，null = 查不到。存了任何一個位址就重查。
    // The two live checks, shared by the diagram and the open editor: undefined = pending, null = unavailable. Saving any address re-runs them.
    const [check, setCheck] = useState<SshHostCheck | null | undefined>(undefined);
    const [endpoints, setEndpoints] = useState<ProxyEndpoints | null | undefined>(undefined);
    const inForceKey = Object.values(LANE_KEY).map((k) => inForce(values, env, k)).join("\n");
    const recheck = useCallback(async () => {
        const c = await fetchSshHostCheck();
        setCheck(c);
        return c !== null;
    }, []);
    useEffect(() => {
        let cancelled = false;
        void fetchSshHostCheck().then((c) => {
            if (!cancelled) setCheck(c);
        });
        void (async () => {
            let found: ProxyEndpoints | null = null;
            try {
                const res = await apiFetch("/api/proxy/tunnels");
                if (res.ok) found = ((await readJson(res)) as ProxyInfo | null)?.endpoints ?? null;
            } catch {
                // 讀不到 = null。/ Unavailable = null.
            }
            if (!cancelled) setEndpoints(found);
        })();
        return () => {
            cancelled = true;
        };
    }, [inForceKey]);

    const facts = { verdict: check?.verdict, webProxied: check?.web.proxied, proxyListening: endpoints ? endpoints.http_listening === true : undefined };
    // undefined = 還沒按過：有問題的那一條自己打開。/ undefined = untouched: the lane with a problem opens by itself.
    const [picked, setPicked] = useState<LaneId | null | undefined>(undefined);
    const open = picked === undefined ? firstProblem(lanes, facts) : picked;

    const doorText = (lane: AddressLane) => {
        const door = laneDoor(lane);
        if (door === "ssh") return check?.ssh.port ? t("settingsEnv.addr.sshDoorPort", { port: check.ssh.port }) : t("settingsEnv.addr.sshDoor");
        return t(door === "web" ? "settingsEnv.addr.webDoor" : "settingsEnv.addr.proxyDoor");
    };

    return (
        <div className="@container overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-card">
            {/* 三欄的名字，只在橫排時有。/ The three column names, only in the wide layout. */}
            <div className={cn("hidden items-center gap-x-3 border-b border-border/70 bg-surface px-6 py-2 text-xs text-muted-foreground @3xl:grid", COLS)} aria-hidden>
                <span>{t("settingsEnv.addr.colWho")}</span>
                <span className="pl-8">{t("settingsEnv.addr.colAddress")}</span>
                <span className="flex items-center gap-1.5">
                    <span className="grid size-4 place-items-center rounded-sm bg-brand-gradient text-white">
                        <TelepyGlyph size={11} />
                    </span>
                    {t("settingsEnv.addr.colDoor")}
                </span>
            </div>
            <ol className="divide-y divide-border/70" aria-label={t("settingsEnv.addr.aria")}>
                {lanes.map((lane) => {
                    const Icon = ICON[lane.id];
                    const key = LANE_KEY[lane.id];
                    const name = t(`settingsEnv.addr.${lane.id}`);
                    const status = laneStatus(lane, facts);
                    const locked = isLocked(env, key);
                    const isOpen = open === lane.id;
                    const shown = locked ? env[key]?.value : values[key];
                    const save = (v: string) => handleUpdate(key, v);
                    return (
                        <li key={lane.id}>
                            <button
                                type="button"
                                aria-expanded={isOpen}
                                aria-controls={`address-${lane.id}`}
                                onClick={() => setPicked(isOpen ? null : lane.id)}
                                className={cn(
                                    "grid w-full grid-cols-[minmax(0,1fr)_1.25rem] items-center gap-x-3 gap-y-2 px-4 py-3 text-left transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 sm:px-6",
                                    COLS,
                                    isOpen && "bg-surface",
                                )}
                            >
                                {/* 誰連。/ Who connects. */}
                                <span className="flex min-w-0 items-center gap-2.5">
                                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-foreground" aria-hidden>
                                        <Icon size={16} />
                                    </span>
                                    <span className="min-w-0 text-sm leading-snug text-foreground">{t(`settingsEnv.addr.${lane.id}Who`)}</span>
                                </span>

                                {/* 位址：名稱、現在生效的值、一行現況。/ The address: its name, the value in force, one status line. */}
                                <span className="col-span-2 flex min-w-0 items-center @3xl:col-span-1 @3xl:col-start-2 @3xl:row-start-1">
                                    <Line dashed={!lane.set} />
                                    <span className={cn("min-w-0 flex-1 rounded-md border px-3 py-1.5", lane.set ? "bg-background" : "border-dashed", status && status.tone !== "ok" && status.tone !== "plain" ? BOX[status.tone] : lane.set ? "border-border" : "border-muted-foreground/40")}>
                                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                            <span className="text-sm text-foreground">{name}</span>
                                            {locked && (
                                                <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
                                                    <Lock size={12} aria-hidden /> {env[key]?.var}
                                                </span>
                                            )}
                                            {!lane.set && <span className="text-xs text-muted-foreground">{t(FOLLOWS[lane.id])}</span>}
                                        </span>
                                        {lane.value && <code className={cn("mt-0.5 block font-mono text-xs leading-relaxed [overflow-wrap:anywhere]", lane.set ? "text-foreground" : "text-muted-foreground")}>{lane.value}</code>}
                                        {status && (
                                            <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                                                <span className={cn("size-1.5 shrink-0 rounded-full", DOT[status.tone])} aria-hidden />
                                                {t(`settingsEnv.addr.st.${status.key}`)}
                                            </span>
                                        )}
                                    </span>
                                    <Line dashed={!lane.set} arrow />
                                </span>

                                {/* 進 Telepy 的哪個入口，以及那個入口前面能不能有 CDN。/ Which door of Telepy, and whether a CDN may sit in front of it. */}
                                <span className="col-span-2 flex min-w-0 items-start gap-1.5 @3xl:col-span-1 @3xl:col-start-3 @3xl:row-start-1">
                                    <CornerDownRight size={14} className="mt-0.5 shrink-0 text-muted-foreground/70 @3xl:hidden" aria-hidden />
                                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 @3xl:flex-col @3xl:items-start">
                                        <span className="text-sm text-foreground">{doorText(lane)}</span>
                                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                            {lane.cdn ? <Cloud size={13} className="shrink-0" aria-hidden /> : <CloudOff size={13} className="shrink-0" aria-hidden />}
                                            {t(lane.cdn ? "settingsEnv.addr.cdnOk" : "settingsEnv.addr.cdnNo")}
                                        </span>
                                    </span>
                                </span>

                                <ChevronDown size={18} className={cn("col-start-2 row-start-1 justify-self-end text-muted-foreground transition-transform @3xl:col-start-4", isOpen && "rotate-180")} aria-hidden />
                                <span className="sr-only">{t("settingsEnv.addr.edit", { name })}</span>
                            </button>

                            {isOpen && (
                                <div id={`address-${lane.id}`} className="space-y-3 border-t border-border/70 px-4 py-4 sm:px-6">
                                    <p className="text-sm leading-relaxed text-muted-foreground">{descriptionOf(key, meta[key])}</p>
                                    {lane.id === "web" && <WebUrlControl key={`${String(shown)}-${locked}`} shown={shown} locked={locked} onSave={save} label={name} origin={origin} />}
                                    {lane.id === "ssh" && <SshHostControl key={`${String(shown)}-${locked}`} shown={shown} locked={locked} onSave={save} check={check} onRecheck={recheck} />}
                                    {lane.id === "proxy" && <ProxyUrlControl key={`${String(shown)}-${locked}`} shown={shown} locked={locked} onSave={save} endpoints={endpoints} />}
                                    <div>
                                        <p className="inline-block max-w-full rounded-md bg-muted px-1.5 py-px font-mono text-xs text-muted-foreground/80 [overflow-wrap:anywhere]">{key}</p>
                                        {env[key] && <EnvLine env={env[key]} onExplain={() => onExplain(key)} />}
                                    </div>
                                </div>
                            )}
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}
