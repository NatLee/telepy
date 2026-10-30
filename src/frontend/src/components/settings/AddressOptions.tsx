"use client";

/**
 * 網站設定 → 伺服器：兩個「要填什麼？」的欄位有了選項，不必管理員自己去查。
 * - 訪客位址標頭：這次請求實際帶了哪些位址標頭（`/api/auth/client-ip-check`，含裡面的位址與是否公網），加上常見
 *   CDN / 代理各用哪個標頭（`lib/clientIpHeaders`），一鍵帶入。
 * - PROXY protocol 來源：gateway 從啟動以來看到的來源位址，送過 PROXY header 卻還不是來源的在最前面
 *   （`/api/site/address-sources`），加上本機 / 內網 / Cloudflare Spectrum 的預設，一鍵加入。
 * 兩者都只改輸入框，按「儲存」才生效；`.env` 設了就鎖住（仍然顯示看到的東西，告訴你 .env 該填什麼）。
 * Site settings → Server: the two "what goes here?" fields get options instead of leaving admins to look them up.
 * The visitor header shows the address headers this very request carried (with their addresses) plus which header
 * each common CDN / proxy uses; PROXY protocol sources shows what the gateway has seen since it started — header
 * senders that are not sources yet first — plus presets. Both only fill the input; Save applies. When .env sets the
 * key the input is locked, but the observations stay (they say what to put in .env).
 */
import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Chip } from "@/components/ui/section";
import { apiFetch } from "@/lib/api";
import { parseClientIpCheck, type HeaderSeen } from "@/lib/clientIp";
import { headerChoices, isHeaderName, type HeaderChoice } from "@/lib/clientIpHeaders";
import { useI18n } from "@/lib/i18n";
import { addSources, fitsLimit, hasSource, parseAddressSources, peerAdvice, presetAdded, sortPeers, SOURCES_MAX, type AddressSources, type GatewayPeer, type PeerAdvice } from "@/lib/proxySources";
import { formatRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";

const ADDRESS_CHECK_HREF = "/tunnels/admin/health?tab=addresses#client-ip";

/** 一列選項的外框。/ The frame of one option row. */
function OptionRow({ children, action, muted = false }: { children: React.ReactNode; action?: React.ReactNode; muted?: boolean }) {
    return (
        <li className={cn("flex items-start gap-3 px-3 py-2.5", muted && "text-muted-foreground")}>
            <div className="min-w-0 flex-1 space-y-0.5 text-sm">{children}</div>
            {action && <div className="shrink-0">{action}</div>}
        </li>
    );
}

function UseButton({ done, disabled, onClick, label }: { done: boolean; disabled?: boolean; onClick: () => void; label: string }) {
    const { t } = useI18n();
    if (done) {
        return (
            <span className="inline-flex h-8 items-center gap-1 px-2 text-xs text-success">
                <Check size={14} /> {t("addrOpt.inInput")}
            </span>
        );
    }
    return (
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onClick} aria-label={label}>
            <Plus size={14} /> {t("addrOpt.use")}
        </Button>
    );
}

const scopeTone = (scope: string) => (scope === "public" ? "success" : "neutral");

function ScopeChip({ scope }: { scope: string }) {
    const { t } = useI18n();
    return <Chip tone={scopeTone(scope)}>{t(scope === "public" ? "addrOpt.scopePublic" : "addrOpt.scopeInternal")}</Chip>;
}

/* ── 訪客位址標頭 / Visitor address header ───────────────────────── */

