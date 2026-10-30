"use client";

/**
 * 網站設定 → 伺服器 →「SSH 主機」：輸入框 + 即時檢查（網頁與 SSH 的名稱各解析到哪裡、有沒有走 Cloudflare 的代理）+
 * 結論，以及「為什麼要兩個名稱？」的說明圖：網頁與 SSH 兩條路並排，可以切換「網頁名稱走不走代理」「SSH 用自己的名稱
 * 還是網頁的」，看哪一段會斷。
 * Site settings → Server → "SSH host": the input, a live check (where the web and SSH names point, whether either is
 * on Cloudflare's proxy) with its verdict, and the "Why two names?" explainer: the web lane and the SSH lane side by
 * side, with switches for "is the web name proxied" and "does SSH use its own name", showing which part breaks.
 */
import React, { useCallback, useEffect, useState } from "react";
import { ArrowRight, Cloud, Cpu, Globe, Info, Route } from "lucide-react";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Chip, SectionHeading } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { apiFetch } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { hostProblem, initialScenario, lanes, parseSshHostCheck, tidyHost, verdictTone, type NameLookup, type SshHostCheck } from "@/lib/sshHost";
import type { TranslationKey } from "@/locales/en";

/** 一個名稱的狀態標籤。/ The chip saying where a name points. */
function WhereChip({ lookup, proxied }: { lookup: NameLookup; proxied: boolean }) {
    const { t } = useI18n();
    if (lookup.error || lookup.addresses.length === 0) return <Chip tone="danger">{t("sshHost.chip.unresolved")}</Chip>;
    if (proxied) {
        return (
            <Chip tone="warning">
                <Cloud aria-hidden /> {t("sshHost.chip.proxy")}
            </Chip>
        );
    }
    if (lookup.host === "localhost" || lookup.addresses.every((a) => a === "127.0.0.1" || a === "::1")) return <Chip>{t("sshHost.chip.local")}</Chip>;
    return <Chip tone="success">{t("sshHost.chip.dnsOnly")}</Chip>;
}

/** 檢查結果的一列：網頁或 SSH。/ One row of the check: web or SSH. */
function NameRow({ label, host, lookup, proxied, from }: { label: string; host: string; lookup: NameLookup; proxied: boolean; from: React.ReactNode }) {
    const shown = lookup.addresses.slice(0, 2).join(", ");
    const more = lookup.addresses.length - 2;
    return (
        <li className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm">
            <span className="w-10 shrink-0 text-xs text-muted-foreground">{label}</span>
            <span className="min-w-0 font-mono text-foreground [overflow-wrap:anywhere]">{host}</span>
            {lookup.addresses.length > 0 && (
                <span className="inline-flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    <ArrowRight size={12} aria-hidden /> {shown}
                    {more > 0 && ` +${more}`}
                </span>
            )}
            <WhereChip lookup={lookup} proxied={proxied} />
            <span className="ml-auto">{from}</span>
        </li>
    );
}

/** 問一次檢查；查不到 = null。/ Ask for the check once; null when unavailable. */
async function fetchCheck(): Promise<SshHostCheck | null> {
    try {
        const r = await apiFetch("/api/site/ssh-host");
        return r.ok ? parseSshHostCheck(await r.json()) : null;
    } catch {
        return null;
    }
}

