"use client";

/**
 * 管理區 → 伺服器狀態 →「Telepy 怎麼看你的位址」：用管理員自己的這個請求跑一次 `/api/auth/client-ip-check`，把
 * X-Forwarded-For 每一段、連進後端的那一段、選中哪一段畫成一條直線的路徑圖，附上判定、該改的設定，以及
 * 「拿假位址試試看」（訪客能不能自己決定被記成什麼位址）。`TRUSTED_PROXY_HOPS` 是 `auto`（內部位址都算代理）
 * 或固定層數，兩種的說法不同。
 * Admin → Server health → "How Telepy sees your address": runs the check with the admin's own request and draws
 * every hop (X-Forwarded-For entries, the connection to the backend) on a straight path with the chosen one lit,
 * plus the verdict, what to change, and a made-up-address test (can a visitor choose the recorded address?).
 * `TRUSTED_PROXY_HOPS` is `auto` (every internal address is a proxy) or a fixed count; the wording follows.
 */
import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, FlaskConical, Globe, Monitor, Network, Server } from "lucide-react";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { Button } from "@/components/ui/button";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Callout } from "@/components/ui/callout";
import { Chip, Property, PropertyList, SectionHeading } from "@/components/ui/section";
import { apiFetch, readJson } from "@/lib/api";
import { VISITOR_SETTINGS_HREF, checkPassed, hopState, hopsSetting, isPublicScope, parseClientIpCheck, probeHeaders, probeOutcome, viaCdn, type ClientIpCheck, type CloudflareMode, type ProbeOutcome } from "@/lib/clientIp";
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

/** 窄欄（手機、放大顯示）把標籤疊在值上面，位址不會一字一行。/ Narrow column (phones, large display size): label above value, so addresses don't break per character. */
const STACK = "@max-xs:grid-cols-1 @max-xs:gap-1";

const ROLE_KEY: Record<string, TranslationKey> = {
    ignored: "clientIp.role.ignored",
    client: "clientIp.role.client",
    proxy: "clientIp.role.proxy",
};

const CF_MODE_KEY: Record<CloudflareMode, TranslationKey> = {
    auto: "settingsEnv.cf.auto",
    always: "settingsEnv.cf.always",
    off: "settingsEnv.cf.off",
};

/**
 * 「設定 → 伺服器 → 訪客位址」的連結：修法都指到那裡（.env 有設的值仍以 .env 為準，那裡會鎖住並說明）。
 * The link to Settings → Server → Visitor addresses, where every fix points (a value set in .env still wins; the
 * page shows it locked and says so).
 */
function WhereLink() {
    const { t } = useI18n();
    return (
        <Link href={VISITOR_SETTINGS_HREF} prefetch={false} className="inline-flex items-center gap-0.5 text-foreground underline underline-offset-2">
            {t("clientIp.where")} <ArrowRight size={12} className="opacity-60" aria-hidden />
        </Link>
    );
}

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
    // 自動模式下只有「前面有一台公網 IP 的代理」會到這裡（被當成訪客了），要改成固定層數；固定層數時是層數算錯，
    // 也可以改成 auto。/ In auto mode only a public-address proxy in front lands here (taken for the visitor): set a
    // fixed count. With a fixed count the number is off — or switch to auto.
    const where = <WhereLink />;
    const hopsBody =
        check.hopsMode === "auto"
            ? tn("clientIp.v.hopsBodyAuto", { setting: code(vars.n), where })
            : tn("clientIp.v.hopsBody", { setting: code(vars.n), auto: code("auto"), where });
    const body: Record<Exclude<typeof v, "ok">, React.ReactNode> = {
        hops_too_low: hopsBody,
        hops_too_high: hopsBody,
        use_header: tn("clientIp.v.useHeaderBody", { setting: code(vars.header), where }),
        header_private: tn("clientIp.v.headerPrivateBody", { header: code(vars.header), ip: code(vars.ip), where }),
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
    // 指到設定頁的修法都提一句：.env 有設的值以 .env 為準。/ Fixes that point at the page add: .env still wins.
    const pointsAtPage = v === "hops_too_low" || v === "hops_too_high" || v === "use_header" || v === "header_private";
    return (
        <Callout tone="warning" title={title[v]}>
            {body[v]}
            {pointsAtPage && <p className="mt-1.5">{tn("clientIp.envWins", { hops: code("TRUSTED_PROXY_HOPS"), header: code("CLIENT_IP_HEADER") })}</p>}
        </Callout>
    );
}

/**
 * Cloudflare 的標頭到了，卻看不到 Cloudflare 的位址：Telepy 前面的代理（例如 Docker 裡的 Nginx Proxy Manager）把
 * Cloudflare 的位址換成了自己網路的，自動模式不能信這個標頭。修代理，或確定每個請求都經過 Cloudflare 時才選「一律採用」。
 * The Cloudflare header arrived but no Cloudflare address is visible: the proxy in front replaced it, so auto mode
 * can't trust the header. Fix the proxy, or choose "Always" only if every request comes through Cloudflare.
 */