export function ClientIpHeaderControl({ shown, locked, onSave }: { shown: unknown; locked: boolean; onSave: (value: string) => void }) {
    const { t } = useI18n();
    const saved = String(shown ?? "");
    const [draft, setDraft] = useState(saved);
    const [seen, setSeen] = useState<HeaderSeen[] | null>(null);
    const [showAll, setShowAll] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const r = await apiFetch("/api/auth/client-ip-check");
                const c = r.ok ? parseClientIpCheck(await r.json()) : null;
                if (!cancelled) setSeen(c?.headers ?? []);
            } catch {
                if (!cancelled) setSeen([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const value = locked ? saved : draft;
    const valid = draft.trim() === "" || isHeaderName(draft);
    const dirty = !locked && draft.trim() !== saved.trim();
    const choices = headerChoices(seen ?? [], value);
    const arrived = choices.filter((c) => c.seen);
    const others = choices.filter((c) => !c.seen);

    const row = (c: HeaderChoice) => {
        const addr = c.seen?.addresses[0];
        return (
            <OptionRow
                key={c.name}
                action={!locked && <UseButton done={value.trim().toLowerCase() === c.name.toLowerCase()} onClick={() => setDraft(c.name)} label={t("addrOpt.useHeader", { name: c.name })} />}
            >
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono text-foreground">{c.name}</span>
                    {c.current && <Chip tone="primary">{t("addrOpt.current")}</Chip>}
                    {c.seen ? (
                        addr ? (
                            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                                {t("addrOpt.arrivedWith")} <span className="font-mono text-foreground">{addr.ip}</span> <ScopeChip scope={addr.scope} />
                            </span>
                        ) : (
                            <span className="text-xs text-muted-foreground">{t("addrOpt.arrivedNoAddress")}</span>
                        )
                    ) : null}
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                    {c.known ? t(`addrOpt.hdr.${c.known.id}.who` as TranslationKey) : t("addrOpt.hdrUnknown")}
                </p>
                {c.known && (c.known.caution || c.known.id === "cloudflare" || c.known.id === "cloudfront") && (
                    <p className={cn("text-xs leading-relaxed", c.known.caution ? "text-warning" : "text-muted-foreground")}>{t(`addrOpt.hdr.${c.known.id}.note` as TranslationKey)}</p>
                )}
            </OptionRow>
        );
    };

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    className="h-8 w-64 max-w-full font-mono"
                    value={value}
                    disabled={locked}
                    placeholder="CF-Connecting-IP"
                    aria-label={t("siteSettings.client_ip_header.label")}
                    aria-invalid={!valid}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && valid) onSave(draft.trim()); }}
                />
                {!locked && (
                    <Button type="button" size="sm" variant="soft" disabled={!valid || !dirty} onClick={() => onSave(draft.trim())}>
                        {t("common.save")}
                    </Button>
                )}
                {dirty && <span className="text-xs text-warning">{t("addrOpt.unsaved")}</span>}
                {!valid && <span className="text-xs text-destructive">{t("addrOpt.badHeader")}</span>}
            </div>

            <Callout tone="warning" title={t("addrOpt.headerTrustTitle")}>
                <p>{t("addrOpt.headerTrust")}</p>
                <Link href={ADDRESS_CHECK_HREF} prefetch={false} className="mt-1 inline-flex items-center gap-1 text-foreground underline underline-offset-2">
                    {t("addrOpt.headerTry")} <ArrowRight size={12} className="opacity-60" />
                </Link>
            </Callout>

            <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">{t("addrOpt.arrivedTitle")}</p>
                {seen === null ? (
                    <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
                ) : arrived.length === 0 ? (
                    <p className="rounded-md bg-surface px-3 py-2.5 text-sm text-muted-foreground">{t("addrOpt.arrivedNone")}</p>
                ) : (
                    <ul className="divide-y divide-border/70 rounded-md border border-border/80">{arrived.map(row)}</ul>
                )}
            </div>

            <div className="space-y-1.5">
                <button type="button" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
                    {t(showAll ? "addrOpt.knownHide" : "addrOpt.knownShow", { n: String(others.length) })}
                </button>
                {showAll && <ul className="divide-y divide-border/70 rounded-md border border-border/80">{others.map(row)}</ul>}
            </div>
        </div>
    );
}

/* ── PROXY protocol 來源 / PROXY protocol sources ────────────────── */

const ADVICE_TEXT: Record<PeerAdvice, TranslationKey> = {
    add: "addrOpt.peer.add",
    trusted: "addrOpt.peer.trusted",
    idle: "addrOpt.peer.idle",
    internal: "addrOpt.peer.internal",
};
const ADVICE_TONE: Record<PeerAdvice, string> = {
    add: "text-warning",
    trusted: "text-success",
    idle: "text-muted-foreground",
    internal: "text-muted-foreground",
};

