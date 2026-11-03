"use client";

/**
 * 主機面板「細節」分頁的「作業系統」：使用者對這一台按了才問（掃描從來不做）。結果 = 猜的系統、信心、每條線索
 * （重的在前，只是說明的淡色）、互相矛盾的系列、nmap 的狀況；說明鈕打開路徑圖：你 ─ Telepy ─ 裝置 ─ 這台，
 * 下面列出每條線索問了什麼、這次有沒有用上。
 * The host panel's "Operating system" (Details tab): asked only when someone presses the button for this host, never in
 * a scan. The result = the guess, the confidence, every clue (heaviest first, notes faded), rival families and nmap's
 * state; the info button opens the path you ─ Telepy ─ device ─ this host and what each clue asks and whether it counted.
 */
import React, { useState } from "react";
import { Cpu, Fingerprint, Globe, Info, KeyRound, Loader2, Monitor, Network, Router, Server, Share2, Tag } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Section } from "@/components/ui/section";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { clueStates, confidenceTone, evidenceSentence, familyKey, osBlock, OS_CLUES, sortedEvidence, type ClueState, type OsClue } from "@/lib/lanOs";
import type { TranslationKey } from "@/locales/en";
import type { LanHost, LanOsCheck, TopologyTunnel } from "@/types/lan";

export type OsResult = { ok: true } | { ok: false; error: string };

const CLUE_ICON: Record<OsClue, LucideIcon> = { ttl: Network, http: Globe, vendor: Tag, ssh: KeyRound, smb: Share2, nmap: Fingerprint };

const BLOCK_KEY: Record<Exclude<ReturnType<typeof osBlock>, null>, TranslationKey> = {
    address: "network.os.blockAddress",
    permission: "network.os.blockPermission",
    offline: "network.deviceOffline",
    own: "network.os.blockOwn",
};

const TONE_CLASS = { success: "text-success", warning: "text-warning", muted: "text-muted-foreground" } as const;
const DOT_CLASS = { success: "bg-success", warning: "bg-warning", muted: "bg-muted-foreground/50" } as const;

/** 結果那一行：名字或系列 + 信心。/ The headline: name or family + confidence. */
export function osHeadline(check: LanOsCheck, t: (k: TranslationKey, v?: Record<string, string | number>) => string): string {
    const family = familyKey(check.family);
    if (check.name) return check.name;
    if (family) return t(family);
    return t("network.os.nothing");
}

