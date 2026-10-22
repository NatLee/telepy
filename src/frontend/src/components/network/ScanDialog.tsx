"use client";

/**
 * 掃描區網的設定視窗：裝置帳號、網段（空白 = 裝置自己的網段）、要探測的 port。
 * Scan dialog: device account, subnets (empty = the device's own networks) and ports to probe.
 */
import React, { useState } from "react";
import { Radar, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { useI18n } from "@/lib/i18n";
import { parsePortList } from "@/lib/lanConnect";
import type { ScanOptions } from "@/hooks/useNetworkPage";
import type { TopologyTunnel } from "@/types/lan";

/** 與後端 `lan::DEFAULT_PORTS` 相同。/ Same as the backend's default ports. */
export const DEFAULT_SCAN_PORTS = "22, 80, 443, 445, 3389, 5900, 8080, 8443";

interface Props {
    tunnel: TopologyTunnel | null;
    onClose: () => void;
    startScan: (tn: TopologyTunnel, opts: ScanOptions) => Promise<string | null>;
}

/** 每條隧道一份新表單（key 重設狀態）。/ A fresh form per tunnel (the key resets the state). */
export function ScanDialog({ tunnel, ...rest }: Props) {
    return tunnel ? <ScanForm key={tunnel.id} tunnel={tunnel} {...rest} /> : null;
}

function ScanForm({ tunnel, onClose, startScan }: Props & { tunnel: TopologyTunnel }) {
    const { t, tn } = useI18n();
    const [account, setAccount] = useState<string | null>(tunnel.default_username ?? tunnel.usernames[0] ?? null);
    const [subnets, setSubnets] = useState("");
    const [ports, setPorts] = useState(DEFAULT_SCAN_PORTS);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const submit = async () => {
        const list = parsePortList(ports);
        if (list === null || list.length === 0 || list.length > 32) {
            setError(t("network.scanForm.portsInvalid"));
            return;
        }
        const nets = subnets.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
        setBusy(true);
        setError(null);
        const err = await startScan(tunnel, { username: account, subnets: nets, ports: list });
        setBusy(false);
        if (err) setError(err);
        else onClose();
    };

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
                    <Button onClick={submit} disabled={busy || tunnel.usernames.length === 0}>
                        {busy ? <Loader2 size={16} className="animate-spin" /> : <Radar size={16} />} {t("network.startScan")}
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
                    <Input id="scan-ports" value={ports} onChange={(e) => setPorts(e.target.value)} spellCheck={false} className="font-mono" />
                    <p className="text-xs text-muted-foreground">
                        {tn("network.scanForm.portsHint", { reset: <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => setPorts(DEFAULT_SCAN_PORTS)}>{t("network.scanForm.resetPorts")}</button> })}
                    </p>
                </div>
                {error && <Callout tone="danger">{error}</Callout>}
            </div>
        </Modal>
    );
}
