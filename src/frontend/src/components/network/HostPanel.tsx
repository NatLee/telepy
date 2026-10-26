"use client";

/**
 * 區網主機面板（就地展開，取代原本的視窗）：終端機（開在本頁底部的 dock）、指令（就地產生）、細節與編輯。
 * 登入帳號與經過的裝置帳號兩個分頁共用。每台主機一份新狀態（key = 主機 id）。
 * The LAN host panel, shown in place of the old dialog: terminal (opens in this page's dock), commands
 * (generated here), details and editing. Fresh state per host (keyed by id).
 */
import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Terminal, Trash2, Save, Loader2, X, ScreenShare } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { LanCommands } from "@/components/network/LanCommands";
import { sessionLabel } from "@/components/network/TerminalDock";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { desktopPorts } from "@/lib/desktop";
import type { ConnectTarget } from "@/lib/forwardRecipes";
import { hasSsh, hostName, isValidLogin } from "@/lib/lanConnect";
import type { FormErrors, HostInput } from "@/hooks/useNetworkPage";
import { MAX_LAN_TERMINALS, type LanTerminalSession } from "@/hooks/useLanTerminals";
import type { LanHost, TopologyTunnel } from "@/types/lan";

type Tab = "terminal" | "commands" | "details" | "edit";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="grid grid-cols-[7rem_1fr] gap-3 py-1.5 text-sm">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words text-foreground">{children}</dd>
        </div>
    );
}

export interface OpenTerminalRequest {
    tunnel: TopologyTunnel;
    host: LanHost;
    login: string;
    deviceUser: string;
}

interface Props {
    host: LanHost;
    tunnel: TopologyTunnel;
    online: boolean;
    sessions: LanTerminalSession[];
    onClose: () => void;
    onOpenTerminal: (req: OpenTerminalRequest) => boolean;
    onShowSession: (key: number) => void;
    loadConnectTarget: (tn: TopologyTunnel, deviceUser: string | null) => Promise<ConnectTarget>;
    updateHost: (h: LanHost, input: HostInput) => Promise<FormErrors | null>;
    deleteHost: (h: LanHost) => Promise<boolean>;
}