export function OsSection({ host, tunnel, online, onIdentify }: { host: LanHost; tunnel: TopologyTunnel; online: boolean; onIdentify: (h: LanHost) => Promise<OsResult> }) {
    const { t, locale } = useI18n();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [info, setInfo] = useState(false);
    const block = osBlock(host, !!tunnel.can_scan, online);
    if (block === "own") return null;
    const check = host.os_check ?? null;
    const tone = check ? confidenceTone(check.confidence) : "muted";
    const when = check ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(check.at)) : "";
    const run = async () => {
        setBusy(true);
        setError(null);
        const r = await onIdentify(host);
        if (!r.ok) setError(r.error);
        setBusy(false);
    };
    return (
        <Section
            wrapTitle
            title={t("network.os.title")}
            description={check ? undefined : t("network.os.intro")}
            action={
                <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => setInfo(true)} title={t("network.os.how")} aria-label={t("network.os.how")}>
                        <Info size={15} />
                    </Button>
                    <Button variant="outline" size="sm" className="h-8" disabled={!!block || busy} title={block ? t(BLOCK_KEY[block]) : t("network.os.hint")} onClick={() => void run()}>
                        {busy ? <Loader2 size={15} className="animate-spin" /> : <Fingerprint size={15} />} {check ? t("network.os.again") : t("network.os.button")}
                    </Button>
                </div>
            }
        >
            <div className="space-y-3">
                {busy && <p className="text-sm text-muted-foreground">{t("network.os.asking", { device: tunnel.name })}</p>}
                {error && <Callout tone="danger">{error}</Callout>}
                {block && block !== "offline" && !check && <p className="text-xs text-muted-foreground">{t(BLOCK_KEY[block])}</p>}
                {check && (
                    <>
                        <div className="space-y-0.5">
                            <p className="text-base text-foreground [overflow-wrap:anywhere]">{osHeadline(check, t)}</p>
                            <p className={cn("flex flex-wrap items-center gap-x-1.5 text-xs", TONE_CLASS[tone])}>
                                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                                    <span className={cn("size-1.5 rounded-full", DOT_CLASS[tone])} aria-hidden />
                                    {t(`network.os.confidence.${check.confidence}` as TranslationKey)}
                                </span>
                                <span className="text-muted-foreground">· {t("network.os.checked", { when, by: check.by })}</span>
                            </p>
                        </div>
                        {check.evidence.length > 0 && (
                            <ul className="space-y-1.5">
                                {sortedEvidence(check).map((e, i) => {
                                    const Icon = CLUE_ICON[(OS_CLUES as readonly string[]).includes(e.source) ? (e.source as OsClue) : "ttl"];
                                    const said = evidenceSentence(e);
                                    const text = said ? t(said.key, { ...said.vars, what: said.vars.what ? t(said.vars.what as TranslationKey) : "" }) : e.text;
                                    return (
                                        <li key={i} className={cn("flex items-start gap-2 text-sm", e.weight === 0 ? "text-muted-foreground" : "text-foreground")}>
                                            <Icon size={14} className="mt-1 shrink-0 text-muted-foreground" aria-hidden />
                                            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                                                <span className="mr-1.5 text-xs text-muted-foreground">{t(`network.os.clue.${e.source}` as TranslationKey)}</span>
                                                {text}
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                        {(check.conflict ?? []).length > 0 && (
                            <Callout tone="warning">{t("network.os.conflict", { families: (check.conflict ?? []).map((f) => (familyKey(f) ? t(familyKey(f)!) : f)).join(", ") })}</Callout>
                        )}
                        <p className="text-xs text-muted-foreground">{t(`network.os.nmap.${["ran", "unprivileged", "windows"].includes(check.nmap) ? check.nmap : "absent"}` as TranslationKey)}</p>
                    </>
                )}
            </div>
            <OsInfoDialog isOpen={info} onClose={() => setInfo(false)} host={host} tunnel={tunnel} online={online} />
        </Section>
    );
}

const STATE_KEY: Record<ClueState, TranslationKey> = {
    used: "network.os.state.used",
    note: "network.os.state.note",
    nothing: "network.os.state.nothing",
    skipped: "network.os.state.skipped",
    unknown: "network.os.state.unknown",
};

const STATE_CLASS: Record<ClueState, string> = {
    used: "text-success",
    note: "text-muted-foreground",
    nothing: "text-muted-foreground",
    skipped: "text-muted-foreground",
    unknown: "text-muted-foreground",
};

export function OsInfoDialog({ isOpen, onClose, host, tunnel, online }: { isOpen: boolean; onClose: () => void; host: LanHost; tunnel: TopologyTunnel; online: boolean }) {
    const { t } = useI18n();
    if (!isOpen) return null;
    const check = host.os_check ?? null;
    const states = clueStates(host);
    const name = host.label || host.hostname || host.address;
    const deviceAsked = states.ttl === "used" || states.nmap === "used";
    const asked = states.ssh === "used" || states.ssh === "note" || states.smb === "used";
    return (
        <Modal
            isOpen
            onClose={onClose}
            size="4xl"
            icon={<Fingerprint size={18} />}
            title={t("network.os.infoTitle")}
            description={t("network.os.infoDesc")}
            footer={<Button variant="outline" onClick={onClose}>{t("common.close")}</Button>}
        >
            <div className="space-y-5">
                <FlowPath>
                    <FlowNode icon={Monitor} title={t("network.flow.you")} sub={t("network.os.youSub")} state="ok" />
                    <FlowLink label={t("network.wake.linkSsh")} state={online ? "ok" : "failed"} />
                    <FlowNode
                        icon={Router}
                        title={tunnel.name}
                        sub={t("network.os.deviceSub")}
                        state={!online ? "failed" : deviceAsked ? "ok" : "waiting"}
                        stateText={!online ? t("network.web.flow.offline") : undefined}
                    />
                    <FlowLink label={t("network.os.linkProbes")} state={check ? (asked || deviceAsked ? "ok" : "waiting") : "waiting"} />
                    <FlowNode
                        icon={Server}
                        title={name}
                        sub={check ? (check.name ?? (familyKey(check.family) ? t(familyKey(check.family)!) : t("network.os.nothing"))) : t("network.os.notYet")}
                        state={check && check.confidence !== "none" ? "ok" : "waiting"}
                        stateText={check ? t(`network.os.confidence.${check.confidence}` as TranslationKey) : undefined}
                    />
                </FlowPath>
                <section className="space-y-2">
                    <h3 className="text-sm text-foreground">{t("network.os.cluesTitle")}</h3>
                    <ol className="divide-y divide-border rounded-lg border border-border">
                        {OS_CLUES.map((c) => {
                            const Icon = CLUE_ICON[c];
                            return (
                                <li key={c} className={cn("flex items-start gap-3 px-3 py-2", states[c] === "used" && "bg-success/[0.06]")}>
                                    <Icon size={15} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                                    <span className="min-w-0 flex-1">
                                        <span className="flex flex-wrap items-baseline gap-x-2">
                                            <span className="text-sm text-foreground">{t(`network.os.clue.${c}` as TranslationKey)}</span>
                                            <span className={cn("text-xs", STATE_CLASS[states[c]])}>{t(STATE_KEY[states[c]])}</span>
                                        </span>
                                        <span className="block text-xs text-muted-foreground">{t(`network.os.clueHow.${c}` as TranslationKey)}</span>
                                    </span>
                                </li>
                            );
                        })}
                    </ol>
                </section>
                <Callout tone="info" icon={<Cpu size={16} />}>{t("network.os.never")}</Callout>
            </div>
        </Modal>
    );
}