/** 「SSH 主機」的編輯器。/ The editor for "SSH host". */
export function SshHostControl({ shown, locked, onSave }: { shown: unknown; locked: boolean; onSave: (value: string) => void }) {
    const { t } = useI18n();
    const saved = String(shown ?? "");
    const [draft, setDraft] = useState(saved);
    // undefined = 檢查中；null = 查不到（舊後端或錯誤）。/ undefined = checking; null = unavailable.
    const [check, setCheck] = useState<SshHostCheck | null | undefined>(undefined);
    const [why, setWhy] = useState(false);

    const load = useCallback(async () => {
        const c = await fetchCheck();
        setCheck(c);
        return c !== null;
    }, []);
    useEffect(() => {
        let cancelled = false;
        void fetchCheck().then((c) => {
            if (!cancelled) setCheck(c);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const value = locked ? saved : draft;
    const problem = locked ? null : hostProblem(draft);
    const dirty = !locked && tidyHost(draft) !== tidyHost(saved);
    const save = () => {
        if (!problem && dirty) onSave(tidyHost(draft));
    };
    const webHost = check?.web.host;
    const sourceChip = (c: SshHostCheck) =>
        c.ssh.source === "env" ? (
            <Chip mono>SSH_SERVER_DOMAIN</Chip>
        ) : (
            <Chip>{t(c.ssh.source === "setting" ? "sshHost.from.setting" : "sshHost.from.web")}</Chip>
        );

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    className="h-8 w-full max-w-md font-mono"
                    value={value}
                    disabled={locked}
                    placeholder={webHost ? t("sshHost.placeholder", { host: webHost }) : t("sshHost.placeholderNone")}
                    aria-label={t("siteSettings.server_ssh_host.label")}
                    aria-invalid={!!problem}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") save();
                    }}
                />
                {!locked && (
                    <Button type="button" size="sm" variant="soft" disabled={!!problem || !dirty} onClick={save}>
                        {t("common.save")}
                    </Button>
                )}
                {!locked && saved.trim() !== "" && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => onSave("")}>
                        {t("sshHost.clear")}
                    </Button>
                )}
            </div>
            {problem && <p className="text-xs text-destructive">{t(`sshHost.problem.${problem}` as TranslationKey)}</p>}

            <div className="overflow-hidden rounded-lg border border-border bg-surface">
                {check === undefined ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">{t("sshHost.checking")}</p>
                ) : check === null ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">{t("sshHost.checkFailed")}</p>
                ) : (
                    <ul className="divide-y divide-border/70">
                        <NameRow
                            label={t("sshHost.web")}
                            host={check.web.host}
                            lookup={check.web}
                            proxied={check.web.proxied}
                            from={check.web.from === "public_url" ? <Chip mono>PUBLIC_URL</Chip> : <Chip>{t("sshHost.from.request")}</Chip>}
                        />
                        <NameRow label={t("sshHost.ssh")} host={`${check.ssh.host}:${check.ssh.port}`} lookup={check.ssh} proxied={check.ssh.cloudflare} from={sourceChip(check)} />
                    </ul>
                )}
            </div>

            {check && check.verdict !== "local" && <p className="text-xs leading-relaxed text-muted-foreground">{t("sshHost.detectNote")}</p>}

            {/* SSH 的名稱也開得到網頁：代理裡多了一個繞過正式網址的入口。/ The SSH name serves the web too: a second way in. */}
            {check && !check.same && <WebOnSshHost host={check.ssh.host} />}

            {check && (
                <Callout tone={verdictTone(check.verdict)}>
                    {t(`sshHost.verdict.${check.verdict}` as TranslationKey, { ssh: check.ssh.host, web: check.web.host, port: check.ssh.port })}
                </Callout>
            )}

            <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => setWhy(true)}>
                    <Info size={15} /> {t("sshHost.why")}
                </Button>
                <RefreshButton size="sm" onRefresh={load} label={t("sshHost.recheck")} />
                <span className="text-xs text-muted-foreground">{t("sshHost.installedNote")}</span>
            </div>

            {why && <SshHostDialog isOpen onClose={() => setWhy(false)} check={check ?? null} />}
        </div>
    );
}

/**
 * 從瀏覽器試開 `https://<SSH 主機>/api/auth/setup-status`（後端的 CORS 會回應）：有回應 = 那個名稱也接著網頁（例如 NPM 裡
 * 多了一個 proxy host），該拿掉——它會變成繞過正式網址（與其前面的代理）的入口。連不到 = 正常，不說話。
 * Try `https://<ssh host>/api/auth/setup-status` from the browser (the backend answers CORS): an answer = the name
 * serves the web too (a proxy host left in NPM, say), which should go — it is a way around the public address and
 * whatever sits in front of it. Unreachable = fine, nothing said.
 */