export function ProxySourcesControl({ shown, locked, onSave }: { shown: unknown; locked: boolean; onSave: (value: string) => void }) {
    const { t, locale } = useI18n();
    const saved = String(shown ?? "");
    const [draft, setDraft] = useState(saved);
    const [sources, setSources] = useState<AddressSources | null | undefined>(undefined);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const r = await apiFetch("/api/site/address-sources");
            const s = r.ok ? parseAddressSources(await r.json()) : null;
            setSources(s);
            return !!s;
        } catch {
            setSources(null);
            return false;
        } finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => {
        const first = setTimeout(() => void load(), 0);
        return () => clearTimeout(first);
    }, [load]);

    const value = locked ? saved : draft;
    const dirty = !locked && draft.trim() !== saved.trim();
    const fits = fitsLimit(draft.trim());
    const add = (items: readonly string[]) => setDraft((d) => addSources(d, items));
    const ago = (iso: string) => (iso ? formatRelativeTime(iso, locale) : "");

    const peerRow = (p: GatewayPeer) => {
        const advice = peerAdvice(p);
        const inInput = hasSource(value, p.ip);
        return (
            <OptionRow
                key={p.ip}
                muted={advice === "internal"}
                action={!locked && !p.listed && <UseButton done={inInput} onClick={() => add([p.ip])} label={t("addrOpt.addAddress", { ip: p.ip })} />}
            >
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono text-foreground">{p.ip}</span>
                    <ScopeChip scope={p.scope} />
                    {p.listed && <Chip tone="primary">{t("addrOpt.listed")}</Chip>}
                </p>
                <p className="text-xs text-muted-foreground">
                    {t("addrOpt.peerCounts", { n: String(p.connections), h: String(p.proxyHeaders) })} · {t("addrOpt.lastSeen", { when: ago(p.lastAt) })}
                </p>
                <p className={cn("text-xs leading-relaxed", ADVICE_TONE[advice])}>{t(ADVICE_TEXT[advice])}</p>
            </OptionRow>
        );
    };

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    className="h-8 w-full max-w-xl font-mono sm:w-[28rem]"
                    value={value}
                    disabled={locked}
                    placeholder="10.0.0.5, 10.1.0.0/16"
                    aria-label={t("siteSettings.server_gateway_proxy_protocol_from.label")}
                    aria-invalid={!fits}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && fits) onSave(draft.trim()); }}
                />
                {!locked && (
                    <Button type="button" size="sm" variant="soft" disabled={!fits || !dirty} onClick={() => onSave(draft.trim())}>
                        {t("common.save")}
                    </Button>
                )}
                {!locked && <span className={cn("text-xs tabular-nums", fits ? "text-muted-foreground" : "text-destructive")}>{draft.trim().length} / {SOURCES_MAX}</span>}
                {dirty && <span className="text-xs text-warning">{t("addrOpt.unsaved")}</span>}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{t("addrOpt.proxyHow")}</p>

            {sources !== null && (
                <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                        <p className="flex-1 text-xs text-muted-foreground">{sources ? t("addrOpt.seenTitle", { when: ago(sources.since) }) : t("common.loading")}</p>
                        <RefreshButton onRefresh={load} busy={loading} iconSize={14} variant="ghost" className="h-7 px-2" label={t("common.refresh")} />
                    </div>
                    {sources && (sources.peers.length === 0 ? (
                        <p className="rounded-md bg-surface px-3 py-2.5 text-sm text-muted-foreground">{t("addrOpt.seenNone")}</p>
                    ) : (
                        <ul className="divide-y divide-border/70 rounded-md border border-border/80">{sortPeers(sources.peers).map(peerRow)}</ul>
                    ))}
                    {sources && sources.otherPublic > 0 && <p className="text-xs text-muted-foreground">{t("addrOpt.otherPublic", { n: String(sources.otherPublic) })}</p>}
                </div>
            )}

            {sources && sources.presets.length > 0 && (
                <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">{t("addrOpt.presetsTitle")}</p>
                    <ul className="divide-y divide-border/70 rounded-md border border-border/80">
                        {sources.presets.map((p) => (
                            <OptionRow
                                key={p.id}
                                action={!locked && <UseButton done={presetAdded(value, p)} onClick={() => add(p.cidrs)} label={t(`addrOpt.preset.${p.id}.name` as TranslationKey)} />}
                            >
                                <p className="text-foreground">{t(`addrOpt.preset.${p.id}.name` as TranslationKey)}</p>
                                <p className="text-xs leading-relaxed text-muted-foreground">{t(`addrOpt.preset.${p.id}.when` as TranslationKey)}</p>
                                <p className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]" title={p.cidrs.join(", ")}>
                                    {p.cidrs.length > 4 ? t("addrOpt.presetMany", { first: p.cidrs.slice(0, 2).join(", "), n: String(p.cidrs.length) }) : p.cidrs.join(", ")}
                                </p>
                            </OptionRow>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
