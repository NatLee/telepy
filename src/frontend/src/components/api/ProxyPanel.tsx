"use client";

/**
 * API 頁的「代理」分頁：把通道當成網路代理。最上面是路徑圖（你的程式 ─ token ─ Telepy ─ 通道 ─ 裝置 ─ 目的地），
 * 每一站照現在的狀態亮（沒開、沒權限、通道不能用就停在那裡）；接著是進來的路（網頁 port 上的 WebSocket，以及有設定
 * 才有的標準代理位址——沒設定時說明預設就是走 WebSocket，跟 SSH 走網頁 port 一樣）、填好你的通道的範例，以及現在開著
 * 的代理 session（可以結束）。
 * The API page's "Proxy" tab: a tunnel as a network proxy. On top the path (your program ─ token ─ Telepy ─ tunnel ─
 * device ─ destination), each stop lit by the current state (it stops where the switch, the permission or the tunnel
 * says no); then the ways in (a WebSocket on the web port, and the standard proxy address when one is configured —
 * without one it says the default is the WebSocket, the way SSH rides the web port), examples filled with your tunnel,
 * and the proxy sessions open right now (which can be ended).
 */
import React, { useMemo, useState } from "react";
import Link from "next/link";
import { AppWindow, ArrowRight, Globe, HardDrive, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { CopyButton } from "@/components/ui/CopyButton";
import { Field } from "@/components/ui/field";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { StatusDot } from "@/components/tunnels/TunnelStatus";
import { useProxy } from "@/hooks/useProxy";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { BLOCKED_KEY, bytes, cliExample, firstTunnel, httpProxyExample, listExample, pathStates, proxyState, pythonExample, type ProxySession } from "@/lib/proxy";

function Lane({ title, hint, value, children }: { title: string; hint: string; value?: string | null; children?: React.ReactNode }) {
    return (
        <div className="min-w-0 space-y-1.5 rounded-xl border border-border bg-card p-3">
            <div className="text-sm text-foreground">{title}</div>
            <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
            {value && (
                <div className="flex min-w-0 items-center gap-1 rounded-md bg-muted/60 py-1 pl-2 pr-1">
                    <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={value}>{value}</code>
                    <CopyButton value={value} />
                </div>
            )}
            {children}
        </div>
    );
}

function SessionRow({ s, onEnd }: { s: ProxySession; onEnd: (id: string) => Promise<boolean> }) {
    const { t, locale } = useI18n();
    const [ending, setEnding] = useState(false);
    return (
        <li className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
            <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-baseline gap-x-2 text-sm text-foreground">
                    <span className="[overflow-wrap:anywhere]">{s.client_name}</span>
                    <ArrowRight size={13} className="shrink-0 self-center text-muted-foreground" aria-hidden />
                    <span className="[overflow-wrap:anywhere]">{s.tunnel.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">{s.username}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                    {t("proxy.session.line", { open: s.connections, total: s.connections_total, up: bytes(s.bytes_up), down: bytes(s.bytes_down), since: new Date(s.opened_at).toLocaleTimeString(locale) })}
                </p>
                {s.targets.length > 0 && (
                    <p className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        {s.targets.join(", ")}
                        {s.targets_more > 0 ? ` +${s.targets_more}` : ""}
                    </p>
                )}
            </div>
            <Button
                variant="outline"
                size="sm"
                disabled={ending}
                onClick={async () => {
                    setEnding(true);
                    await onEnd(s.id);
                    setEnding(false);
                }}
            >
                <Unplug size={14} /> {t("proxy.session.end")}
            </Button>
        </li>
    );
}

export function ProxyPanel({ baseUrl }: { baseUrl: string }) {
    const { t, tn } = useI18n();
    const { user } = useAuth();
    const { info, sessions, failed, reload, end } = useProxy();
    const [picked, setPicked] = useState<number | null>(null);
    const tunnel = useMemo(() => (info ? info.tunnels.find((x) => x.id === picked) ?? firstTunnel(info.tunnels) : null), [info, picked]);

    if (!info) {
        return <p className="text-sm text-muted-foreground">{failed ? t("proxy.loadFailed") : t("common.loading")}</p>;
    }
    const state = proxyState(info);
    const spots = pathStates(state, tunnel);
    const name = tunnel?.name ?? "<tunnel>";
    const code = (s: string) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{s}</code>;

    return (
        <div className="space-y-5">
            {state === "off" && (
                <Callout tone="warning" title={t("proxy.off.title")}>
                    {t("proxy.off.body")}{" "}
                    {user?.is_superuser && (
                        <Link href="/tunnels/settings?tab=proxy" prefetch={false} className="inline-flex items-center gap-1 text-foreground underline underline-offset-2">
                            {t("proxy.off.link")} <ArrowRight size={12} className="opacity-60" />
                        </Link>
                    )}
                </Callout>
            )}
            {state === "denied" && <Callout tone="warning">{t("proxy.denied")}</Callout>}

            {/* 路徑：每一站照現在的狀態亮。/ The path, each stop lit by the current state. */}
            <section aria-label={t("proxy.path.title")} className="space-y-2 rounded-xl border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm text-foreground">{t("proxy.path.title")}</h3>
                    <RefreshButton onRefresh={reload} variant="ghost" size="sm" iconSize={14} label={t("common.refresh")} />
                </div>
                <FlowPath>
                    <FlowNode compact icon={AppWindow} title={t("proxy.path.app")} sub={t("proxy.path.appSub")} state={spots.app} />
                    <FlowLink compact label={tn("proxy.path.token", { scope: code(info.scope) })} state={spots.token} />
                    <FlowNode compact brand title="Telepy" sub={t("proxy.path.telepySub")} state={spots.telepy} />
                    <FlowLink compact label={t("proxy.path.tunnel")} state={spots.tunnel} />
                    <FlowNode compact icon={HardDrive} title={name} sub={tunnel?.blocked ? t(BLOCKED_KEY[tunnel.blocked]) : t("proxy.path.deviceSub")} state={spots.device} />
                    <FlowLink compact label={t("proxy.path.out")} state={spots.device} />
                    <FlowNode compact icon={Globe} title={t("proxy.path.target")} sub={t("proxy.path.targetSub")} state={spots.device} />
                </FlowPath>
                <p className="text-xs leading-relaxed text-muted-foreground">{t("proxy.path.note", { max: info.max_connections, idle: info.idle_seconds })}</p>
            </section>

            {/* 進來的兩條路。/ The two ways in. */}
            <section aria-label={t("proxy.ways.title")} className="space-y-2">
                <h3 className="text-sm text-foreground">{t("proxy.ways.title")}</h3>
                <div className="grid gap-3 lg:grid-cols-2">
                    <Lane title={t("proxy.ways.ws")} hint={t("proxy.ways.wsHint")} value={info.endpoints.websocket} />
                    {info.endpoints.http_proxy ? (
                        <Lane title={t("proxy.ways.http")} hint={t("proxy.ways.httpHint")} value={info.endpoints.http_proxy} />
                    ) : (
                        <Lane title={t("proxy.ways.http")} hint={t("proxy.ways.httpUnset")}>
                            <p className="text-xs leading-relaxed text-muted-foreground">{tn("proxy.ways.httpUnsetCli", { cmd: code("telepy proxy") })}</p>
                        </Lane>
                    )}
                </div>
            </section>

            {/* 範例：填好你的通道。/ Examples with your tunnel filled in. */}
            <section aria-label={t("proxy.examples.title")} className="space-y-3">
                <div className="flex flex-wrap items-end justify-between gap-3">
                    <h3 className="text-sm text-foreground">{t("proxy.examples.title")}</h3>
                    {info.tunnels.length > 0 && (
                        <Field label={t("proxy.examples.tunnel")} className="w-full sm:w-64">
                            <Select value={tunnel ? String(tunnel.id) : ""} onValueChange={(v) => setPicked(Number(v))}>
                                <SelectTrigger className="h-9 w-full text-sm" aria-label={t("proxy.examples.tunnel")}>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {info.tunnels.map((x) => (
                                        <SelectItem key={x.id} value={String(x.id)}>
                                            <span className="flex items-center gap-2">
                                                <StatusDot online={x.online === true} />
                                                <span className="truncate">{x.name}</span>
                                                {x.blocked && <span className="text-xs text-muted-foreground">{t(BLOCKED_KEY[x.blocked])}</span>}
                                            </span>
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                    )}
                </div>
                <div className="space-y-1.5">
                    <p className="text-sm text-foreground">{t("proxy.examples.cli")}</p>
                    <p className="text-xs leading-relaxed text-muted-foreground">{t("proxy.examples.cliHint")}</p>
                    <CodeBlock language="bash" value={cliExample(name)} />
                </div>
                {info.endpoints.http_proxy && (
                    <div className="space-y-1.5">
                        <p className="text-sm text-foreground">{t("proxy.examples.http")}</p>
                        <p className="text-xs leading-relaxed text-muted-foreground">{t("proxy.examples.httpHint")}</p>
                        <CodeBlock language="bash" value={httpProxyExample(info.endpoints.http_proxy, name)} />
                    </div>
                )}
                <div className="space-y-1.5">
                    <p className="text-sm text-foreground">{t("proxy.examples.app")}</p>
                    <p className="text-xs leading-relaxed text-muted-foreground">{tn("proxy.examples.appHint", { scope: code(info.scope) })}</p>
                    <CodeBlock language="bash" value={listExample(baseUrl)} />
                    <CodeBlock language="python" value={pythonExample(info.endpoints.websocket, name)} />
                </div>
            </section>

            {/* 開著的代理 session。/ The open proxy sessions. */}
            <section aria-label={t("proxy.session.title")} className="space-y-2">
                <h3 className="text-sm text-foreground">{t("proxy.session.title")}</h3>
                {sessions.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">{t("proxy.session.none")}</p>
                ) : (
                    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                        {sessions.map((s) => (
                            <SessionRow key={s.id} s={s} onEnd={end} />
                        ))}
                    </ul>
                )}
                <p className="text-xs leading-relaxed text-muted-foreground">{t("proxy.session.note")}</p>
            </section>
        </div>
    );
}