export function HostPanel({ host, tunnel, online, sessions, onClose, onOpenTerminal, onShowSession, loadConnectTarget, updateHost, deleteHost }: Props) {
    const { t, locale } = useI18n();
    const [tab, setTab] = useState<Tab>("terminal");
    const [login, setLogin] = useState(host.username ?? "");
    const [deviceUser, setDeviceUser] = useState<string | null>(tunnel.default_username ?? tunnel.usernames[0] ?? null);
    // 載入結果帶著它是哪個帳號的，換帳號時舊的就不顯示。/ The loaded target remembers its account.
    const [loaded, setLoaded] = useState<{ user: string | null; target: ConnectTarget } | null>(null);
    const [form, setForm] = useState({ label: host.label ?? "", username: host.username ?? "", ssh_port: String(host.ssh_port) });
    const [errors, setErrors] = useState<FormErrors>({});
    const [saving, setSaving] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [limitHit, setLimitHit] = useState(false);

    useEffect(() => {
        let cancelled = false;
        loadConnectTarget(tunnel, deviceUser).then((x) => {
            if (!cancelled) setLoaded({ user: deviceUser, target: x });
        });
        return () => { cancelled = true; };
    }, [tunnel, deviceUser, loadConnectTarget]);
    const target = loaded && loaded.user === deviceUser ? loaded.target : null;

    const fmt = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }), [locale]);
    const name = hostName(host);
    const cleanLogin = login.trim();
    const loginOk = isValidLogin(cleanLogin);
    const noDeviceUser = tunnel.usernames.length === 0;
    const mine = sessions.filter((s) => s.hostId === host.id);

    const openTerminal = () => {
        if (!deviceUser) return;
        const ok = onOpenTerminal({ tunnel, host, login: cleanLogin, deviceUser });
        setLimitHit(!ok);
    };

    const save = async () => {
        const port = Number(form.ssh_port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            setErrors({ ssh_port: t("network.form.portInvalid") });
            return;
        }
        const username = form.username.trim();
        if (username && !isValidLogin(username)) {
            setErrors({ username: t("network.form.loginInvalid") });
            return;
        }
        setSaving(true);
        const res = await updateHost(host, { label: form.label.trim() || null, username: username || null, ssh_port: port });
        setSaving(false);
        if (res) setErrors(res);
        else {
            setErrors({});
            setLogin(username);
            setTab("terminal");
        }
    };

    const tabs = [
        { value: "terminal" as const, label: t("network.tab.terminal") },
        { value: "commands" as const, label: t("network.tab.commands") },
        { value: "details" as const, label: t("network.tab.details") },
        ...(tunnel.can_edit ? [{ value: "edit" as const, label: t("network.tab.edit") }] : []),
    ];

    const loginFields = (
        <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
                <Label htmlFor="lan-login">{t("network.loginAs")}</Label>
                <Input id="lan-login" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="admin" autoComplete="off" spellCheck={false} className="font-mono" />
                {!loginOk && <p className="text-xs text-muted-foreground">{t("network.loginHint")}</p>}
            </div>
            {tunnel.usernames.length > 1 && (
                <div className="space-y-1.5">
                    <Label>{t("network.jumpAccount")}</Label>
                    <Segmented options={tunnel.usernames.map((u) => ({ value: u, label: u }))} value={deviceUser ?? tunnel.usernames[0]} onChange={setDeviceUser} kind="toggle" />
                </div>
            )}
        </div>
    );

    return (
        <section aria-label={name} className="rounded-xl border border-border bg-card shadow-card">
            {/* 標題與分頁在面板內捲動時固定在上面。/ Title and tabs stay put while the panel scrolls. */}
            <div className="z-10 rounded-t-xl bg-card xl:sticky xl:top-0">
            <header className="flex items-start gap-3 border-b border-border p-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground" aria-hidden><Terminal size={17} /></span>
                <div className="min-w-0 flex-1">
                    <h2 className="text-lg leading-tight text-foreground [overflow-wrap:anywhere]">{name}</h2>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                        {t("network.hostOn", { address: host.ssh_port === 22 ? host.address : `${host.address}:${host.ssh_port}`, device: tunnel.name })}
                    </p>
                </div>
                <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={onClose} aria-label={t("common.close")} title={t("common.close")}>
                    <X size={16} />
                </Button>
            </header>
            <div className="border-b border-border px-4 py-2">
                <Segmented options={tabs} value={tab} onChange={setTab} kind="tabs" fullWidth size="sm" aria-label={name} />
            </div>
            </div>

            <div className="p-4">
                {tab === "terminal" && (
                    <div className="space-y-4">
                        {/* 只有掃描過的主機才談得上「上次掃描沒看到」。/ Only scanned hosts have a "last scan". */}
                        {host.last_seen && !hasSsh(host) && <Callout tone="warning">{t("network.noSshSeen", { port: host.ssh_port })}</Callout>}
                        {noDeviceUser && <Callout tone="warning">{t("network.noDeviceUser")}</Callout>}
                        {loginFields}
                        <div className="flex flex-wrap items-center gap-2">
                            <Button onClick={openTerminal} disabled={!online || !loginOk || noDeviceUser} title={!online ? t("network.deviceOffline") : undefined}>
                                <Terminal size={16} /> {t("network.openTerminal")}
                            </Button>
                            <Button variant={desktopPorts(host.open_ports).length > 0 ? "secondary" : "outline"} asChild>
                                <Link href={`/tunnels/desktop?tunnel=${tunnel.id}&lanHost=${host.id}`} prefetch={false}>
                                    <ScreenShare size={16} /> {t("network.openDesktop")}
                                </Link>
                            </Button>
                            {!online && <span className="text-sm text-muted-foreground">{t("network.deviceOffline")}</span>}
                        </div>
                        {limitHit && <Callout tone="warning">{t("network.terminalLimit", { count: MAX_LAN_TERMINALS })}</Callout>}
                        <p className="text-xs text-muted-foreground">{t("network.terminalHint")}</p>
                        {mine.length > 0 && (
                            <div className="space-y-1.5">
                                <p className="text-sm text-foreground">{t("network.openSessions")}</p>
                                <ul className="flex flex-wrap gap-1.5">
                                    {mine.map((s) => (
                                        <li key={s.key}>
                                            <button
                                                type="button"
                                                onClick={() => onShowSession(s.key)}
                                                className="flex items-center gap-1.5 rounded-sm border border-border bg-muted px-2 py-0.5 font-mono text-[0.75rem] text-foreground/80 hover:border-foreground/30"
                                            >
                                                <span className={cn("size-1.5 rounded-full", s.status === "connected" ? "bg-success" : s.status === "connecting" ? "bg-warning" : "bg-muted-foreground/45")} aria-hidden />
                                                {sessionLabel(s)}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                )}

                {tab === "commands" && (
                    <div className="space-y-5">
                        {noDeviceUser && <Callout tone="warning">{t("network.noDeviceUser")}</Callout>}
                        {loginFields}
                        <LanCommands host={host} target={target} login={loginOk ? cleanLogin : ""} />
                    </div>
                )}

                {tab === "details" && (
                    <dl className="divide-y divide-border">
                        <Row label={t("network.field.address")}><span className="font-mono">{host.address}</span></Row>
                        {host.hostname && <Row label={t("network.field.hostname")}><span className="font-mono">{host.hostname}</span></Row>}
                        {host.mac && (
                            <Row label={t("network.field.mac")}>
                                <span className="font-mono">{host.mac}</span>
                                {host.mac_private && <span className="ml-2 text-xs text-muted-foreground">{t("network.macPrivate")}</span>}
                            </Row>
                        )}
                        {host.vendor && <Row label={t("network.field.vendor")}>{host.vendor}</Row>}
                        <Row label={t("network.field.openPorts")}>
                            {host.open_ports.length ? (
                                <span className="flex flex-wrap gap-1">
                                    {host.open_ports.map((p) => <Badge key={p} variant="outline" className="font-mono text-[0.75rem]">{p}</Badge>)}
                                </span>
                            ) : t("network.noOpenPorts")}
                        </Row>
                        {host.ssh_banner && <Row label={t("network.field.banner")}><span className="font-mono text-xs">{host.ssh_banner}</span></Row>}
                        <Row label={t("network.field.source")}>{host.source === "scan" ? t("network.source.scan") : t("network.source.manual")}</Row>
                        {host.last_seen && <Row label={t("network.field.lastSeen")}>{fmt.format(new Date(host.last_seen))}</Row>}
                        {host.first_seen && <Row label={t("network.field.firstSeen")}>{fmt.format(new Date(host.first_seen))}</Row>}
                    </dl>
                )}

                {tab === "edit" && tunnel.can_edit && (
                    <div className="space-y-4">
                        <div className="space-y-1.5">
                            <Label htmlFor="lan-label">{t("network.field.label")}</Label>
                            <Input id="lan-label" value={form.label} maxLength={100} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={host.hostname ?? host.address} />
                            {errors.label && <p className="text-xs text-destructive">{errors.label}</p>}
                        </div>
                        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
                            <div className="space-y-1.5">
                                <Label htmlFor="lan-user">{t("network.field.username")}</Label>
                                <Input id="lan-user" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="admin" autoComplete="off" spellCheck={false} className="font-mono" />
                                {errors.username && <p className="text-xs text-destructive">{errors.username}</p>}
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="lan-port">{t("network.field.sshPort")}</Label>
                                <Input id="lan-port" inputMode="numeric" value={form.ssh_port} onChange={(e) => setForm({ ...form, ssh_port: e.target.value })} placeholder="22" className="font-mono" />
                                {errors.ssh_port && <p className="text-xs text-destructive">{errors.ssh_port}</p>}
                            </div>
                        </div>
                        {errors._ && <p className="text-sm text-destructive">{errors._}</p>}
                        <div className="flex flex-wrap justify-between gap-2">
                            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                                <Trash2 size={16} /> {t("network.deleteHost")}
                            </Button>
                            <Button onClick={save} disabled={saving}>
                                {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} {t("common.save")}
                            </Button>
                        </div>
                        {host.source === "scan" && <p className="text-xs text-muted-foreground">{t("network.deleteScannedHint")}</p>}
                    </div>
                )}
            </div>

            <ConfirmDialog
                isOpen={confirmDelete}
                onClose={() => setConfirmDelete(false)}
                onConfirm={async () => {
                    setConfirmDelete(false);
                    if (await deleteHost(host)) onClose();
                }}
                title={t("network.deleteHost")}
                message={t("network.deleteConfirm", { name })}
                confirmText={t("network.deleteHost")}
                isDestructive
            />
        </section>
    );
}