function CloudflareMasked({ check }: { check: ClientIpCheck }) {
    const { t, tn } = useI18n();
    const code = (s: string) => <code>{s}</code>;
    return (
        <Callout tone="warning" title={t("clientIp.cf.maskedTitle")}>
            {tn("clientIp.cf.maskedBody", {
                header: code("CF-Connecting-IP"),
                ip: code(check.cloudflare?.header ?? "?"),
                always: <span className="text-foreground">{t("settingsEnv.cf.always")}</span>,
                where: <WhereLink />,
            })}
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
                {!viaCdn(check) && <li>{tn("clientIp.fix.noCdn", { header: code("CF-Connecting-IP"), setting: <span className="text-foreground">{t("siteSettings.client_ip_header.label")}</span> })}</li>}
                <li>{tn("clientIp.fix.after", { setting: code("auto"), where: <WhereLink /> })}</li>
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

    // 回傳有沒有拿到（重新檢查鈕的勾勾）。/ Answers whether the check came back (the Recheck button's check).
    const load = useCallback(async () => {
        setBusy(true);
        try {
            const c = await runCheck(false);
            setCheck(c);
            setFailed(!c);
            return !!c;
        } catch {
            setFailed(true);
            return false;
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
                ) : probe.outcome === "auto_internal" ? (
                    // 自動模式 + 管理員自己在內網：內部位址都算代理，所以越過了自己的位址。只有內網的人能這樣，而且只能改自己的紀錄。
                    // Auto mode with the admin on an internal address: every internal address is a proxy, so theirs was skipped.
                    <Callout tone="warning" title={t("clientIp.probe.autoInternalTitle")}>
                        {tn("clientIp.probe.autoInternal", { ip: code(probe.ip ?? ""), setting: code("auto"), where: <WhereLink /> })}
                    </Callout>
                ) : (
                    <Callout tone="danger" title={t("clientIp.probe.spoofableTitle")}>
                        {tn("clientIp.probe.forwardedFor", { ip: code(probe.ip ?? ""), setting: code(hopsSetting(c)), where: <WhereLink /> })}
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
                        <RefreshButton
                            type="button"
                            size="sm"
                            variant="ghost"
                            iconSize={15}
                            onRefresh={load}
                            busy={busy}
                            label={<span className="hidden sm:inline">{t("clientIp.recheck")}</span>}
                            aria-label={t("clientIp.recheck")}
                            title={t("clientIp.recheck")}
                        />
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
                        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 @4xl:grid-cols-[minmax(0,19rem)_minmax(0,1fr)] @4xl:grid-rows-[auto_1fr] @4xl:items-start">
                            <div className="space-y-4 @4xl:col-start-2 @4xl:row-start-1">
                                <VerdictCallout check={check} />
                                {showFix && <ProxyFix check={check} />}
                                {check.cloudflareMasked && <CloudflareMasked check={check} />}
                                {check.shortChain && <Callout tone="warning">{tn("clientIp.shortChain", { setting: code(hopsSetting(check)), where: <WhereLink /> })}</Callout>}
                                {check.headerAbsent && check.clientIpHeader && <Callout tone="info">{tn("clientIp.headerAbsent", { header: code(check.clientIpHeader) })}</Callout>}
                            </div>
                            <div className="space-y-2 @4xl:col-start-1 @4xl:row-span-2 @4xl:row-start-1">
                                <HopDiagram check={check} />
                                <p className="text-xs text-muted-foreground">{t("clientIp.chainNote")}</p>
                            </div>
                            <div className="space-y-4 @4xl:col-start-2 @4xl:row-start-2">
                                <PropertyList className="@container">
                                    <Property className={STACK} label={t("clientIp.recorded")}>
                                        <span className="inline-flex max-w-full flex-wrap items-center gap-2">
                                            <span className="min-w-0 font-mono [overflow-wrap:anywhere]">{check.ip ?? t("clientIp.unknownIp")}</span>
                                            <ScopeChip scope={check.scope} />
                                            {check.from && <span className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">{check.from === "header" ? t("clientIp.fromHeader", { header: check.clientIpHeader ?? "" }) : t("clientIp.fromChain")}</span>}
                                        </span>
                                    </Property>
                                    <Property className={STACK} label={t("clientIp.hops")}>
                                        <span className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1">
                                            <span className="min-w-0 font-mono [overflow-wrap:anywhere]">{hopsSetting(check)}</span>
                                            <span className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                                                {check.hopsMode === "auto" ? t("clientIp.hopsAuto", { n: String(check.skippedHops) }) : t("clientIp.hopsFixed")}
                                            </span>
                                        </span>
                                    </Property>
                                    <Property className={STACK} label={t("clientIp.header")}>
                                        {check.clientIpHeader ? <span className="font-mono [overflow-wrap:anywhere]">{check.clientIpHeader}</span> : <span className="text-muted-foreground">{t("clientIp.headerUnset")}</span>}
                                    </Property>
                                    {check.cloudflare && (
                                        <Property className={STACK} label="Cloudflare">
                                            <span className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1">
                                                <span>{t(CF_MODE_KEY[check.cloudflare.mode])}</span>
                                                <Chip tone={check.cloudflare.used ? "success" : "neutral"}>{t(check.cloudflare.used ? "clientIp.cf.used" : "clientIp.cf.notUsed")}</Chip>
                                            </span>
                                            <span className="mt-0.5 block text-xs text-muted-foreground [overflow-wrap:anywhere]">
                                                CF-Connecting-IP: {check.cloudflare.header ? <span className="font-mono text-foreground">{check.cloudflare.header}</span> : t("clientIp.cf.noHeader")}
                                                {" · "}
                                                {t(check.cloudflare.edgeSeen ? "clientIp.cf.edgeSeen" : "clientIp.cf.edgeNotSeen")}
                                            </span>
                                        </Property>
                                    )}
                                    <Property className={STACK} label={t("clientIp.otherHeaders")}>
                                        {check.headers.length === 0 ? (
                                            <span className="text-muted-foreground">{t("clientIp.none")}</span>
                                        ) : (
                                            <ul className="space-y-1">
                                                {check.headers.map((h) => (
                                                    <li key={h.name} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                                        <span className="min-w-0 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{h.name}</span>
                                                        <span className="min-w-0 font-mono text-xs break-all">{h.value}</span>
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
