"use client";

/**
 * 掃描區網的設定視窗：裝置帳號、網段（空白 = 裝置自己的網段）、要探測的 port，以及「定時重掃」——用同一組設定照你的
 * 身分每隔一段時間掃一次，下面一條時間線畫出上次與接下來幾次。可以只存排程，也可以現在就掃（排程變了一起存）。
 * Scan dialog: device account, subnets (empty = the device's own networks), ports, and "repeat this scan" — the same
 * settings, run as you every so often, with a timeline of the last and next runs. Save the schedule alone, or scan now
 * (saving a changed schedule too).
 */
import React, { useEffect, useRef, useState } from "react";
import { Radar, Loader2, Repeat } from "lucide-react";
import { NativeSelect } from "@/components/ui/native-select";
import { ScheduleTimeline } from "@/components/network/ScheduleTimeline";
import { EVERY, everyKey, scheduleChanged } from "@/lib/lanSchedule";
import { useNow } from "@/hooks/useNow";
import { useAuth } from "@/lib/auth";
import type { TranslationKey } from "@/locales/en";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_SCAN_PORTS as DEFAULT_PORT_LIST } from "@/lib/lanHosts";
import { useI18n } from "@/lib/i18n";
import { parsePortList } from "@/lib/lanConnect";
import type { ScanOptions } from "@/hooks/useNetworkPage";
import type { TopologyTunnel } from "@/types/lan";

/** 與後端 `lan::DEFAULT_PORTS` 相同（`lib/lanHosts` 的測試比對）。/ Same as the backend's default ports. */
export const DEFAULT_SCAN_PORTS = DEFAULT_PORT_LIST.join(", ");

interface Props {
    tunnel: TopologyTunnel | null;
    onClose: () => void;
    startScan: (tn: TopologyTunnel, opts: ScanOptions) => Promise<string | null>;
    saveSchedule: (tn: TopologyTunnel, opts: ScanOptions & { every: number }) => Promise<string | null>;
    /** 從「定時重掃」那一行打開：直接捲到那一段。/ Opened from the schedule line: scroll straight to that section. */
    focusSchedule?: boolean;
}

/** 每條隧道一份新表單（key 重設狀態）。/ A fresh form per tunnel (the key resets the state). */
export function ScanDialog({ tunnel, ...rest }: Props) {
    return tunnel ? <ScanForm key={tunnel.id} tunnel={tunnel} {...rest} /> : null;
}

