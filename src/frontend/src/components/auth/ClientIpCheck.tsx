"use client";

/**
 * 網站設定 → 登入 →「Telepy 怎麼看你的位址」：用管理員自己的這個請求跑一次 `/api/auth/client-ip-check`，把
 * X-Forwarded-For 每一段、連進後端的那一段、選中哪一段畫成一條直線的路徑圖，附上判定、該改的設定，以及
 * 「拿假位址試試看」（訪客能不能自己決定被記成什麼位址）。
 * Site settings → Sign-in → "How Telepy sees your address": runs the check with the admin's own request and draws
 * every hop (X-Forwarded-For entries, the connection to the backend) on a straight path with the chosen one lit,
 * plus the verdict, what to change, and a made-up-address test (can a visitor choose the recorded address?).
 */
import React, { useCallback, useEffect, useState } from "react";
import { FlaskConical, Globe, Monitor, Network, RefreshCw, Server } from "lucide-react";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip, Property, PropertyList, SectionHeading } from "@/components/ui/section";
import { apiFetch, readJson } from "@/lib/api";
import { checkPassed, hopState, isPublicScope, parseClientIpCheck, probeHeaders, probeOutcome, viaCdn, type ClientIpCheck, type ProbeOutcome } from "@/lib/clientIp";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";

const ENDPOINT = "/api/auth/client-ip-check";

const SCOPE_KEY: Record<string, TranslationKey> = {
    public: "clientIp.scope.public",
    private: "clientIp.scope.private",
    loopback: "clientIp.scope.loopback",
    link_local: "clientIp.scope.linkLocal",
    shared_nat: "clientIp.scope.sharedNat",
    reserved: "clientIp.scope.reserved",
};

const ROLE_KEY: Record<string, TranslationKey> = {
    ignored: "clientIp.role.ignored",
    client: "clientIp.role.client",
    proxy: "clientIp.role.proxy",
};

async function runCheck(probe: boolean): Promise<ClientIpCheck | null> {
    const res = await apiFetch(ENDPOINT, probe ? { headers: probeHeaders() } : {});
    return res.ok ? parseClientIpCheck(await readJson<unknown>(res)) : null;
}

function ScopeChip({ scope }: { scope: string | null }) {
    const { t } = useI18n();
    if (!scope) return null;
    return <Chip tone={isPublicScope(scope) ? "success" : "warning"}>{t(SCOPE_KEY[scope] ?? "clientIp.scope.reserved")}</Chip>;
}

/** 位址 · 範圍，一行。/ Address and its scope on one line. */
function AddressLine({ ip, scope }: { ip: string; scope: string | null }) {
    const { t } = useI18n();
    return (
        <>
            <span className="font-mono break-all text-foreground">{ip}</span>
            {scope && <> · {t(SCOPE_KEY[scope] ?? "clientIp.scope.reserved")}</>}
        </>
    );
}

/**
 * 直線路徑：瀏覽器 ─ 每一段位址 ─ Telepy；選中的那段亮起。節點是矮的一列（圖示在左），一長串代理也不會把整塊撐高。
 * The straight path with the chosen hop lit; compact row nodes, so a long chain of proxies stays short.
 */
function HopDiagram({ check }: { check: ClientIpCheck }) {
    const { t } = useI18n();
    const passed = checkPassed(check);
    const items: React.ReactNode[] = [<FlowNode key="browser" compact icon={Monitor} title={t("clientIp.flow.browser")} state={passed ? "ok" : "waiting"} stateText={t("clientIp.flow.you")} />];
    check.chain.forEach((hop, i) => {
        const peer = hop.source === "peer";
        items.push(<FlowLink key={`l${i}`} compact label={peer ? t("clientIp.flow.connects") : "X-Forwarded-For"} state={hop.role === "client" ? hopState(hop) : "waiting"} />);
        items.push(
            <FlowNode
                key={`h${i}`}
                compact
                icon={peer ? Server : Network}
                title={peer ? t("clientIp.flow.peer") : t("clientIp.flow.hop", { n: i + 1 })}
                sub={<AddressLine ip={hop.ip} scope={hop.scope} />}
                state={hopState(hop)}
                stateText={t(ROLE_KEY[hop.role])}
            />,
        );
    });
    items.push(<FlowLink key="lt" compact label={t("clientIp.flow.records")} state={passed ? "ok" : "failed"} />);
    items.push(
        <FlowNode
            key="telepy"
            compact
            brand
            title="Telepy"
            sub={check.ip ? <AddressLine ip={check.ip} scope={null} /> : t("clientIp.unknownIp")}
            state={passed ? "ok" : "failed"}
            stateText={t(passed ? "clientIp.flow.public" : "clientIp.flow.notPublic")}
        />,
    );
    return <FlowPath>{items}</FlowPath>;
}