function WebOnSshHost({ host }: { host: string }) {
    const { t } = useI18n();
    const [serves, setServes] = useState<boolean | null>(null);
    useEffect(() => {
        let cancelled = false;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 6000);
        void fetch(`https://${host}/api/auth/setup-status`, { signal: ctl.signal, cache: "no-store" })
            .then((r) => !cancelled && setServes(r.ok))
            .catch(() => !cancelled && setServes(false))
            .finally(() => clearTimeout(timer));
        return () => {
            cancelled = true;
            ctl.abort();
        };
    }, [host]);
    if (!serves) return null;
    return <Callout tone="warning">{t("sshHost.webOnSshHost", { host })}</Callout>;
}

/** 「為什麼要兩個名稱？」。/ "Why two names?". */
export function SshHostDialog({ isOpen, onClose, check }: { isOpen: boolean; onClose: () => void; check: SshHostCheck | null }) {
    const { t, tn } = useI18n();
    const start = initialScenario(check);
    const [proxied, setProxied] = useState(start.proxied);
    const [separate, setSeparate] = useState(start.separate);
    const now = check !== null && proxied === start.proxied && separate === start.separate;
    const l = lanes(proxied, separate);
    const port = check?.ssh.port || "22";
    const webName = check?.web.host || "telepy.example.com";
    const sshName = separate ? (check && !check.same ? check.ssh.host : `ssh.${webName}`) : webName;
    // 只有真的偵測到 Cloudflare 才寫出它的名字；其他代理一律叫「網頁代理」。
    // Cloudflare is named only when it was detected; any other proxy is just "a web proxy".
    const cloudflare = check !== null && (check.web.cloudflare || check.ssh.cloudflare);
    const proxyTitle = t(cloudflare ? "sshHost.d.proxyCloudflare" : "sshHost.d.proxy");
    const result: TranslationKey = l.ssh.viaProxy ? "sshHost.d.result.blocked" : proxied ? "sshHost.d.result.split" : separate ? "sshHost.d.result.separate" : "sshHost.d.result.same";
    const c = (s: string) => <code className="[overflow-wrap:anywhere]">{s}</code>;

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t("sshHost.d.title")} description={t("sshHost.d.subtitle")} icon={<Route />} size="4xl">
            <div className="space-y-5">
                {/* 情境：網頁名稱走不走代理 × SSH 用哪個名稱。/ The scenario: is the web name proxied × which name SSH uses. */}
                <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                    <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">{t("sshHost.d.webName")}</p>
                        <Segmented
                            size="sm"
                            aria-label={t("sshHost.d.webName")}
                            options={[
                                { value: "proxied", label: t("sshHost.d.proxied") },
                                { value: "dns", label: t("sshHost.d.dnsOnly") },
                            ]}
                            value={proxied ? "proxied" : "dns"}
                            onChange={(v) => setProxied(v === "proxied")}
                        />
                    </div>
                    <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">{t("sshHost.d.sshUses")}</p>
                        <Segmented
                            size="sm"
                            aria-label={t("sshHost.d.sshUses")}
                            options={[
                                { value: "own", label: t("sshHost.d.own") },
                                { value: "shared", label: t("sshHost.d.shared") },
                            ]}
                            value={separate ? "own" : "shared"}
                            onChange={(v) => setSeparate(v === "own")}
                        />
                    </div>
                    {now && <Chip tone="primary">{t("sshHost.d.now")}</Chip>}
                </div>
                <p className="-mt-2 text-xs leading-relaxed text-muted-foreground">{t("sshHost.d.detectNote")}</p>

                <section className="space-y-2">
                    <SectionHeading as="h3" icon={<Globe />} title={t("sshHost.d.laneWeb")} />
                    <FlowPath>
                        <FlowNode icon={Globe} title={t("sshHost.d.clients")} sub="https://" state="ok" stateText={t("sshHost.d.start")} />
                        <FlowLink label={t("sshHost.d.https")} state={l.web.hop} />
                        <FlowNode
                            icon={proxied ? Cloud : Route}
                            title={proxied ? proxyTitle : t("sshHost.d.dns")}
                            sub={<span className="font-mono">{webName}</span>}
                            state={l.web.name}
                            stateText={t(proxied ? "sshHost.d.forwarded" : "sshHost.d.direct")}
                        />
                        <FlowLink label={t("sshHost.d.webPortLink")} state={l.web.hop} />
                        <FlowNode brand title="Telepy" sub={t("sshHost.d.webPort")} state={l.web.port} />
                    </FlowPath>
                </section>

                <section className="space-y-2">
                    <SectionHeading as="h3" icon={<Cpu />} title={t("sshHost.d.laneSsh")} />
                    <FlowPath>
                        <FlowNode icon={Cpu} title={t("sshHost.d.devices")} sub="ssh -R · ssh <device>" state="ok" stateText={t("sshHost.d.start")} />
                        <FlowLink label={t("sshHost.d.sshPort", { port })} state={l.ssh.hop} />
                        <FlowNode
                            icon={l.ssh.viaProxy ? Cloud : Route}
                            title={l.ssh.viaProxy ? proxyTitle : t("sshHost.d.dns")}
                            sub={<span className="font-mono">{sshName}</span>}
                            state={l.ssh.name}
                            stateText={t(l.ssh.viaProxy ? "sshHost.d.stopped" : "sshHost.d.direct")}
                        />
                        <FlowLink label={t("sshHost.d.gatewayLink")} state={l.ssh.viaProxy ? "failed" : "ok"} />
                        <FlowNode brand title="Telepy" sub={t("sshHost.d.gatewayPort", { port })} state={l.ssh.port} stateText={l.ssh.viaProxy ? t("sshHost.d.never") : undefined} />
                    </FlowPath>
                </section>

                <Callout tone={l.ssh.viaProxy ? "danger" : proxied ? "tip" : "info"}>{t(result, { port })}</Callout>

                <section className="space-y-2">
                    <SectionHeading as="h3" title={t("sshHost.d.usesTitle")} />
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="rounded-lg border border-border bg-surface p-3">
                            <p className="text-sm text-foreground">
                                {t("sshHost.d.webName")} · <span className="font-mono">{webName}</span>
                            </p>
                            <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
                                <li>{t("sshHost.d.web1")}</li>
                                <li>{t("sshHost.d.web2")}</li>
                                <li>{tn("sshHost.d.web3", { cmd: c("curl … | sh") })}</li>
                                <li>{t("sshHost.d.web4")}</li>
                            </ul>
                        </div>
                        <div className="rounded-lg border border-border bg-surface p-3">
                            <p className="text-sm text-foreground">
                                {t("sshHost.d.sshName")} · <span className="font-mono">{sshName}</span>
                            </p>
                            <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
                                <li>{tn("sshHost.d.ssh1", { cmd: c(`ssh -R … -p ${port}`) })}</li>
                                <li>{tn("sshHost.d.ssh2", { field: c("HostName"), file: c("~/.ssh/config") })}</li>
                                <li>{tn("sshHost.d.ssh3", { cmd: c("telepy ssh / scp / sftp") })}</li>
                            </ul>
                        </div>
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">{tn("sshHost.d.same", { alias: c(`telepy-${webName}-${port}`) })}</p>
                </section>

                <section className="space-y-2">
                    <SectionHeading as="h3" title={t("sshHost.d.stepsTitle")} />
                    <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed">
                        <li>{tn("sshHost.d.step1", { example: c(`ssh.${webName}`) })}</li>
                        <li>{tn("sshHost.d.step2", { env: c("SSH_SERVER_DOMAIN") })}</li>
                        <li>{t("sshHost.d.step3")}</li>
                        <li>{t("sshHost.d.step4")}</li>
                    </ol>
                </section>
            </div>
        </Modal>
    );
}