function ScanForm({ tunnel, onClose, startScan, saveSchedule, focusSchedule }: Props & { tunnel: TopologyTunnel }) {
    const { t, tn } = useI18n();
    // 有排程就從它的設定開始。/ Start from the saved schedule's settings when there is one.
    const saved = tunnel.schedule ?? null;
    const [account, setAccount] = useState<string | null>(saved?.username ?? tunnel.default_username ?? tunnel.usernames[0] ?? null);
    const [subnets, setSubnets] = useState((saved?.subnets ?? []).join(", "));
    const [ports, setPorts] = useState(saved?.ports ? saved.ports.join(", ") : DEFAULT_SCAN_PORTS);
    const [identify, setIdentify] = useState(saved?.identify ?? true);
    const [every, setEvery] = useState<number>(saved?.every_secs ?? 0);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<"scan" | "save" | null>(null);
    const now = useNow(30_000);
    const repeatRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!focusSchedule) return;
        const id = requestAnimationFrame(() => repeatRef.current?.scrollIntoView({ block: "center" }));
        return () => cancelAnimationFrame(id);
    }, [focusSchedule]);
    const me = useAuth().user?.username ?? null;

    const form = (): (ScanOptions & { ports: number[]; subnets: string[] }) | null => {
        const list = parsePortList(ports);
        if (list === null || list.length === 0 || list.length > 32) {
            setError(t("network.scanForm.portsInvalid"));
            return null;
        }
        const nets = subnets.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
        return { username: account, subnets: nets, ports: list, identify };
    };
    const changed = (() => {
        const list = parsePortList(ports) ?? [];
        const nets = subnets.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
        return scheduleChanged(saved, { every, subnets: nets, ports: list, identify, username: account }, DEFAULT_PORT_LIST);
    })();

    // 只存排程（不重複 = 停掉）。/ Save the schedule only (no repeat = stop it).
    const save = async () => {
        const f = form();
        if (!f) return;
        setBusy("save");
        setError(null);
        const err = await saveSchedule(tunnel, { ...f, every });
        setBusy(null);
        if (err) setError(err);
        else onClose();
    };

    // 現在掃；排程變了就一起存。/ Scan now, saving a changed schedule too.
    const submit = async () => {
        const f = form();
        if (!f) return;
        setBusy("scan");
        setError(null);
        const serr = changed ? await saveSchedule(tunnel, { ...f, every }) : null;
        const err = serr ?? (await startScan(tunnel, f));
        setBusy(null);
        if (err) setError(err);
        else onClose();
    };

    // 時間線：排程沒改就用存下來的下次時間，改了就從現在起算。/ Timeline: the saved next run, or from now for a new interval.
    const nextAt = saved && saved.every_secs === every ? saved.next_at : new Date(now + every * 1000).toISOString();
    const options = [{ value: 0, label: t("network.schedule.off") }, ...EVERY.map((s) => ({ value: s, label: t(`network.schedule.every.${everyKey(s)}` as TranslationKey) }))];

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={t("network.scanTitle", { name: tunnel.name })}
            description={t("network.scanDescription")}
            icon={<Radar />}
            size="lg"
            footer={
                <>
                    <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
                    {changed && (
                        <Button variant="outline" onClick={save} disabled={!!busy || tunnel.usernames.length === 0}>
                            {busy === "save" ? <Loader2 size={16} className="animate-spin" /> : <Repeat size={16} />} {every === 0 ? t("network.schedule.stop") : t("network.schedule.saveOnly")}
                        </Button>
                    )}
                    <Button onClick={submit} disabled={!!busy || tunnel.usernames.length === 0}>
                        {busy === "scan" ? <Loader2 size={16} className="animate-spin" /> : <Radar size={16} />} {t("network.startScan")}
                    </Button>
                </>
            }
        >
            <div className="space-y-4">
                <Callout tone="info">{t("network.scanHow")}</Callout>
                {tunnel.usernames.length === 0 && <Callout tone="warning">{t("network.noDeviceUser")}</Callout>}
                {tunnel.usernames.length > 1 && (
                    <div className="space-y-1.5">
                        <Label>{t("network.scanForm.account")}</Label>
                        <Segmented options={tunnel.usernames.map((u) => ({ value: u, label: u }))} value={account ?? tunnel.usernames[0]} onChange={setAccount} kind="toggle" />
                    </div>
                )}
                <div className="space-y-1.5">
                    <Label htmlFor="scan-subnets">{t("network.scanForm.subnets")}</Label>
                    <Input id="scan-subnets" value={subnets} onChange={(e) => setSubnets(e.target.value)} placeholder="192.168.1.0/24" spellCheck={false} className="font-mono" />
                    <p className="text-xs text-muted-foreground">{t("network.scanForm.subnetsHint")}</p>
                </div>
                <div className="space-y-1.5">
                    <Label htmlFor="scan-ports">{t("network.scanForm.ports")}</Label>
                    <Textarea id="scan-ports" value={ports} onChange={(e) => setPorts(e.target.value)} spellCheck={false} rows={3} className="min-h-0 resize-none font-mono" />
                    <p className="text-xs text-muted-foreground">
                        {tn("network.scanForm.portsHint", { reset: <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => setPorts(DEFAULT_SCAN_PORTS)}>{t("network.scanForm.resetPorts")}</button> })}
                    </p>
                </div>
                {/* 預設開，但說清楚對方會看到什麼。/ On by default, saying plainly what the other machines see. */}
                <div className="space-y-1.5 rounded-lg border border-border bg-surface p-3">
                    <Switch checked={identify} onCheckedChange={setIdentify} size="sm">
                        {t("network.scanForm.identify")}
                    </Switch>
                    <p className="text-xs text-muted-foreground">{t("network.scanForm.identifyHint")}</p>
                </div>
                {/* 定時重掃：同一組設定、照你的身分。/ Repeat with the same settings, as you. */}
                <div ref={repeatRef} className="space-y-2 rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <Label htmlFor="scan-every" className="flex items-center gap-1.5"><Repeat size={14} className="text-muted-foreground" /> {t("network.schedule.title")}</Label>
                        <NativeSelect id="scan-every" value={String(every)} onChange={(e) => setEvery(Number(e.target.value))} className="h-8 w-auto min-w-0 text-sm">
                            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </NativeSelect>
                    </div>
                    <p className="text-xs text-muted-foreground">{every === 0 ? t("network.schedule.offHint") : t("network.schedule.hint")}</p>
                    {every > 0 && <ScheduleTimeline lastAt={saved?.last_at ?? null} nextAt={nextAt} everySecs={every} now={now} />}
                    {saved?.last_error && <Callout tone="warning">{t("network.schedule.lastError", { error: saved.last_error })}</Callout>}
                    {saved && saved.by && saved.by !== me && <p className="text-xs text-muted-foreground">{t("network.schedule.by", { by: saved.by })}</p>}
                </div>
                {error && <Callout tone="danger">{error}</Callout>}
            </div>
        </Modal>
    );
}