function VerdictCallout({ check }: { check: ClientIpCheck }) {
    const { t, tn } = useI18n();
    const code = (s: string) => <code>{s}</code>;
    const v = check.verdict;
    const vars = {
        ip: check.ip ?? "?",
        n: String(check.suggestHops ?? ""),
        header: check.suggestHeader ?? check.clientIpHeader ?? "",
    };
    if (v === "ok") {
        return (
            <Callout tone="info" title={t("clientIp.v.okTitle", { ip: vars.ip })}>
                {t("clientIp.v.okBody")}
            </Callout>
        );
    }
    const body: Record<Exclude<typeof v, "ok">, React.ReactNode> = {
        hops_too_low: tn("clientIp.v.hopsBody", { setting: code(`TRUSTED_PROXY_HOPS=${vars.n}`) }),
        hops_too_high: tn("clientIp.v.hopsBody", { setting: code(`TRUSTED_PROXY_HOPS=${vars.n}`) }),
        use_header: tn("clientIp.v.useHeaderBody", { setting: code(`CLIENT_IP_HEADER=${vars.header}`) }),
        header_private: tn("clientIp.v.headerPrivateBody", { header: code(vars.header), ip: code(vars.ip) }),
        // 完全沒有 X-Forwarded-For：沒經過代理，直接連到後端（同一台機器 / 同一個網路）。
        // No X-Forwarded-For at all: nothing in front, the backend was reached directly.
        all_private: check.chain.every((h) => h.source === "peer") ? tn("clientIp.v.directBody", { ip: code(vars.ip) }) : tn("clientIp.v.allPrivateBody", { ip: code(vars.ip) }),
        unknown: t("clientIp.v.unknownBody"),
    };
    const title: Record<Exclude<typeof v, "ok">, string> = {
        hops_too_low: t("clientIp.v.hopsTooLowTitle"),
        hops_too_high: t("clientIp.v.hopsTooHighTitle"),
        use_header: t("clientIp.v.useHeaderTitle", { header: vars.header }),
        header_private: t("clientIp.v.headerPrivateTitle"),
        all_private: t("clientIp.v.allPrivateTitle"),
        unknown: t("clientIp.v.unknownTitle"),
    };
    return (
        <Callout tone="warning" title={title[v]}>
            {body[v]}
        </Callout>
    );
}

/**
 * 「每一段都是內部位址」時：要改的是 Telepy 前面的代理。CDN 的標頭在這種判定下不會帶公網位址（帶的話判定是
 * use_header），所以不建議 CLIENT_IP_HEADER；一個 CDN 標頭都沒收到時反而要提醒「這個請求沒經過 CDN」。
 * When every hop is internal: what to change on the proxy. A CDN header can't hold a public address under this
 * verdict (that would be use_header), so CLIENT_IP_HEADER is never suggested; with no CDN header at all, say that
 * the request did not pass a CDN (a Cloudflare record set to DNS only).
 */
