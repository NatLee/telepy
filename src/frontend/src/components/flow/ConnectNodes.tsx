"use client";

/**
 * 連線選擇器共用的節點：你的瀏覽器、Telepy、裝置（選裝置 + 選裝置帳號）。終端機頁與遠端桌面頁的選擇器
 * 都是「瀏覽器 ─ Telepy ─ 裝置 ─ 目標」，只有目標那一站不同，所以前三站放這裡。
 * Nodes shared by the connect pickers: your browser, Telepy, and the device (device select + account select).
 * The terminal and desktop pickers are both "browser ─ Telepy ─ device ─ target" and differ only in the last
 * node, so the first three live here.
 */
import React from "react";
import { Laptop, Server } from "lucide-react";
import { NativeSelect } from "@/components/ui/native-select";
import { FlowNode } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TopologyTunnel } from "@/types/lan";

/** 節點裡的一個欄位：小標 + 控制項（+ 提示）。/ One field inside a node: caption + control (+ hint). */
export function NodeField({ id, label, hint, children, className }: { id?: string; label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
    return (
        <div className={cn("min-w-0 space-y-1", className)}>
            <label htmlFor={id} className="block text-xs text-muted-foreground">{label}</label>
            {children}
            {hint && <p className="text-xs leading-snug text-muted-foreground">{hint}</p>}
        </div>
    );
}

export function BrowserNode({ sub }: { sub: string }) {
    const { t } = useI18n();
    return <FlowNode icon={Laptop} title={t("flow.you")} sub={sub} state="ok" stateText={t("flow.signedIn")} />;
}

export function TelepyNode({ sub }: { sub: string }) {
    const { t } = useI18n();
    return <FlowNode brand title="Telepy" sub={sub} state="ok" stateText={t("flow.ready")} />;
}

interface DeviceNodeProps {
    tunnels: TopologyTunnel[];
    tunnel: TopologyTunnel | null;
    onTunnel: (id: number) => void;
    account: string;
    onAccount: (account: string) => void;
    online: boolean;
    /** 第二行說明（選擇器各自的）。/ The node's sub line. */
    sub: string;
    /** 帳號欄的提示。/ The account field's hint. */
    accountHint?: React.ReactNode;
    idPrefix: string;
}

/**
 * 裝置那一站：選哪台裝置、用它的哪個帳號。線上 / 離線跟著即時狀態；沒有帳號時帳號欄關掉並說明。
 * The device node: which device and which of its accounts. Online / offline follows live status; without an
 * account for you the field is disabled and the hint says so.
 */
export function DeviceNode({ tunnels, tunnel, onTunnel, account, onAccount, online, sub, accountHint, idPrefix }: DeviceNodeProps) {
    const { t } = useI18n();
    const noAccounts = !!tunnel && tunnel.usernames.length === 0;
    const state = tunnel ? (online ? "ok" : "failed") : "waiting";
    const stateText = tunnel ? (online ? t("flow.online") : t("flow.offline")) : undefined;
    return (
        <FlowNode
            icon={Server}
            title={tunnel?.name ?? t("connect.device")}
            sub={sub}
            state={state}
            stateText={stateText}
            wide
            control={
                <div className="grid gap-2.5 sm:grid-cols-2 @3xl:grid-cols-1">
                    <NodeField id={`${idPrefix}-device`} label={t("connect.device")}>
                        <NativeSelect id={`${idPrefix}-device`} value={tunnel ? String(tunnel.id) : ""} onChange={(e) => onTunnel(Number(e.target.value))}>
                            {!tunnel && <option value="">—</option>}
                            {tunnels.map((tn) => (
                                <option key={tn.id} value={tn.id}>
                                    {tn.name}{tn.online === false ? ` · ${t("desktop.offlineShort")}` : ""}
                                </option>
                            ))}
                        </NativeSelect>
                    </NodeField>
                    <NodeField id={`${idPrefix}-account`} label={t("connect.account")} hint={noAccounts ? t("connect.noAccountHint") : accountHint}>
                        <NativeSelect id={`${idPrefix}-account`} value={account} onChange={(e) => onAccount(e.target.value)} disabled={!tunnel || noAccounts} className="font-mono">
                            {(noAccounts || !tunnel) && <option value="">—</option>}
                            {tunnel?.usernames.map((u) => <option key={u} value={u}>{u}</option>)}
                        </NativeSelect>
                    </NodeField>
                </div>
            }
        />
    );
}