function ProxyFix({ check }: { check: ClientIpCheck }) {
    const { t, tn } = useI18n();
    const code = (s: string) => <code>{s}</code>;
    return (
        <div className="space-y-2 rounded-lg border border-border bg-surface px-4 py-3 text-sm">
            <p className="text-foreground">{t("clientIp.fix.title")}</p>
            <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
                <li>{tn("clientIp.fix.hostNet", { mode: code("network_mode: host") })}</li>
                <li>{tn("clientIp.fix.ipv6", { setting: code('"userland-proxy": false') })}</li>
                {!viaCdn(check) && <li>{tn("clientIp.fix.noCdn", { header: code("CF-Connecting-IP"), setting: code("CLIENT_IP_HEADER") })}</li>}
                <li>{tn("clientIp.fix.after", { setting: code("TRUSTED_PROXY_HOPS") })}</li>
                <li>{t("clientIp.fix.outside")}</li>
            </ul>
        </div>
    );
}

export function ClientIpCheckPanel() {
    const { t, tn } = useI18n();
    const [check, setCheck] = useState<ClientIpCheck | null>(null);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [probe, setProbe] = useState<{ outcome: ProbeOutcome; ip: string | null } | null>(null);
    const [probing, setProbing] = useState(false);

    const load = useCallback(async () => {
        setBusy(true);
        try {
            const c = await runCheck(false);
            setCheck(c);
            setFailed(!c);
        } catch {
            setFailed(true);
        } finally {
            setBusy(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const tryProbe = async () => {
        setProbing(true);
        try {
            const c = await runCheck(true);
            setProbe(c ? { outcome: probeOutcome(c), ip: c.ip } : null);
            if (!c) setFailed(true);
        } catch {
            setFailed(true);
        } finally {
            setProbing(false);
        }
    };

    const code = (s: string) => <code>{s}</code>;
    // 修法清單出現時右欄已經夠長，「拿假位址試試看」放到整塊最下面；不然放右欄，兩欄差不多高。
    // With the fix list the right column is long already, so the made-up-address test goes below both columns;
    // otherwise it joins the right column and the two come out about the same height.
    const showFix = !!check && check.verdict === "all_private" && check.chain.some((h) => h.source === "forwarded_for");
    const probeBlock = (c: ClientIpCheck) => (
        <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
                <Button type="button" size="sm" variant="outline" onClick={() => void tryProbe()} disabled={probing}>
                    <FlaskConical size={15} /> {t("clientIp.probe.button")}
                </Button>
                <span className="text-xs text-muted-foreground">{t("clientIp.probe.hint")}</span>
            </div>
            {probe &&
                (probe.outcome === "safe" ? (
                    <Callout tone="info">{t("clientIp.probe.safe")}</Callout>
                ) : probe.outcome === "real_ip" ? (
                    <Callout tone="danger" title={t("clientIp.probe.spoofableTitle")}>
                        <p>{tn("clientIp.probe.realIp", { ip: code(probe.ip ?? ""), setting: code("set_real_ip_from") })}</p>
                        {/* 每一段都是內部位址時，這和上面是同一個原因。/ With every hop internal this is the same cause as above. */}
                        {c.verdict === "all_private" && c.ip && <p className="mt-1.5">{tn("clientIp.probe.sameCause", { ip: code(c.ip) })}</p>}
                    </Callout>
                ) : (
                    <Callout tone="danger" title={t("clientIp.probe.spoofableTitle")}>
                        {tn("clientIp.probe.forwardedFor", { ip: code(probe.ip ?? ""), setting: code(`TRUSTED_PROXY_HOPS=${c.trustedProxyHops}`) })}
                    </Callout>
                ))}
        </div>
    );

    return (
        <section id="client-ip" className="@container scroll-mt-20 overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-card">
            <div className="space-y-4 p-4 sm:px-6 sm:pt-5 sm:pb-5">
                <SectionHeading
                    icon={<Globe />}
                    title={<span className="whitespace-normal">{t("clientIp.title")}</span>}
                    description={t("clientIp.description")}
                    action={
                        <Button type="button" size="sm" variant="ghost" onClick={() => void load()} disabled={busy} aria-label={t("clientIp.recheck")} title={t("clientIp.recheck")}>
                            <RefreshCw size={15} className={busy ? "animate-spin" : undefined} /> <span className="hidden sm:inline">{t("clientIp.recheck")}</span>
                        </Button>
                    }
                />
                {failed && !check ? (
                    <p className="text-xs text-destructive">{t("clientIp.failed")}</p>
                ) : !check ? (
                    <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
                ) : (
                    <>
                        {/* 路徑圖一律直排（矮節點）。卡片夠寬（容器 ≥ 56rem，右欄至少約 33rem）時放左欄，右欄依序是判定與修法、目前的設定值；
                            窄時判定在最上面。右欄 grid 列是 auto + 1fr：路徑圖跨兩列，多出來的高度只給第二列，判定與設定值之間不留空。
                            The path is always a column of short nodes. In a wide card (container ≥ 56rem, so the right column gets ~33rem or more) it sits on the left
                            and the right holds the verdict + fix, then the current values; narrow cards put the verdict first.
                            Rows are auto + 1fr so the path's extra height goes to the second row, never between the two. */}
                        <div className="grid gap-4 @4xl:grid-cols-[minmax(0,19rem)_minmax(0,1fr)] @4xl:grid-rows-[auto_1fr] @4xl:items-start">
                            <div className="space-y-4 @4xl:col-start-2 @4xl:row-start-1">
                                <VerdictCallout check={check} />
                                {showFix && <ProxyFix check={check} />}
                                {check.shortChain && <Callout tone="warning">{tn("clientIp.shortChain", { setting: code(`TRUSTED_PROXY_HOPS=${check.trustedProxyHops}`) })}</Callout>}
                                {check.headerAbsent && check.clientIpHeader && <Callout tone="info">{tn("clientIp.headerAbsent", { header: code(check.clientIpHeader) })}</Callout>}
                            </div>
                            <div className="space-y-2 @4xl:col-start-1 @4xl:row-span-2 @4xl:row-start-1">
                                <HopDiagram check={check} />
                                <p className="text-xs text-muted-foreground">{t("clientIp.chainNote")}</p>
                            </div>
                            <div className="space-y-4 @4xl:col-start-2 @4xl:row-start-2">
                                <PropertyList>
                                    <Property label={t("clientIp.recorded")}>
                                        <span className="inline-flex flex-wrap items-center gap-2">
                                            <span className="font-mono">{check.ip ?? t("clientIp.unknownIp")}</span>
                                            <ScopeChip scope={check.scope} />
                                            {check.from && <span className="text-xs text-muted-foreground">{check.from === "header" ? t("clientIp.fromHeader", { header: check.clientIpHeader ?? "" }) : t("clientIp.fromChain")}</span>}
                                        </span>
                                    </Property>
                                    <Property label={t("clientIp.hops")}>
                                        <span className="font-mono">TRUSTED_PROXY_HOPS={check.trustedProxyHops}</span>
                                    </Property>
                                    <Property label={t("clientIp.header")}>
                                        {check.clientIpHeader ? <span className="font-mono">CLIENT_IP_HEADER={check.clientIpHeader}</span> : <span className="text-muted-foreground">{t("clientIp.headerUnset")}</span>}
                                    </Property>
                                    <Property label={t("clientIp.otherHeaders")}>
                                        {check.headers.length === 0 ? (
                                            <span className="text-muted-foreground">{t("clientIp.none")}</span>
                                        ) : (
                                            <ul className="space-y-1">
                                                {check.headers.map((h) => (
                                                    <li key={h.name} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                                        <span className="font-mono text-xs text-muted-foreground">{h.name}</span>
                                                        <span className="font-mono text-xs break-all">{h.value}</span>
                                                        {h.addresses[0] && <ScopeChip scope={h.addresses.some((a) => isPublicScope(a.scope)) ? "public" : h.addresses[0].scope} />}
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </Property>
                                </PropertyList>
                                {!showFix && probeBlock(check)}
                            </div>
                        </div>

                        {showFix && probeBlock(check)}
                    </>
                )}
            </div>
        </section>
    );
}
